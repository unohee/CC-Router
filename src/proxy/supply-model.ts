/**
 * The supply model: how many tokens each account's quota windows buy, how much
 * the pool is expected to ask for, and when an account runs out.
 *
 * Pure functions over plain data (quota readings, hourly usage buckets, the
 * live rate-limit readings). Nothing here reads a clock or a store; the caller
 * passes `now` and the inputs, which is what makes the estimates testable.
 *
 * Tokens are cost-weighted, because a window is metered in spend rather than
 * raw tokens: a cache read costs a tenth of fresh input, output five times.
 * The weights follow the API price ratios; only their ratios matter.
 */

import { HOUR_MS, DAY_MS, type UsageBucket } from "./usage-history.js";
import type { QuotaReading } from "./quota-history.js";

export const COST_WEIGHTS = { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 } as const;

/** Cost-weighted tokens of one usage reading. Bad numbers count as 0. */
export function costWeighted(u: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number }): number {
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return n(u.input) * COST_WEIGHTS.input + n(u.output) * COST_WEIGHTS.output
    + n(u.cacheCreation) * COST_WEIGHTS.cacheCreation + n(u.cacheRead) * COST_WEIGHTS.cacheRead;
}

export type WindowName = "fiveHour" | "sevenDay";
export const WINDOW_MS: Record<WindowName, number> = { fiveHour: 5 * HOUR_MS, sevenDay: 7 * DAY_MS };

export interface SupplyOptions {
  /** Paired samples needed before a capacity is reported (the decision is 24). */
  minSamples: number;
  /** Utilization the pairs must move in total (0..1); less is noise. */
  minUtilMoved: number;
  /** Days of hourly history the demand profile is built from. */
  profileDays: number;
  /** How far back the burn slope for the exhaustion estimate looks. */
  slopeLookbackMs: number;
  /** Two readings name the same window when their resets differ by at most this (s). */
  resetToleranceSec: number;
}

export const DEFAULT_SUPPLY_OPTIONS: SupplyOptions = {
  minSamples: 24,
  minUtilMoved: 0.02,
  profileDays: 14,
  slopeLookbackMs: 6 * HOUR_MS,
  resetToleranceSec: 600,
};

export interface CapacityEstimate {
  status: "ok" | "unknown";
  /** Cost-weighted tokens one percent of the window buys; null while unknown. */
  tokensPerPercent: number | null;
  /** Reading pairs inside one window that the estimate rests on. */
  samples: number;
  /** Why it is unknown. */
  reason?: "too few samples" | "too little movement";
}

const sameWindow = (a: number, b: number, tol: number): boolean => a > 0 && b > 0 && Math.abs(a - b) <= tol;

/**
 * Capacity of one window for one account, from its own readings.
 *
 * Consecutive readings in the same window (same reset, utilization not
 * falling) form a pair; what the account spent between them over how far its
 * utilization moved is one sample. The estimate is the ratio of the sums, so a
 * pair that moved by a rounding step does not swing it. A pair spanning a reset,
 * a restart that lost the counter (spend going backwards) or a reading from
 * before spend was kept is left out.
 */
export function estimateCapacity(
  readings: ReadonlyArray<QuotaReading>,
  window: WindowName,
  opts: SupplyOptions = DEFAULT_SUPPLY_OPTIONS,
): CapacityEstimate {
  const sorted = [...readings].sort((a, b) => a.sampledAt - b.sampledAt);
  let samples = 0, tokens = 0, moved = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (a.spentAt === null || b.spentAt === null || b.spentAt < a.spentAt) continue;
    if (!sameWindow(a[window].resetAt, b[window].resetAt, opts.resetToleranceSec)) continue;
    const du = b[window].util - a[window].util;
    if (du < 0) continue;
    const spent = b.spentAt - a.spentAt;
    if (spent === 0 && du === 0) continue;
    samples++;
    tokens += spent;
    moved += du;
  }
  if (samples < opts.minSamples) return { status: "unknown", tokensPerPercent: null, samples, reason: "too few samples" };
  if (moved < opts.minUtilMoved) return { status: "unknown", tokensPerPercent: null, samples, reason: "too little movement" };
  return { status: "ok", tokensPerPercent: tokens / (moved * 100), samples };
}

