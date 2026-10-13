/**
 * Opt-in request pacing / admission throttle.
 *
 * This is a SCHEDULING layer, not a token-reduction layer: as one Anthropic
 * account's quota utilization climbs toward its ceiling, the proxy spaces out
 * (and caps the concurrency of) the requests it sends to that account, instead
 * of charging into a 429 that Claude Code will retry — and a retry burns more
 * tokens than the wait it avoided.
 *
 * Hard invariants:
 *   • Never rejects a request. `admit()` always resolves, even after its wait
 *     expires (fail-open) — the proxy must never leave the client with zero
 *     working account.
 *   • Never synthesizes a 429. Caps and this throttle are orthogonal layers.
 *   • Fully inert when disabled (the default): no timers, no state, no logs.
 */

export interface ThrottleConfig {
  /** Master switch. Default: false (OFF) — the deployed router's behavior is
   *  unchanged until an operator opts in. */
  enabled: boolean;
  /** Max concurrent in-flight requests allowed on one account. Default: 4.
   *  `0` disables the concurrency gate entirely (pacing may still apply). */
  perAccountMaxInFlight: number;
  /** Utilization (0–1) below which no restriction applies. Default: 0.75. */
  startUtil: number;
  /** Utilization (0–1) at/above which concurrency is 1 and spacing is at
   *  maximum. Default: 0.95. */
  hardUtil: number;
  /** Hard cap on any single `admit()` wait, once its wait expires the request
   *  proceeds anyway. Default: 20000. */
  maxWaitMs: number;
  /** Sleep slice used while polling for a free concurrency slot. Default: 250. */
  pollMaxDelayMs: number;
  /** Minimum spacing (ms) between two consecutive upstream sends on one
   *  account, reached at `hardUtil`. Default: 0 — no pacing. */
  minIntervalMs: number;
  /** Log a one-shot saturation/recovery line when every enabled+healthy
   *  Anthropic account sits at/above `hardUtil`. Default: true. */
  logSaturation: boolean;
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  enabled: false,
  perAccountMaxInFlight: 4,
  startUtil: 0.75,
  hardUtil: 0.95,
  maxWaitMs: 20000,
  pollMaxDelayMs: 250,
  minIntervalMs: 0,
  logSaturation: true,
};

/**
 * Clamp `util` into [startUtil, hardUtil]. Non-finite readings are clamped
 * toward the least restrictive bound (an unknown quota reads as "no reading" —
 * same stance token-pool takes when utilization is unmeasured), +Infinity
 * clamps to `hardUtil`.
 */
function clampedUtil(util: number, startUtil: number, hardUtil: number): number {
  if (Number.isFinite(util)) return Math.min(Math.max(util, startUtil), hardUtil);
  return util > hardUtil ? hardUtil : startUtil;
}

/**
 * How far into the ramp `util` sits: 0 at `startUtil`, 1 at `hardUtil`.
 * A degenerate range (hardUtil <= startUtil) cannot ramp, so it reads as 0.
 */
function rampFraction(util: number, cfg: ThrottleConfig): number {
  if (!(cfg.hardUtil > cfg.startUtil)) return 0;
  const u = clampedUtil(util, cfg.startUtil, cfg.hardUtil);
  return Math.max(0, Math.min(1, (u - cfg.startUtil) / (cfg.hardUtil - cfg.startUtil)));
}

/**
 * Pure. Concurrency limit for one account at the given utilization.
 * Canonical definition, with `L0 = cfg.perAccountMaxInFlight`:
 *
 *     frac  = clamp((u - startUtil) / (hardUtil - startUtil), 0, 1)   // 0 when hardUtil <= startUtil
 *     limit = Math.max(1, Math.round(L0 - frac * (L0 - 1)))           // L0 at frac=0, exactly 1 at frac=1
 *
 * - returns cfg.perAccountMaxInFlight when util <= cfg.startUtil
 * - returns exactly 1 when util >= cfg.hardUtil
 * - linear between; rounded; NEVER below 1 (L0=3, start=0, hard=1: 0.25→3, 0.5→2, 0.9→1)
 * - if cfg.perAccountMaxInFlight <= 0, returns Number.POSITIVE_INFINITY (gate off)
 * - guards hardUtil <= startUtil and non-finite util by clamping util into [startUtil, hardUtil]
 *
 * `Math.round` is intentionally half-up, so a value landing exactly on .5 rounds
 * to the higher slot count — deterministic, not a rounding bug.
 */
