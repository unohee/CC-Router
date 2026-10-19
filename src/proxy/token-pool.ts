import type { Account, AccountRecord } from "./types.js";
import type { PinBlock } from "./session-migration.js";
import { cooldownDeadline } from "./model-cooldown.js";
import { DEFAULT_RATE_LIMITS, ACCOUNT_USER_DEFAULTS, clampPercent } from "./types.js";

export class EmptyPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyPoolError";
  }
}

/** Thrown when every healthy, enabled account is rate-limited or cooling down. */
export class NoAvailableAccountError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`no account is currently available — retry in ${retryAfterSeconds}s`);
    this.name = "NoAvailableAccountError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Returns the earliest non-zero reset timestamp (seconds) for an account. */
function earliestReset(a: Account): number {
  const r = a.rateLimits;
  if (r.fiveHourReset && r.sevenDayReset) return Math.min(r.fiveHourReset, r.sevenDayReset);
  return r.fiveHourReset || r.sevenDayReset || Infinity;
}

/**
 * Returns the reset timestamp (seconds) that must pass before the account
 * stops being rate_limited. Prefers the `claim` window (the one Anthropic
 * said was actually limiting); falls back to the earliest non-zero reset.
 * Returns 0 when no reset is known.
 */
function limitingReset(a: Account): number {
  const r = a.rateLimits;
  if (r.claim === "five_hour" && r.fiveHourReset) return r.fiveHourReset;
  if (r.claim === "seven_day" && r.sevenDayReset) return r.sevenDayReset;
  const earliest = earliestReset(a);
  return Number.isFinite(earliest) ? earliest : 0;
}

function isCooling(a: Account, model?: string): boolean {
  return cooldownDeadline(a, model) > Date.now();
}

/** Seconds until a blocked account can plausibly be tried again. */
function retryAfterSeconds(a: Account, model?: string, now = Date.now()): number {
  const nowSec = Math.floor(now / 1000);
  let blockedUntil = cooldownDeadline(a, model);
  const reset = limitingReset(a);
  if (a.rateLimits.status === "rate_limited" && reset > nowSec) {
    blockedUntil = Math.max(blockedUntil, reset * 1000);
  }
  if (blockedUntil <= now) return 60;
  return Math.max(1, Math.ceil((blockedUntil - now) / 1000));
}

/** Enabled and not refused by upstream: getNext() may still hand it out,
 *  if only through a degraded tier (busy, or over a user cap). */
function isNotBlocked(a: Account, model?: string): boolean {
  return a.enabled && !isCooling(a, model) && a.rateLimits.status !== "rate_limited";
}

/**
 * The Retry-After getNext() reports once every healthy account is blocked:
 * the soonest any enabled one can be tried again. Infinity when none is
 * enabled, which getNext() maps to EmptyPoolError rather than a wait.
 */
function blockedPoolRetryAfter(healthy: Account[], model?: string): number {
  return Math.min(...healthy.filter(a => a.enabled).map(a => retryAfterSeconds(a, model)));
}

/**
 * Roll over any rate-limit window whose reset timestamp has passed.
 *
 * `rateLimits` is a snapshot of Anthropic's response headers — utilization
 * values only refresh when a new response arrives. That creates a stuck
 * state in two scenarios:
 *
 *   1. `status: "rate_limited"` — the pool refuses to route to the account,
 *      so no new response ever updates the status.
 *   2. `fiveHourUtil` / `sevenDayUtil` at or above the user cap — `overUserCap`
 *      evicts the account from rotation, so the util stays stale at its last
 *      recorded value instead of dropping to ~0 when Anthropic's window resets.
 *
 * This sweep resolves both: when `now >= reset` for a window, the util is
 * zeroed and the window's reset timestamp is cleared. When the limiting
 * window expires, `status` flips back to `"allowed"`. The callback fires
 * once per recovery so the dashboard can surface it.
 */
function clearExpiredCooldown(a: Account, onExpired?: (a: Account) => void): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const r = a.rateLimits;
  let changed = false;
  let recovered = false;

  if (r.fiveHourReset > 0 && nowSec >= r.fiveHourReset) {
    r.fiveHourUtil = 0;
    r.fiveHourReset = 0;
    changed = true;
  }
  if (r.sevenDayReset > 0 && nowSec >= r.sevenDayReset) {
    r.sevenDayUtil = 0;
    r.sevenDayReset = 0;
    changed = true;
  }

  // If the account was rate_limited and its claimed window just reset,
  // return it to rotation. If we can't tell which window was limiting
  // (empty claim) but all known windows have rolled over, clear the flag.
  if (r.status === "rate_limited") {
    const stillBlocked =
      (r.claim === "five_hour" && r.fiveHourReset > 0) ||
      (r.claim === "seven_day" && r.sevenDayReset > 0) ||
      (r.claim === "" && (r.fiveHourReset > 0 || r.sevenDayReset > 0));
    if (!stillBlocked) {
      r.status = "allowed";
      recovered = true;
      changed = true;
    }
  }

  if (changed) r.lastUpdated = Date.now();
  if (recovered && onExpired) onExpired(a);
}

