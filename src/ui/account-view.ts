/** Shape the dashboard needs to label an account; a subset of the health view. */
export interface AccountTagInput {
  provider?: "anthropic_subscription" | "openai_subscription";
  rateLimits?: { plan: string };
}

/**
 * Fixed column width for the provider tag. The dashboard lays rows out by
 * padding, so a tag wider than this would shift every column after it.
 */
export const PROVIDER_TAG_WIDTH = 14;

/**
 * The bracketed label after an account's status.
 *
 * Anthropic accounts show their plan alone ("[Max 20x]") because the provider
 * is the unmarked default. OpenAI accounts name the provider, and append the
 * plan when Codex reported one — the plan arrives in response headers, so it is
 * absent until that account has served a request.
 */
export function accountProviderTag(account: AccountTagInput): string {
  const plan = account.rateLimits?.plan?.trim();
  if (account.provider === "openai_subscription") {
    return plan ? ` [OpenAI ${plan}]` : " [OpenAI]";
  }
  return plan ? ` [${plan}]` : "";
}

/** The tag padded to its column, truncated rather than allowed to overflow. */
export function paddedProviderTag(account: AccountTagInput): string {
  return accountProviderTag(account).slice(0, PROVIDER_TAG_WIDTH).padEnd(PROVIDER_TAG_WIDTH);
}

/** Format a future epoch-ms deadline as a short remaining duration. */
export function formatDurationUntil(untilMs: number, now = Date.now()): string {
  const diff = (untilMs - now) / 1000;
  if (diff <= 0) return "now";
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

/**
 * One-line summary of active routing cooldowns for the status dashboard.
 * Account-wide `coolingUntil` and per-family `modelCooldowns` are the deadlines
 * the pool actually waits on; Anthropic util reset stamps are shown separately.
 */
export function accountCooldownSummary(
  account: { coolingUntil?: number; modelCooldowns?: Record<string, number> },
  now = Date.now(),
): string | null {
  const parts: string[] = [];
  if (account.coolingUntil && account.coolingUntil > now) {
    parts.push(`cool ↻${formatDurationUntil(account.coolingUntil, now)}`);
  }
  for (const [family, until] of Object.entries(account.modelCooldowns ?? {})) {
    if (until > now) parts.push(`${family} ↻${formatDurationUntil(until, now)}`);
  }
  return parts.length > 0 ? parts.join("  ") : null;
}
