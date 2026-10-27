import { claudeTierOf } from "../../protocol/model-ref.js";
import type { OllamaFallbackConfig } from "../../config/manager.js";
import type { TierModels } from "../tier-matching.js";
import type { OllamaDailyBudgetConfig, OllamaBudgetVerdict } from "./daily-budget.js";

/**
 * When an Anthropic request may be answered by Ollama instead.
 *
 * Ollama is the last resort, behind both the pool and the Codex fallback: it
 * answers with a different model, so it is only worth it when the alternative
 * is a long wait. A short wait is better spent letting Claude Code sit out the
 * router's own 429 + Retry-After (CLAUDE_CODE_RETRY_WATCHDOG), which keeps the
 * conversation on the model it started with.
 *
 * Everything here is pure: the route supplies the pool readings, so every
 * branch can be tested without a server.
 */

export const OLLAMA_DEFAULT_BASE_URL = "https://ollama.com";
export const OLLAMA_DEFAULT_API_KEY_ENV = "OLLAMA_API_KEY";
export const OLLAMA_DEFAULT_MIN_WAIT_SECONDS = 900;
// Compared against estimatePromptTokens, which counts bytes / 2 and so reads
// roughly twice the real token count for a Claude Code request (measured:
// ~388K estimated for 198,654 real input tokens). 1M therefore admits real
// conversations up to about half that; lower it for small-context models.
export const OLLAMA_DEFAULT_CONTEXT_TOKENS = 1_048_576;

