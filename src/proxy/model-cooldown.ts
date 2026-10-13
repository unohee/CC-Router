import type { Account } from "./types.js";

export function modelLimitKey(model?: string): string {
  const name = (model ?? "").toLowerCase().replace(/^anthropic\//, "").replace(/\[.*\]$/, "");
  return name.match(/^claude-(fable|opus|sonnet|haiku)(?:-|$)/)?.[1] ?? name;
}

/** Only verified model-scoped claims may avoid the account-wide cooldown. */
export function isModelScopedClaim(claim: string, model?: string): boolean {
  const family = modelLimitKey(model);
  return (claim === "seven_day_overage_included" && family === "fable")
    || (claim === "seven_day_opus" && family === "opus")
    || (claim === "seven_day_sonnet" && family === "sonnet");
}

export function cooldownDeadline(account: Account, model?: string): number {
  return Math.max(account.coolingUntil ?? 0, account.modelCooldowns?.[modelLimitKey(model)] ?? 0);
}

export function recordRateLimitCooldown(
  account: Account, model: string | undefined, claim: string, seconds: number,
): boolean {
  const until = Date.now() + seconds * 1000;
  const scoped = isModelScopedClaim(claim, model);
  if (scoped) {
    const key = modelLimitKey(model);
    account.modelCooldowns ??= {};
    account.modelCooldowns[key] = Math.max(account.modelCooldowns[key] ?? 0, until);
    // Scoped rejection must not poison the account-wide status snapshot.
    account.rateLimits.status = "allowed";
  } else {
    account.coolingUntil = Math.max(account.coolingUntil ?? 0, until);
  }
  return scoped;
}