/** True when the account's user-defined caps have been reached. */
function overUserCap(a: Account): boolean {
  return (
    a.rateLimits.fiveHourUtil * 100 >= a.sessionLimitPercent ||
    a.rateLimits.sevenDayUtil * 100 >= a.weeklyLimitPercent
  );
}

/** Filter out accounts the user has taken out of the rotation. */
function isUsable(a: Account): boolean {
  return a.enabled && !overUserCap(a);
}

export interface AccountPatch {
  enabled?: boolean;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
}

export class TokenPool {
  private accounts: Account[];
  private currentIndex = 0;

  constructor(accounts: Account[]) {
    this.accounts = accounts;
  }

  /**
   * Round-robin selection among accounts that are:
   *   • healthy
   *   • not busy
   *   • not in a 429/529 cooldown
   *   • not rate-limited by Anthropic
   *   • enabled (user toggle)
   *   • under the user-configured 5h/7d caps
   *
   * Fallback chain when nothing is immediately available:
   *   1. A healthy, enabled, non-rate-limited account — pick earliest reset.
   *      This still allows a busy account to take traffic when every account is
   *      already in flight, but never bypasses a 429/529 cooldown.
   *   2. The same kind of account even when it is over a user cap. Limits are
   *      advisory, not a hard ban that would leave Claude Code with no working
   *      account; the bypass is surfaced through `onCapBypass`.
   *   3. accounts[0] as a last resort only if every account is unhealthy.
   *
   * If all healthy accounts are cooling or rate-limited, throws
   * `NoAvailableAccountError` instead of sending repeated requests to one
   * known-blocked key. The caller should return 429 with its retry-after.
   *
   * Throws `EmptyPoolError` when there are no accounts at all — callers in
   * the request path should map this to a 503. The DELETE endpoint guards
   * against this state by refusing to remove the last account.
   */
  getNext(model?: string): Account {
    if (this.accounts.length === 0) {
      throw new EmptyPoolError("token pool is empty — add an account first");
    }

    // Sweep expired cooldowns before filtering — otherwise rate_limited accounts
    // whose reset window has passed would never re-enter rotation.
    for (const a of this.accounts) clearExpiredCooldown(a, this.onCooldownExpired);

    const available = this.accounts.filter(a => this.isAvailable(a, model));

    if (available.length === 0) {
      const healthy = this.accounts.filter(a => a.healthy);
      if (healthy.length === 0) {
        return this.markSelected(this.accounts[0]);
      }

      // Busy is a transient concurrency signal and can be bypassed when no
      // idle account exists. Cooling/rate-limited is an upstream refusal and
      // must never be bypassed: doing so was the key-rotation deadlock seen in
      // production, where the same account received every retry after both
      // accounts had returned 429.
      const notBlocked = healthy.filter(a => isNotBlocked(a, model));
      const healthyUsable = notBlocked.filter(isUsable);
      if (healthyUsable.length > 0) {
        return this.markSelected(healthyUsable.reduce((best, a) =>
          earliestReset(a) < earliestReset(best) ? a : best
        ));
      }

      if (notBlocked.length > 0) {
        // All non-blocked accounts are over a user cap. Limits are advisory;
        // use the soonest reset rather than hammering a cooling account.
        const fallback = this.markSelected(notBlocked.reduce((best, a) =>
          earliestReset(a) < earliestReset(best) ? a : best
        ));
        if (this.onCapBypass) this.onCapBypass(fallback);
        return fallback;
      }

      const retryAfter = blockedPoolRetryAfter(healthy, model);
      if (!Number.isFinite(retryAfter)) throw new EmptyPoolError("no healthy enabled accounts");
      throw new NoAvailableAccountError(retryAfter);
    }

    const account = available[this.currentIndex % available.length];
    this.currentIndex = (this.currentIndex + 1) % available.length;
    return this.markSelected(account);
  }

  private markSelected(account: Account): Account {
    account.requestCount++;
    account.lastUsed = Date.now();
    return account;
  }

  /** Same predicate `getNext()` uses for its primary (non-degraded) tier. */
  /** Look up one account by id, regardless of its current health. */
  getById(id: string): Account | undefined {
    return this.accounts.find(a => a.id === id);
  }