export interface DemandProfile {
  /** Mean cost-weighted pool demand per UTC hour of day, 24 entries. */
  perHour: number[];
  /** Recorded hours the profile was built from. */
  hours: number;
}

/**
 * Expected pool demand by hour of day, from the last `profileDays` of hourly
 * usage. Only hours since recording began count, and an hour with no traffic
 * counts as zero, not as missing. Null with no recorded hour at all.
 */
export function demandProfile(
  buckets: ReadonlyArray<UsageBucket>,
  since: number | null,
  now: number,
  opts: SupplyOptions = DEFAULT_SUPPLY_OPTIONS,
): DemandProfile | null {
  if (since === null) return null;
  const lastWhole = Math.floor(now / HOUR_MS) * HOUR_MS; // the current hour is still filling
  const first = Math.max(Math.floor(since / HOUR_MS) * HOUR_MS, lastWhole - opts.profileDays * DAY_MS);
  if (first >= lastWhole) return null;
  const byHour = new Map<number, number>();
  for (const b of buckets) {
    if (b.hour < first || b.hour >= lastWhole) continue;
    byHour.set(b.hour, (byHour.get(b.hour) ?? 0) + costWeighted(b));
  }
  const sum = new Array<number>(24).fill(0), count = new Array<number>(24).fill(0);
  let hours = 0;
  for (let h = first; h < lastWhole; h += HOUR_MS) {
    const hod = new Date(h).getUTCHours();
    sum[hod] += byHour.get(h) ?? 0;
    count[hod]++;
    hours++;
  }
  const overall = sum.reduce((a, b) => a + b, 0) / hours;
  // An hour of day not yet seen falls back to the overall mean.
  return { perHour: sum.map((s, i) => (count[i] > 0 ? s / count[i] : overall)), hours };
}

/** Expected pool demand between two instants, by the profile, partial hours pro rata. */
export function forecastDemand(profile: DemandProfile, from: number, to: number): number {
  if (!(to > from)) return 0;
  let total = 0;
  for (let h = Math.floor(from / HOUR_MS) * HOUR_MS; h < to; h += HOUR_MS) {
    const overlap = Math.min(to, h + HOUR_MS) - Math.max(from, h);
    if (overlap > 0) total += profile.perHour[new Date(h).getUTCHours()] * (overlap / HOUR_MS);
  }
  return total;
}

/** The live reading of one account, as the pool holds it. */
export interface LiveAccount {
  id: string;
  fiveHour: { util: number; resetAt: number };
  sevenDay: { util: number; resetAt: number };
  /** When that reading arrived, epoch ms; 0 for never. */
  readAt: number;
}

export interface WindowSupply {
  capacity: CapacityEstimate;
  /** Cost-weighted tokens left before the window is spent; null while capacity is unknown. */
  remaining: number | null;
  /** Expected pool demand from now until this window resets; null without a profile or a reset. */
  poolDemandToReset: number | null;
  /**
   * When the account is projected to reach 100% at its recent burn rate, epoch
   * ms. Null when it is not burning, has no recent reading, or lasts to the reset.
   */
  exhaustsAt: number | null;
  /** True when the projection lands before the window resets. */
  exhaustsBeforeReset: boolean;
}

export interface AccountSupply {
  id: string;
  fiveHour: WindowSupply;
  sevenDay: WindowSupply;
}

export interface PoolSupply {
  generatedAt: number;
  accounts: AccountSupply[];
  demand: {
    /** Recorded hours behind the profile; 0 means no forecast. */
    profileHours: number;
    /** Expected pool demand over the next 24 hours; null without a profile. */
    next24h: number | null;
  };
  budget: {
    /**
     * Cost-weighted tokens the pool can spend today and keep every account
     * with a known 7-day capacity on pace: each one's remaining supply spread
     * over the days left to its weekly reset. Null when no account is known.
     */
    today: number | null;
    /** Accounts the budget covers, and those it cannot (capacity unknown). */
    known: number;
    unknown: number;
  };
}

