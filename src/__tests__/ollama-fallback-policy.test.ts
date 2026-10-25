import { describe, expect, it } from "vitest";
import {
  decideOllamaFallback, resolveOllamaFallbackConfig, ollamaKeyRequired, ollamaModelFor, readOllamaApiKey,
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
      tierMap: { opus: undefined, sonnet: undefined, haiku: undefined }, contextTokens: 1_048_576, keyRequired: true,
      autoTierMap: false,
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