  /**
   * Whether one specific account can take traffic right now — the same
   * predicate `getNext()` applies to its primary tier. Used by session
   * affinity to decide whether a pinned account is still serviceable before
   * reassigning the session elsewhere.
   */
  canServe(id: string, model?: string): boolean {
    const a = this.getById(id);
    if (!a) return false;
    // Sweep first, or an account whose cooldown has already elapsed would look
    // unusable and the session would be reassigned for no reason.
    clearExpiredCooldown(a, this.onCooldownExpired);
    return this.isAvailable(a, model);
  }

  /**
   * Whether a session already pinned to this account should stay on it.
   *
   * Differs from `canServe` only in not reading `busy`, which nothing sets:
   * cooldowns are deadlines (`cooldownDeadline`). Kept apart because the two
   * questions differ — a pinned session that leaves its account re-writes its
   * whole prompt cache into the next one, measured at 954K tokens for a single
   * conversation, so retention must never grow a condition that placement can
   * afford.
   */
  canRetain(id: string, model?: string): boolean {
    const a = this.getById(id);
    if (!a) return false;
    clearExpiredCooldown(a, this.onCooldownExpired);
    // A 429/529 cooldown is upstream telling us to stop, which a pin must
    // respect.
    const cooling = isCooling(a, model);
    return a.healthy && !cooling && a.rateLimits.status !== "rate_limited" && isUsable(a);
  }

  /**
   * Why a pinned account cannot be retained right now, and for how long.
   *
   * `canRetain` answers yes/no; a session large enough that moving it costs a
   * full prefix rewrite needs the reason too, because the two reasons call for
   * opposite responses. A cooldown has a deadline and can be sat out. Being
   * unhealthy, disabled or over a user cap has none, so waiting would stall the
   * request forever and the session has to go somewhere else.
   *
   * Reuses `retryAfterSeconds`, which already reconciles the cooldown deadline
   * with the limiting rate-limit window; duplicating that reconciliation here
   * is how the two would drift apart.
   */
  blockState(id: string, model?: string): PinBlock {
    const a = this.getById(id);
    if (!a) return { kind: "indefinite" };
    clearExpiredCooldown(a, this.onCooldownExpired);
    if (this.canRetain(id, model)) return { kind: "none" };

    const nowSec = Math.floor(Date.now() / 1000);
    const hasDeadline =
      cooldownDeadline(a, model) > Date.now() ||
      (a.rateLimits.status === "rate_limited" && limitingReset(a) > nowSec);
    // A deadline is what makes waiting a real option. An account that is
    // rate_limited with no reset in its headers is indistinguishable from one
    // that is simply unavailable, so it reads as indefinite rather than as a
    // wait of the fallback length.
    if (!hasDeadline) return { kind: "indefinite" };
    return { kind: "temporary", retryAfterSeconds: retryAfterSeconds(a, model) };
  }

  private isAvailable(a: Account, model?: string): boolean {
    return a.healthy && !a.busy && !isCooling(a, model) && a.rateLimits.status !== "rate_limited" && isUsable(a);
  }

  /** Optional listener fired when a request is routed to a capped account
   *  because every account in the pool was over its user-configured cap. */
  public onCapBypass?: (account: Account) => void;

  /** Optional listener fired when a rate-limited account's cooldown expires
   *  and it is automatically returned to the rotation. */
  public onCooldownExpired?: (account: Account) => void;

  /**
   * Sweep the pool for accounts whose rate_limited cooldown has passed and
   * clear the flag in place. Intended for periodic calls from the dashboard
   * poll loop so the UI reflects recovery without waiting for a new request.
   */
  sweepExpiredCooldowns(): void {
    for (const a of this.accounts) clearExpiredCooldown(a, this.onCooldownExpired);
  }

  /**
   * Point-in-time check: true if at least one account is immediately usable
   * (same predicate as getNext()'s primary tier — healthy, not busy, not
   * rate-limited, enabled, under user caps). Unlike getNext(), this never
   * mutates requestCount/lastUsed/currentIndex and never throws on an empty
   * pool (returns false instead) — safe to call speculatively on every
   * request to decide whether to consider cross-provider fallback.
   */
  hasAvailableAccount(model?: string): boolean {
    for (const a of this.accounts) clearExpiredCooldown(a, this.onCooldownExpired);
    return this.accounts.some(a => this.isAvailable(a, model));
  }

