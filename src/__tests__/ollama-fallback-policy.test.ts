import { describe, expect, it } from "vitest";
import {
  decideOllamaFallback, resolveOllamaFallbackConfig, resolveOllamaSpillConfig, ollamaEffortFor, ollamaKeyRequired, ollamaModelFor, readOllamaApiKey,
  type OllamaDecisionInput,
} from "../providers/ollama/fallback-policy.js";

const LOCAL = resolveOllamaFallbackConfig({
  enabled: true, baseUrl: "http://127.0.0.1:11434/", model: "glm:cloud", minWaitSeconds: 900, contextTokens: 1000,
  tierMap: { opus: "big:cloud", haiku: " " },
})!;

function input(over: Partial<OllamaDecisionInput> = {}): OllamaDecisionInput {
  return {
    config: LOCAL,
    claudeModel: "claude-sonnet-4-6",
    anthropicAvailable: () => false,
    poolWaitSeconds: () => 7200,
    estimatedPromptTokens: 100,
    apiKey: () => undefined,
    ...over,
  };
}

describe("resolveOllamaFallbackConfig", () => {
  it("is inert unless enabled is exactly true", () => {
    expect(resolveOllamaFallbackConfig(undefined)).toBeNull();
    expect(resolveOllamaFallbackConfig({ enabled: false, model: "m" })).toBeNull();
    expect(resolveOllamaFallbackConfig({ enabled: "yes" as unknown as boolean, model: "m" })).toBeNull();
  });

  it("applies the defaults and coerces hand-edited values", () => {
    const c = resolveOllamaFallbackConfig({ enabled: true, model: " m ", minWaitSeconds: -5, contextTokens: "x" as unknown as number })!;
    expect(c).toEqual({
      baseUrl: "https://ollama.com", apiKeyEnv: "OLLAMA_API_KEY", minWaitSeconds: 900, model: "m",
      tierMap: { opus: undefined, sonnet: undefined, haiku: undefined },
      tierEffort: { opus: undefined, sonnet: undefined, haiku: undefined },
      contextTokens: 1_048_576, keyRequired: true,
      autoTierMap: false,
      spill: null,
    });
    expect(LOCAL.baseUrl).toBe("http://127.0.0.1:11434");
    expect(LOCAL.keyRequired).toBe(false);
  });

  it("requires a key only for Ollama Cloud", () => {
    expect(ollamaKeyRequired("https://ollama.com")).toBe(true);
    expect(ollamaKeyRequired("https://api.ollama.com/x")).toBe(true);
    expect(ollamaKeyRequired("http://localhost:11434")).toBe(false);
    expect(ollamaKeyRequired("https://notollama.com")).toBe(false);
    expect(ollamaKeyRequired("not a url")).toBe(false);
  });

  it("reads the key from the named variable at call time", () => {
    expect(readOllamaApiKey({ apiKeyEnv: "K" }, { K: " secret " })).toBe("secret");
    expect(readOllamaApiKey({ apiKeyEnv: "K" }, { K: "" })).toBeUndefined();
  });
});

describe("ollamaModelFor", () => {
  it("keeps the request's tier when mapped, else the default model", () => {
    expect(ollamaModelFor("claude-opus-4-1", LOCAL)).toBe("big:cloud");
    expect(ollamaModelFor("claude-fable-5", LOCAL)).toBe("big:cloud");
    expect(ollamaModelFor("claude-haiku-4-5", LOCAL)).toBe("glm:cloud"); // blank entry is unmapped
    expect(ollamaModelFor("claude-sonnet-4-6", LOCAL)).toBe("glm:cloud");
    expect(ollamaModelFor("something-else", LOCAL)).toBe("glm:cloud");
  });
});

describe("decideOllamaFallback", () => {
  it("falls back when the pool is blocked far into the future", () => {
    expect(decideOllamaFallback(input())).toEqual({ use: true, model: "glm:cloud", waitSeconds: 7200 });
  });

  it("does no pool work while disabled", () => {
    let read = false;
    const d = decideOllamaFallback(input({ config: null, anthropicAvailable: () => { read = true; return false; } }));
    expect(d).toEqual({ use: false, reason: "disabled" });
    expect(read).toBe(false);
  });

  it("names every reason it declines", () => {
    const reason = (over: Partial<OllamaDecisionInput>) => {
      const d = decideOllamaFallback(input(over));
      return d.use ? "use" : d.reason;
    };
    expect(reason({ config: { ...LOCAL, model: "" } })).toBe("no-model");
    expect(reason({ anthropicAvailable: () => true })).toBe("anthropic-available");
    expect(reason({ poolWaitSeconds: () => 0 })).toBe("anthropic-will-serve");
    expect(reason({ poolWaitSeconds: () => Infinity })).toBe("pool-empty");
    expect(reason({ poolWaitSeconds: () => 900 })).toBe("reset-near");
    expect(reason({ poolWaitSeconds: () => 901 })).toBe("use");
    expect(reason({ estimatedPromptTokens: 1001 })).toBe("too-large");
    expect(reason({ estimatedPromptTokens: 1000 })).toBe("use");
    expect(reason({ estimatedPromptTokens: null })).toBe("use");
    expect(reason({ config: { ...LOCAL, keyRequired: true } })).toBe("no-api-key");
    expect(reason({ config: { ...LOCAL, keyRequired: true }, apiKey: () => "k" })).toBe("use");
  });

  it("does not read the pool wait while Anthropic can serve", () => {
    let read = false;
    decideOllamaFallback(input({ anthropicAvailable: () => true, poolWaitSeconds: () => { read = true; return 0; } }));
    expect(read).toBe(false);
  });
});

