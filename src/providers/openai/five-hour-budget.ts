import type { AccountRateLimits } from "../../proxy/types.js";

/**
 * The router's own cap on the Codex five-hour quota window, distinct from the
 * plan's real 100%.
 *
 * "5h limit" here is a routing decision, not upstream behaviour: when every
 * Codex account's 5-hour reading is at or above the cap, the router's Anthropic
 * pool — or Ollama — keeps carrying requests instead of the OpenAI accounts
 * burning through their window ahead of it.
 */
export interface CodexFiveHourBudgetConfig {
  /** Opt in. */
  enabled?: boolean;
  /** Five-hour-window utilization above which Codex stops serving, e.g. 80 for 80%. */
  fiveHourPercent?: number;
}

export interface ResolvedCodexFiveHourBudget {
  /** Fraction 0–1. */
  fiveHourUtil: number;
}

export function resolveCodexFiveHourBudget(raw: CodexFiveHourBudgetConfig | undefined): ResolvedCodexFiveHourBudget | null {
  if (!raw || raw.enabled !== true) return null;
  const pct = typeof raw.fiveHourPercent === "number" && Number.isFinite(raw.fiveHourPercent)
    ? raw.fiveHourPercent : 80;
  return { fiveHourUtil: Math.min(1, Math.max(0, pct / 100)) };
}

/** True when Codex may take another request: no reading, or the 5h window below the cap. */
export function fiveHourWithinBudget(limits: AccountRateLimits | undefined, budget: ResolvedCodexFiveHourBudget): boolean {
  if (!limits) return true;
  return limits.fiveHourUtil < budget.fiveHourUtil;
}
