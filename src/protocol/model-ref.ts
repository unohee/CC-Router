export type ProviderKind = "anthropic_subscription" | "openai_subscription" | "openai_api_key";

export interface ParsedModelRef {
  provider: ProviderKind;
  publicModel: string;
  upstreamModel: string;
}

export interface ModelRoutingConfig {
  anthropicDefaultModel?: string;
  openAIDefaultModel?: string;
  anthropicAliases?: Record<string, string>;
  openAIAliases?: Record<string, string>;
  /** Per-tier override of the Claude -> OpenAI model mapping. */
  openAITierMap?: Partial<Record<ClaudeTier, string>>;
}

/** Capability tier of a Claude model, used to pick a comparable OpenAI model. */
export type ClaudeTier = "opus" | "sonnet" | "haiku";

/**
 * Suggested Claude tier -> Codex model, from the backend's own ordering
 * (`priority` 1/2/3) and descriptions, verified 2026-08-20:
 *   sol   — "Latest frontier agentic coding model"
 *   terra — "Balanced agentic coding model for everyday..."
 *   luna  — "Fast and affordable agentic coding model"
 *
 * This is a *suggestion the CLI writes into config*, not an implicit default.
 * Tier routing only applies once `openAITierMap` exists, so an operator who
 * configured `openAIDefaultModel` keeps getting exactly that model until they
 * opt in — otherwise this table would silently override their choice.
 */
export const SUGGESTED_TIER_MODELS: Record<ClaudeTier, string> = {
  opus: "gpt-5.6-sol",
  sonnet: "gpt-5.6-terra",
  haiku: "gpt-5.6-luna",
};

/**
 * Classify a Claude model name by capability tier.
 *
 * Matches on the family word rather than an exact id so new dated snapshots and
 * point releases keep working without a table edit. Fable and Mythos are
 * Anthropic's most capable lines, so they share the top tier with Opus.
 * Returns null for anything unrecognised — the caller then falls back to its
 * configured default rather than guessing a tier.
 */
export function claudeTierOf(model: string | undefined): ClaudeTier | null {
  const name = cleanModel(model)?.toLowerCase().replace(/^anthropic\//, "");
  if (!name) return null;
  if (name.includes("opus") || name.includes("fable") || name.includes("mythos")) return "opus";
  if (name.includes("sonnet")) return "sonnet";
  if (name.includes("haiku")) return "haiku";
  return null;
}

/**
 * The OpenAI model that should answer in place of `model`.
 *
 * Preserves the request's tier when `openAITierMap` configures one; otherwise —
 * no map, unmapped tier, or an unrecognised Claude name — returns
 * `openAIDefaultModel`, so behaviour is unchanged for anyone who has not opted
 * into tier routing.
 */
export function openAIModelForClaudeModel(
  model: string | undefined,
  config: ModelRoutingConfig = {},
): string | undefined {
  // Resolve aliases first. A configured alias need not contain the family word
  // ("fast" -> claude-haiku-4-5), so classifying the name as written would lose
  // the tier and silently drop the request onto the default model.
  const parsed = parseModelRef(model, config);
  const tier = parsed.provider === "anthropic_subscription"
    ? claudeTierOf(parsed.upstreamModel)
    : null;
  if (tier) {
    const mapped = cleanModel(config.openAITierMap?.[tier]);
    if (mapped) return mapped;
  }
  return cleanModel(config.openAIDefaultModel);
}

const CLAUDE_ALIASES: Record<string, string> = {
  "claude/sonnet": "claude-sonnet-4-5",
  "claude/opus": "claude-opus-4-1",
};

function cleanModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseModelRef(model: string | undefined, config: ModelRoutingConfig = {}): ParsedModelRef {
  const publicModel = cleanModel(model) ?? cleanModel(config.anthropicDefaultModel) ?? "claude/sonnet";

  if (publicModel.startsWith("openai/")) {
    const openAIModel = publicModel.slice("openai/".length);
    const defaultOpenAIModel = cleanModel(config.openAIDefaultModel);
    return {
      provider: "openai_subscription",
      publicModel,
      upstreamModel: config.openAIAliases?.[openAIModel]
        ?? (openAIModel === "default" && defaultOpenAIModel ? defaultOpenAIModel : openAIModel),
    };
  }

  if (publicModel.startsWith("anthropic/")) {
    const anthropicModel = publicModel.slice("anthropic/".length);
    return {
      provider: "anthropic_subscription",
      publicModel,
      upstreamModel: config.anthropicAliases?.[publicModel]
        ?? config.anthropicAliases?.[anthropicModel]
        ?? anthropicModel,
    };
  }

  return {
    provider: "anthropic_subscription",
    publicModel,
    upstreamModel: config.anthropicAliases?.[publicModel] ?? CLAUDE_ALIASES[publicModel] ?? publicModel,
  };
}