export function admissionLimit(util: number, cfg: ThrottleConfig): number {
  if (!(cfg.perAccountMaxInFlight > 0)) return Number.POSITIVE_INFINITY;
  const frac = rampFraction(util, cfg);
  const max = cfg.perAccountMaxInFlight;
  return Math.max(1, Math.round(max - frac * (max - 1)));
}

/**
 * Pure. Minimum spacing (ms) the pacer must keep between two consecutive
 * upstream sends on ONE account, at the given utilization.
 * - returns 0 when !cfg.enabled, when cfg.minIntervalMs <= 0, or when
 *   util <= cfg.startUtil
 * - linearly ramps from 0 at startUtil to cfg.minIntervalMs at hardUtil,
 *   rounded to whole milliseconds (pacingIntervalMs(0.76, minIntervalMs 1000) → 50)
 * - never negative; same clamping/guard rules as admissionLimit
 */
export function pacingIntervalMs(util: number, cfg: ThrottleConfig): number {
  if (!cfg.enabled) return 0;
  if (!(cfg.minIntervalMs > 0)) return 0;
  // Integer ms: a fractional interval is meaningless to a timer and would leak
  // a non-integer into sleep().
  return Math.max(0, Math.round(rampFraction(util, cfg) * cfg.minIntervalMs));
}

export interface ThrottleGate {
  /** Wait until this account may send. Never rejects. Never throws on expiry. */
  admit(accountId: string, util: number): Promise<void>;
  /** Count a request as in flight for this account. */
  acquire(accountId: string): void;
  /** Remove one in-flight request for this account. Safe to call more than once. */
  release(accountId: string): void;
  inFlight(accountId: string): number;
  snapshot(): Record<string, number>;
}

export interface ThrottleGateDeps {
  /** Clock, default Date.now. */
  now?: () => number;
  /** Sleeper, default a setTimeout promise. */
  sleep?: (ms: number) => Promise<void>;
}

export function createThrottleGate(cfg: ThrottleConfig, deps?: ThrottleGateDeps): ThrottleGate {
  const now = deps?.now ?? ((): number => Date.now());
  const sleep = deps?.sleep ?? ((ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const counts = new Map<string, number>();
  const nextSlot = new Map<string, number>();

  const inFlight = (accountId: string): number => counts.get(accountId) ?? 0;

  return {
    inFlight,

    snapshot(): Record<string, number> {
      const out: Record<string, number> = {};
      for (const [id, n] of counts) out[id] = n;
      return out;
    },

    acquire(accountId: string): void {
      // Disabled means byte-identical to pre-throttle behavior — no counting at
      // all, so `snapshot()` stays empty and nothing observes a gate.
      if (!cfg.enabled) return;
      counts.set(accountId, inFlight(accountId) + 1);
    },

    release(accountId: string): void {
      if (!cfg.enabled) return;
      const n = inFlight(accountId);
      if (n <= 0) return;
      if (n === 1) counts.delete(accountId);
      else counts.set(accountId, n - 1);
    },

    async admit(accountId: string, util: number): Promise<void> {
      // 1. Disabled — fully inert. No state touched, nothing awaited.
      if (!cfg.enabled) return;

      // 2. Pacing. The reservation is written before any await so concurrent
      //    callers for the same account stack up behind each other instead of
      //    all reading the same stale slot.
      const interval = pacingIntervalMs(util, cfg);
      if (interval > 0) {
        const t = now();
        const slot = Math.max(t, nextSlot.get(accountId) ?? 0);
        nextSlot.set(accountId, slot + interval);
        const wait = Math.min(slot - t, cfg.maxWaitMs);
        if (wait > 0) await sleep(wait);
      }

      // 3. Concurrency gate. Poll until a slot frees up or the budget runs
      //    out, then proceed either way (fail-open — never reject). No single
      //    slice may exceed the remaining budget, so the wait can overshoot
      //    maxWaitMs only by the clock, never by a whole poll slice.
      if (cfg.perAccountMaxInFlight > 0) {
        const limit = admissionLimit(util, cfg);
        let waited = 0;
        while (inFlight(accountId) >= limit) {
          const remaining = cfg.maxWaitMs - waited;
          if (remaining <= 0 || cfg.pollMaxDelayMs <= 0) break;
          const slice = Math.min(cfg.pollMaxDelayMs, remaining);
          await sleep(slice);
          waited += slice;
        }
      }
    },
  };
}