/** OllamaFallbackConfig with every default applied. */
export interface ResolvedOllamaFallbackConfig {
  baseUrl: string;
  apiKeyEnv: string;
  minWaitSeconds: number;
  /** Empty when unset; the decision then answers "no-model". */
  model: string;
  tierMap: { opus?: string; sonnet?: string; haiku?: string };
  contextTokens: number;
  /** The endpoint refuses requests without a key (Ollama Cloud). */
  keyRequired: boolean;
  /** Fill unset tiers from the live catalog (providers/tier-matching.ts). */
  autoTierMap: boolean;
  /** Daily USD budget gate (daily-budget.ts). */
  dailyBudget?: OllamaDailyBudgetConfig;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function cleanNumber(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * Ollama Cloud rejects unauthenticated requests; a local daemon (which proxies
 * `:cloud` models itself) needs no key. Decided by host so a self-hosted
 * daemon on any address keeps working without one.
 */
export function ollamaKeyRequired(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "ollama.com" || host.endsWith(".ollama.com");
  } catch {
    return false;
  }
}

/**
 * Null unless the operator opted in. config.json is hand-editable, so every
 * field is coerced rather than trusted.
 */
export function resolveOllamaFallbackConfig(
  raw: OllamaFallbackConfig | undefined,
): ResolvedOllamaFallbackConfig | null {
  if (!raw || raw.enabled !== true) return null;
  const baseUrl = (cleanString(raw.baseUrl) ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const tierMap = typeof raw.tierMap === "object" && raw.tierMap !== null ? raw.tierMap : {};
  return {
    baseUrl,
    apiKeyEnv: cleanString(raw.apiKeyEnv) ?? OLLAMA_DEFAULT_API_KEY_ENV,
    minWaitSeconds: cleanNumber(raw.minWaitSeconds, OLLAMA_DEFAULT_MIN_WAIT_SECONDS, 0),
    model: cleanString(raw.model) ?? "",
    tierMap: {
      opus: cleanString(tierMap.opus),
      sonnet: cleanString(tierMap.sonnet),
      haiku: cleanString(tierMap.haiku),
    },
    contextTokens: cleanNumber(raw.contextTokens, OLLAMA_DEFAULT_CONTEXT_TOKENS, 1),
    keyRequired: ollamaKeyRequired(baseUrl),
    autoTierMap: raw.autoTierMap === true,
    dailyBudget: raw.dailyBudget,
  };
}

/** The key as the environment holds it right now; never cached or stored. */
export function readOllamaApiKey(
  config: Pick<ResolvedOllamaFallbackConfig, "apiKeyEnv">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return cleanString(env[config.apiKeyEnv]);
}

/**
 * Whether the fallback could answer right now if the pool were blocked, and
 * if not, why. Configuration-level only: the per-request reasons (pool wait,
 * size) live in the decision below.
 */
export function ollamaReadiness(
  config: Pick<ResolvedOllamaFallbackConfig, "model" | "keyRequired" | "apiKeyEnv">,
  env: NodeJS.ProcessEnv = process.env,
): { ready: boolean; inactiveReason: "no-model" | "no-api-key" | null } {
  if (!config.model) return { ready: false, inactiveReason: "no-model" };
  if (config.keyRequired && !readOllamaApiKey(config, env)) return { ready: false, inactiveReason: "no-api-key" };
  return { ready: true, inactiveReason: null };
}

/**
 * The Ollama model that answers in place of `claudeModel` (already
 * alias-resolved). Keeps the request's tier when `tierMap` names one, so an
 * opus request is not answered by the model chosen for haiku. `matched` comes
 * from the live catalog and only fills tiers `tierMap` leaves unset.
 */
export function ollamaModelFor(
  claudeModel: string | undefined,
  config: Pick<ResolvedOllamaFallbackConfig, "model" | "tierMap">,
  matched: TierModels = {},
): string {
  const classified = claudeTierOf(claudeModel);
  // Frontier is a Codex distinction; preserve Ollama's existing top-tier policy.
  const tier = classified === "frontier" ? "opus" : classified;
  return (tier ? config.tierMap[tier] ?? matched[tier] : undefined) ?? config.model;
}

export type OllamaSkipReason =
  | "disabled"
  | "budget-exhausted"
  | "reserve-exhausted"
  | "balance-unknown"
  | "no-model"
  | "anthropic-available"
  | "anthropic-will-serve"
  | "pool-empty"
  | "reset-near"
  | "too-large"
  | "no-api-key";

export type OllamaDecision =
  | { use: true; model: string; waitSeconds: number }
  | { use: false; reason: OllamaSkipReason; detail?: string };

export interface OllamaDecisionInput {
  config: ResolvedOllamaFallbackConfig | null;
  /** Alias-resolved Claude model the request asked for. */
  claudeModel: string | undefined;
  /** TokenPool.hasAvailableAccount — read first and cheaply. */
  anthropicAvailable: () => boolean;
  /** TokenPool.secondsUntilAvailable — read only once the pool is known blocked. */
  poolWaitSeconds: () => number;
  estimatedPromptTokens: number | null;
  apiKey: () => string | undefined;
  /** Catalog-matched tiers; read only once Ollama is chosen. */
  matchedTiers?: () => TierModels;
  /** Daily-budget verdict; null verdicts (feature off) skip the check. */
  budget?: () => OllamaBudgetVerdict | null;
}

export function decideOllamaFallback(input: OllamaDecisionInput): OllamaDecision {
  const { config } = input;
  if (!config) return { use: false, reason: "disabled" };
  if (!config.model) return { use: false, reason: "no-model" };
  if (input.anthropicAvailable()) return { use: false, reason: "anthropic-available" };

  const wait = input.poolWaitSeconds();
  // getNext() still hands out a busy or over-cap account, so Anthropic answers
  // this request in degraded form; Ollama must not pre-empt that.
  if (wait <= 0) return { use: false, reason: "anthropic-will-serve" };
  // Nothing is blocked, there is simply nothing to route to (no account, or
  // every one disabled). That is a configuration state answered with a 503, not
  // a wait Ollama could bridge.
  if (!Number.isFinite(wait)) return { use: false, reason: "pool-empty" };
  if (wait <= config.minWaitSeconds) {
    return { use: false, reason: "reset-near", detail: `reset in ${wait}s <= ${config.minWaitSeconds}s` };
  }

  // Unknown size passes, as with codexCanHold: the guard stops a KNOWN
  // oversized conversation, it must not disable the fallback on a path that
  // could not measure one.
  const est = input.estimatedPromptTokens;
  if (est !== null && est > config.contextTokens) {
    return { use: false, reason: "too-large", detail: `~${est} tokens > ${config.contextTokens}` };
  }

  if (config.keyRequired && !input.apiKey()) return { use: false, reason: "no-api-key" };

  const b = input.budget?.();
  if (b && !b.allow) {
    const detail = b.budgetUsd === null ? undefined
      : `$${b.spentUsd.toFixed(2)} of $${b.budgetUsd.toFixed(2)} spent${b.remainingUsd === null ? "" : `, $${b.remainingUsd.toFixed(2)} left`} (day ${b.day})`;
    return { use: false, reason: b.reason as "budget-exhausted" | "reserve-exhausted" | "balance-unknown", detail };
  }

  return { use: true, model: ollamaModelFor(input.claudeModel, config, input.matchedTiers?.()), waitSeconds: wait };
}
