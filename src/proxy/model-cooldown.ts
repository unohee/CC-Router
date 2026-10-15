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

/** First step of the bare-429 schedule. */
export const BARE_429_BASE_SECONDS = 8;
/** Ceiling of the schedule — the flat value every 429 used to get. */
export const BARE_429_MAX_SECONDS = 60;
/** A streak only continues if the previous bare 429 was this recent. Without
 *  it a stale count would make a lone 429 an hour later start at the ceiling. */
export const BARE_429_STREAK_WINDOW_MS = 120_000;
/** What an unexplained 429 got before the schedule existed. */
export const DEFAULT_429_COOLDOWN_SECONDS = 60;

/**
 * The seconds a 429's Retry-After header states, or null when it states none.
 *
 * Absent, unparseable and non-positive values all mean "upstream did not say
 * how long", which is not the same as saying 60 — callers decide the fallback.
 * Accepts delta-seconds and an HTTP date, as the header allows.
 */
export function parseRetryAfterSeconds(raw: string | undefined, now = Date.now()): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const numeric = Number(raw);
  const seconds = Number.isFinite(numeric) ? numeric : (Date.parse(raw) - now) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/**
 * A 429 that gives no reason to believe the account is out of quota.
 *
 * All four must hold: no usable Retry-After, no limiting window named, the
 * unified status is not `rate_limited`, and the claim is not model-scoped.
 * Anything upstream actually explained keeps its stated deadline or the
 * flat default — only the genuinely unexplained refusal gets the gentler
 * schedule, because treating it as a real limit is what let one rejected
 * request rotate through every account and leave each cooling for a minute.
 */
export function isBare429(
  retryAfterSeconds: number | null,
  rl: { status: string; claim: string } | null,
  model: string | undefined,
): boolean {
  if (retryAfterSeconds !== null) return false;
  const claim = rl?.claim ?? "";
  if (claim === "five_hour" || claim === "seven_day") return false;
  if (rl?.status === "rate_limited") return false;
  return !isModelScopedClaim(claim, model);
}

/**
 * Seconds to cool an account after a bare 429: 8, 16, 32, then 60.
 *
 * "Consecutive" means refused again after the account was let back in. A
 * second bare 429 that lands while the account is already cooling is a
 * sibling — another in-flight request meeting the same refusal — and must
 * not climb the schedule, or three parallel sessions would reproduce the
 * flat 60s in one burst. The streak resets only on a real success
 * (`resetBare429Streak`), not on cooldown expiry.
 */
export function bare429CooldownSeconds(account: Account, now = Date.now()): number {
  const cooling = (account.coolingUntil ?? 0) > now;
  const fresh = now - (account.lastBare429At ?? 0) <= BARE_429_STREAK_WINDOW_MS;
  let streak = fresh ? (account.bare429Streak ?? 0) : 0;
  if (!cooling || streak === 0) streak += 1;
  account.bare429Streak = streak;
  account.lastBare429At = now;
  return Math.min(BARE_429_MAX_SECONDS, BARE_429_BASE_SECONDS * 2 ** (streak - 1));
}

/** The account served a request: whatever was throttling it is not any more. */
export function resetBare429Streak(account: Account): void {
  account.bare429Streak = 0;
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