describe("tier effort", () => {
  // The live setup: one model for every tier, only the effort differs.
  const ONE_MODEL = resolveOllamaFallbackConfig({
    enabled: true, baseUrl: "https://ollama.com", model: "deepseek-v4.1-flash:cloud", minWaitSeconds: 0,
    tierEffort: { opus: "high", sonnet: "medium", haiku: "off" },
  })!;

  it("keeps only the recognised levels from a hand-edited config", () => {
    const c = resolveOllamaFallbackConfig({
      enabled: true, model: "m",
      tierEffort: { opus: " high " as never, sonnet: "max" as never, haiku: 3 as never },
    })!;
    expect(c.tierEffort).toEqual({ opus: "high", sonnet: undefined, haiku: undefined });
  });

  it("picks the effort by the request's tier, frontier counting as opus", () => {
    expect(ollamaEffortFor("claude-opus-5-5", ONE_MODEL)).toBe("high");
    expect(ollamaEffortFor("claude-sonnet-5-5", ONE_MODEL)).toBe("medium");
    expect(ollamaEffortFor("claude-haiku-5-5", ONE_MODEL)).toBe("off");
    expect(ollamaEffortFor("claude-fable-5-1", ONE_MODEL)).toBe(ollamaEffortFor("claude-opus-5-5", ONE_MODEL));
    expect(ollamaEffortFor("mystery", ONE_MODEL)).toBeUndefined();
  });

  it("answers every tier with the same model and that tier's effort", () => {
    const pick = (claudeModel: string) => decideOllamaFallback(input({ config: ONE_MODEL, claudeModel, apiKey: () => "k" }));
    expect(pick("claude-opus-5-5")).toMatchObject({ use: true, model: "deepseek-v4.1-flash:cloud", effort: "high" });
    expect(pick("claude-sonnet-5-5")).toMatchObject({ use: true, model: "deepseek-v4.1-flash:cloud", effort: "medium" });
    expect(pick("claude-haiku-5-5")).toMatchObject({ use: true, model: "deepseek-v4.1-flash:cloud", effort: "off" });
  });

  it("adds no effort when none is configured", () => {
    const d = decideOllamaFallback(input());
    expect(d.use && "effort" in d).toBe(false);
  });
});

describe("spill: answering from Ollama before the pool is empty", () => {
  const SPILL = resolveOllamaFallbackConfig({
    enabled: true, baseUrl: "http://127.0.0.1:11434/", model: "glm:cloud", minWaitSeconds: 900, contextTokens: 1000,
    spill: { enabled: true, poolUtil: 0.9 },
  })!;
  const spillInput = (over: Partial<OllamaDecisionInput> = {}) =>
    input({ config: SPILL, anthropicAvailable: () => true, poolWaitSeconds: () => 0, poolTight: () => true, ...over });

  it("is off unless enabled, and bad fields fall back to the defaults", () => {
    expect(resolveOllamaSpillConfig(undefined)).toBeNull();
    expect(resolveOllamaSpillConfig({ enabled: false })).toBeNull();
    expect(resolveOllamaSpillConfig({ enabled: true, tiers: ["x"], poolUtil: 5 }))
      .toEqual({ tiers: ["haiku", "sonnet"], poolUtil: 0.9 });
    expect(resolveOllamaSpillConfig({ enabled: true, tiers: ["opus", "opus"], poolUtil: 0.8 }))
      .toEqual({ tiers: ["opus"], poolUtil: 0.8 });
  });

  it("spills a listed tier while Anthropic can serve and the pool is tight", () => {
    const d = decideOllamaFallback(spillInput({ claudeModel: "claude-haiku-4-5" }));
    expect(d).toMatchObject({ use: true, spill: true, waitSeconds: 0 });
    expect(decideOllamaFallback(spillInput({ claudeModel: "claude-sonnet-4-6" }))).toMatchObject({ use: true, spill: true });
  });

  it("never spills opus unless listed, nor when the pool has room, nor without the config", () => {
    expect(decideOllamaFallback(spillInput({ claudeModel: "claude-opus-4-1" }))).toEqual({ use: false, reason: "anthropic-available" });
    expect(decideOllamaFallback(spillInput({ poolTight: () => false }))).toEqual({ use: false, reason: "anthropic-available" });
    expect(decideOllamaFallback(spillInput({ config: LOCAL }))).toEqual({ use: false, reason: "anthropic-available" });
  });

  it("still obeys size, key and budget guards", () => {
    expect(decideOllamaFallback(spillInput({ estimatedPromptTokens: 5000 }))).toMatchObject({ use: false, reason: "too-large" });
    const cloud = { ...SPILL, keyRequired: true };
    expect(decideOllamaFallback(spillInput({ config: cloud }))).toEqual({ use: false, reason: "no-api-key" });
    expect(decideOllamaFallback(spillInput({
      budget: () => ({ allow: false, reason: "budget-exhausted", budgetUsd: 1, spentUsd: 1, remainingUsd: 0, day: "d" }),
    }))).toMatchObject({ use: false, reason: "budget-exhausted" });
  });

  it("leaves the blocked-pool path as it was", () => {
    expect(decideOllamaFallback(spillInput({ anthropicAvailable: () => false, poolWaitSeconds: () => 7200 })))
      .toMatchObject({ use: true });
    expect(decideOllamaFallback(spillInput({ anthropicAvailable: () => false, poolWaitSeconds: () => 7200 })))
      .not.toHaveProperty("spill");
  });
});
