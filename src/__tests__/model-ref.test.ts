import { describe, expect, it } from "vitest";
import { claudeTierOf, openAIModelForClaudeModel, parseModelRef, SUGGESTED_TIER_MODELS } from "../protocol/model-ref.js";

describe("parseModelRef", () => {
  it("routes openai-prefixed models to OpenAI subscription transport", () => {
    expect(parseModelRef("openai/gpt-5.5")).toEqual({
      provider: "openai_subscription",
      publicModel: "openai/gpt-5.5",
      upstreamModel: "gpt-5.5",
    });
  });

  it("routes claude-prefixed models to Anthropic subscription transport", () => {
    expect(parseModelRef("claude/sonnet")).toEqual({
      provider: "anthropic_subscription",
      publicModel: "claude/sonnet",
      upstreamModel: "claude-sonnet-4-5",
    });
  });

  it("keeps unprefixed models on the current Anthropic default path", () => {
    expect(parseModelRef("claude-3-5-sonnet-latest")).toEqual({
      provider: "anthropic_subscription",
      publicModel: "claude-3-5-sonnet-latest",
      upstreamModel: "claude-3-5-sonnet-latest",
    });
  });

  it("uses a configured Anthropic default when the client omits a model", () => {
    expect(parseModelRef(undefined, {
      anthropicDefaultModel: "claude-opus-4-1",
    })).toEqual({
      provider: "anthropic_subscription",
      publicModel: "claude-opus-4-1",
      upstreamModel: "claude-opus-4-1",
    });
  });

  it("lets deployments remap provider aliases to preferred upstream models", () => {
    expect(parseModelRef("claude/sonnet", {
      anthropicAliases: { "claude/sonnet": "claude-sonnet-4-6" },
    }).upstreamModel).toBe("claude-sonnet-4-6");

    expect(parseModelRef("openai/codex", {
      openAIAliases: { codex: "gpt-5-codex" },
    })).toEqual({
      provider: "openai_subscription",
      publicModel: "openai/codex",
      upstreamModel: "gpt-5-codex",
    });
  });

  it("resolves openai/default to the configured OpenAI default model", () => {
    expect(parseModelRef("openai/default", {
      openAIDefaultModel: "gpt-5-codex",
    })).toEqual({
      provider: "openai_subscription",
      publicModel: "openai/default",
      upstreamModel: "gpt-5-codex",
    });
  });
});

describe("claudeTierOf", () => {
  it("classifies each Claude family by capability tier", () => {
    expect(claudeTierOf("claude-opus-5")).toBe("opus");
    expect(claudeTierOf("claude-opus-4-8")).toBe("opus");
    expect(claudeTierOf("anthropic/claude-opus-4-6")).toBe("opus");
    // Fable and Mythos are Anthropic's most capable lines — top tier with Opus.
    expect(claudeTierOf("claude-fable-5")).toBe("opus");
    expect(claudeTierOf("claude-mythos-5")).toBe("opus");
    expect(claudeTierOf("claude-sonnet-5")).toBe("sonnet");
    expect(claudeTierOf("claude-sonnet-4-5-20250929")).toBe("sonnet");
    expect(claudeTierOf("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("returns null for names with no recognisable family", () => {
    expect(claudeTierOf("claude-instant-1")).toBeNull();
    expect(claudeTierOf("gpt-5.6-terra")).toBeNull();
    expect(claudeTierOf(undefined)).toBeNull();
    expect(claudeTierOf("   ")).toBeNull();
  });
});

describe("openAIModelForClaudeModel", () => {
  it("maps each tier through the configured tier map", () => {
    const config = { openAITierMap: SUGGESTED_TIER_MODELS };

    expect(openAIModelForClaudeModel("claude-opus-5", config)).toBe("gpt-5.6-sol");
    expect(openAIModelForClaudeModel("claude-sonnet-5", config)).toBe("gpt-5.6-terra");
    expect(openAIModelForClaudeModel("claude-haiku-4-5", config)).toBe("gpt-5.6-luna");
  });

  it("leaves the configured default untouched when tier routing is not enabled", () => {
    // No openAITierMap — an operator who set only openAIDefaultModel must keep
    // getting exactly that model, for every tier.
    const config = { openAIDefaultModel: "gpt-5-codex" };

    expect(openAIModelForClaudeModel("claude-opus-5", config)).toBe("gpt-5-codex");
    expect(openAIModelForClaudeModel("claude-haiku-4-5", config)).toBe("gpt-5-codex");
  });

  it("falls back to the default for tiers the map does not cover", () => {
    const config = { openAITierMap: { sonnet: "gpt-5.5" }, openAIDefaultModel: "gpt-5-codex" };

    expect(openAIModelForClaudeModel("claude-sonnet-5", config)).toBe("gpt-5.5");
    expect(openAIModelForClaudeModel("claude-opus-5", config)).toBe("gpt-5-codex");
  });

  it("falls back to the configured default when no tier can be inferred", () => {
    expect(openAIModelForClaudeModel("claude-instant-1", { openAIDefaultModel: "gpt-5.4" }))
      .toBe("gpt-5.4");
    expect(openAIModelForClaudeModel("claude-instant-1", {})).toBeUndefined();
  });

  it("resolves a configured alias before classifying its tier", () => {
    // The alias name carries no family word — only its target does.
    const config = {
      anthropicAliases: { fast: "claude-haiku-4-5" },
      openAITierMap: SUGGESTED_TIER_MODELS,
      openAIDefaultModel: "gpt-5.4",
    };

    expect(openAIModelForClaudeModel("fast", config)).toBe("gpt-5.6-luna");
  });

  it("does not classify an explicit openai/* model as a Claude tier", () => {
    expect(openAIModelForClaudeModel("openai/gpt-5.5", { openAIDefaultModel: "gpt-5.4" }))
      .toBe("gpt-5.4");
  });
});