/**
 * Projected time an account's window reaches 100%, from the slope between the
 * earliest reading in the lookback that belongs to the current window and the
 * live reading.
 */
export function projectExhaustion(
  readings: ReadonlyArray<QuotaReading>,
  live: LiveAccount,
  window: WindowName,
  now: number,
  opts: SupplyOptions = DEFAULT_SUPPLY_OPTIONS,
): { at: number | null; beforeReset: boolean } {
  const cur = live[window];
  if (live.readAt <= 0 || cur.resetAt <= 0 || cur.resetAt * 1000 <= now) return { at: null, beforeReset: false };
  const from = live.readAt - opts.slopeLookbackMs;
  const start = [...readings]
    .filter(r => r.sampledAt >= from && r.sampledAt < live.readAt && sameWindow(r[window].resetAt, cur.resetAt, opts.resetToleranceSec))
    .sort((a, b) => a.sampledAt - b.sampledAt)[0];
  if (!start) return { at: null, beforeReset: false };
  const rate = (cur.util - start[window].util) / (live.readAt - start.sampledAt); // util per ms
  if (!(rate > 0)) return { at: null, beforeReset: false };
  if (cur.util >= 1) return { at: live.readAt, beforeReset: true };
  const at = live.readAt + (1 - cur.util) / rate;
  return at < cur.resetAt * 1000 ? { at: Math.round(at), beforeReset: true } : { at: null, beforeReset: false };
}

/** The whole picture for health and the dashboard. */
export function computeSupply(input: {
  now: number;
  live: ReadonlyArray<LiveAccount>;
  readings: ReadonlyArray<QuotaReading>;
  buckets: ReadonlyArray<UsageBucket>;
  since: number | null;
  opts?: Partial<SupplyOptions>;
}): PoolSupply {
  const opts = { ...DEFAULT_SUPPLY_OPTIONS, ...input.opts };
  const { now } = input;
  const profile = demandProfile(input.buckets, input.since, now, opts);
  const byAccount = new Map<string, QuotaReading[]>();
  for (const r of input.readings) {
    const list = byAccount.get(r.accountId) ?? [];
    list.push(r);
    byAccount.set(r.accountId, list);
  }

  let budget = 0, known = 0, unknown = 0;
  const accounts = input.live.map((live): AccountSupply => {
    const own = byAccount.get(live.id) ?? [];
    const windowSupply = (w: WindowName): WindowSupply => {
      const capacity = estimateCapacity(own, w, opts);
      const cur = live[w];
      const remaining = capacity.tokensPerPercent === null || live.readAt <= 0
        ? null
        : Math.max(0, 1 - cur.util) * 100 * capacity.tokensPerPercent;
      const resetMs = cur.resetAt * 1000;
      const poolDemandToReset = profile && resetMs > now ? forecastDemand(profile, now, resetMs) : null;
      const ex = projectExhaustion(own, live, w, now, opts);
      return { capacity, remaining, poolDemandToReset, exhaustsAt: ex.at, exhaustsBeforeReset: ex.beforeReset };
    };
    const fiveHour = windowSupply("fiveHour");
    const sevenDay = windowSupply("sevenDay");
    const resetMs = live.sevenDay.resetAt * 1000;
    if (sevenDay.remaining !== null && resetMs > now) {
      const daysLeft = Math.max(1, (resetMs - now) / DAY_MS);
      budget += sevenDay.remaining / daysLeft;
      known++;
    } else {
      unknown++;
    }
    return { id: live.id, fiveHour, sevenDay };
  });

  return {
    generatedAt: now,
    accounts,
    demand: { profileHours: profile?.hours ?? 0, next24h: profile ? forecastDemand(profile, now, now + DAY_MS) : null },
    budget: { today: known > 0 ? budget : null, known, unknown },
  };
}