  /**
   * Seconds until getNext() would hand out an account for `model` again.
   *
   * 0 means it would serve one now — including through its degraded tiers
   * (busy, over a user cap, or every account unhealthy), so this is NOT the
   * negation of hasAvailableAccount(). A positive value is exactly the
   * Retry-After the router answers with when getNext() throws
   * NoAvailableAccountError. Infinity means there is nothing to wait for:
   * the pool is empty or no healthy account is enabled (getNext() throws
   * EmptyPoolError). Never mutates selection state.
   */
  secondsUntilAvailable(model?: string): number {
    if (this.accounts.length === 0) return Infinity;
    for (const a of this.accounts) clearExpiredCooldown(a, this.onCooldownExpired);
    const healthy = this.accounts.filter(a => a.healthy);
    if (healthy.length === 0) return 0;
    if (healthy.some(a => isNotBlocked(a, model))) return 0;
    return blockedPoolRetryAfter(healthy, model);
  }

  getAll(): Account[] {
    return this.accounts;
  }

  getHealthy(): Account[] {
    return this.accounts.filter(a => a.healthy);
  }

  getStats() {
    return this.accounts.map(a => ({
      id: a.id,
      healthy: a.healthy,
      busy: a.busy,
      requestCount: a.requestCount,
      errorCount: a.errorCount,
      expiresInMs: a.tokens.expiresAt - Date.now(),
      lastUsedMs: a.lastUsed,
      lastRefreshMs: a.lastRefresh,
      rateLimits: a.rateLimits,
      enabled: a.enabled,
      sessionLimitPercent: a.sessionLimitPercent,
      weeklyLimitPercent: a.weeklyLimitPercent,
    }));
  }

  // ─── Mutation API (used by the authenticated HTTP endpoints) ───────────────

  findById(id: string): Account | null {
    return this.accounts.find(a => a.id === id) ?? null;
  }

  /**
   * Apply a partial update to an account's user-controlled fields.
   * Only `enabled`, `sessionLimitPercent`, and `weeklyLimitPercent` are
   * touched — token fields are never accepted via this API.
   * Returns the updated account, or null if the id was not found.
   */
  updateAccount(id: string, patch: AccountPatch): Account | null {
    const a = this.findById(id);
    if (!a) return null;
    if (patch.enabled !== undefined) a.enabled = !!patch.enabled;
    if (patch.sessionLimitPercent !== undefined) {
      a.sessionLimitPercent = clampPercent(patch.sessionLimitPercent);
    }
    if (patch.weeklyLimitPercent !== undefined) {
      a.weeklyLimitPercent = clampPercent(patch.weeklyLimitPercent);
    }
    return a;
  }

  /**
   * Append a new account built from a persisted AccountRecord.
   * Rejects duplicates by id — callers should pre-check with findById().
   */
  addAccount(record: AccountRecord): Account {
    if (this.findById(record.id)) {
      throw new Error(`Account "${record.id}" already exists`);
    }
    const account: Account = {
      id: record.id,
      tokens: {
        accessToken: record.accessToken,
        refreshToken: record.refreshToken,
        expiresAt: record.expiresAt,
        scopes: record.scopes ?? ["user:inference", "user:profile"],
      },
      healthy: true,
      busy: false,
      requestCount: 0,
      errorCount: 0,
      lastUsed: 0,
      lastRefresh: 0,
      consecutiveErrors: 0,
      rateLimits: { ...DEFAULT_RATE_LIMITS },
      enabled: record.enabled !== false,
      sessionLimitPercent: record.sessionLimitPercent !== undefined
        ? clampPercent(record.sessionLimitPercent)
        : ACCOUNT_USER_DEFAULTS.sessionLimitPercent,
      weeklyLimitPercent: record.weeklyLimitPercent !== undefined
        ? clampPercent(record.weeklyLimitPercent)
        : ACCOUNT_USER_DEFAULTS.weeklyLimitPercent,
    };
    this.accounts.push(account);
    return account;
  }

  /**
   * Remove an account by id. Returns true if something was removed.
   *
   * CRITICAL: mutates `this.accounts` IN PLACE via splice() rather than
   * reassigning it. The server passes the same array reference to
   * `startRefreshLoop()` at startup; reassigning would desynchronize the
   * refresh loop from the pool, and the loop's `saveAccounts(accounts)` call
   * would later resurrect the deleted account on disk.
   */
  removeAccount(id: string): boolean {
    const idx = this.accounts.findIndex(a => a.id === id);
    if (idx === -1) return false;
    this.accounts.splice(idx, 1);
    if (this.accounts.length > 0) {
      this.currentIndex = this.currentIndex % this.accounts.length;
    } else {
      this.currentIndex = 0;
    }
    return true;
  }
}
