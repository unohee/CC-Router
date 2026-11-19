import type { Account, AccountRateLimits } from "./types.js";
import type { OpenAISubscriptionAccount as OpenAIAccount } from "../providers/openai/token-refresher.js";
import type { SessionTarget, TargetMetrics, ReassignReason } from "./session-router.js";
import type { TokenPool } from "./token-pool.js";

/**
 * What placement knows about a seat, built in one place.
 *
 * These used to be closures inside `startServer`, which made them impossible to
 * drive from anything but a running router. The balance simulator
 * (src/__tests__/balance/) needs the exact metrics production ranks on, not a
 * copy that drifts, so they live here and `server.ts` imports them.
 */

/** The rate-limit fields placement reads. */
export type SeatLimits = Pick<AccountRateLimits, "fiveHourUtil" | "fiveHourReset" | "sevenDayUtil" | "sevenDayReset">;

/**
 * How full a seat's quota is, as the worst of its two windows, and when that
 * window resets. The tighter window is what actually stops the account, so the
 * maximum (not the currently claimed one) is the honest measure of remaining
 * headroom. Unknown quota reads as empty, which lets an unmeasured account take
 * work and thereby produce the reading.
 *
 * Ranking uses the five-hour window every account shares (`pace`). Ranking on
 * whichever window is fuller compared a weekly fraction against other
 * accounts' five-hour fractions and divided it by days to reset: the one
 * account that reported a weekly window (27% used, 6.7 days out) scored ~40x
 * below the rest and was left idle while they ran at the cap. The weekly window
 * still decides whether the account is over the soft cap.
 */
export function seatMetrics(limits: SeatLimits | undefined | null): TargetMetrics {
  if (!limits) return { util: 0 };
  const pace = { util: limits.fiveHourUtil, resetAtSec: limits.fiveHourReset };
  const weekly = { util: limits.sevenDayUtil, resetAtSec: limits.sevenDayReset };
  const fiveHour = { util: limits.fiveHourUtil, resetAtSec: limits.fiveHourReset };
  return limits.sevenDayUtil > limits.fiveHourUtil
    ? { util: limits.sevenDayUtil, resetAtSec: limits.sevenDayReset, pace, weekly, fiveHour }
    : { util: limits.fiveHourUtil, resetAtSec: limits.fiveHourReset, pace, weekly, fiveHour };
}

/** Worst of an account's two quota windows. */
export function worstWindowUtil(limits: SeatLimits): number {
  return Math.max(limits.fiveHourUtil, limits.sevenDayUtil);
}

/** The pieces of the router the seat predicates read. */
export interface SeatSources {
  pool: Pick<TokenPool, "getAll" | "getById" | "canServe" | "canRetain" | "canServeLastResort">;
  openAIAccounts: ReadonlyArray<OpenAIAccount>;
  /** The OpenAI picker's own predicate, so a session is never pinned to an
   *  account the picker would refuse. */
  canServeOpenAI: (a: OpenAIAccount) => boolean;
}

export interface Seats {
  /** Placement metrics for a target. */
  metrics: (t: SessionTarget) => TargetMetrics;
  /** May take new work now. */
  usable: (t: SessionTarget, model?: string) => boolean;
  /** May keep a session it already holds (judged more leniently than `usable`;
   *  see TokenPool.canRetain). */
  retainable: (t: SessionTarget, model?: string) => boolean;
  /** The failover pick: usable for this model, not tried yet, coolest first;
   *  else a seat that can serve only as a last resort. Does not count the
   *  request; the caller does. */
  failoverPick: (tried: ReadonlySet<string>, model: string | undefined) => Account | null;
}

export function createSeats(src: SeatSources): Seats {
  const { pool, openAIAccounts, canServeOpenAI } = src;
  const openAI = (id: string) => openAIAccounts.some(a => a.id === id && canServeOpenAI(a));
  return {
    metrics: t => seatMetrics(t.provider === "anthropic"
      ? pool.getById(t.accountId)?.rateLimits
      : openAIAccounts.find(a => a.id === t.accountId)?.rateLimits),
    usable: (t, model) => t.provider === "anthropic" ? pool.canServe(t.accountId, model) : openAI(t.accountId),
    retainable: (t, model) => t.provider === "anthropic" ? pool.canRetain(t.accountId, model) : openAI(t.accountId),
    failoverPick: (tried, model) => {
      let candidates = pool.getAll().filter(a => !tried.has(a.id) && pool.canServe(a.id, model));
      // Before relaying a refusal: a seat whose refresh token died but whose
      // access token still works (TokenPool.canServeLastResort).
      if (candidates.length === 0) candidates = pool.getAll().filter(a => !tried.has(a.id) && pool.canServeLastResort(a.id, model));
      if (candidates.length === 0) return null;
      return candidates.reduce((best, a) => (worstWindowUtil(a.rateLimits) < worstWindowUtil(best.rateLimits) ? a : best));
    },
  };
}

// ─── Placement counters ──────────────────────────────────────────────────────

/**
 * Why a session landed on a seat:
 * - `placed`: a session with no pin got one;
 * - `unservable`, `soft-cap`, `weekly-pace`: a pinned session moved, for the
 *   router's reason (see SessionRouter);
 * - `repin`: an OpenAI pin refused the session and it was moved to Claude.
 */
export type PlacementReason = "placed" | ReassignReason | "repin";

export const PLACEMENT_REASONS: ReadonlyArray<PlacementReason> = ["placed", "unservable", "soft-cap", "weekly-pace", "repin"];

export type PlacementCounts = Record<PlacementReason, number>;

export function emptyPlacementCounts(): PlacementCounts {
  return { placed: 0, unservable: 0, "soft-cap": 0, "weekly-pace": 0, repin: 0 };
}

/**
 * Whether a resolve that went from `before` to `after` placed a session that
 * had no pin. Moves are counted from SessionRouter's `onReassign`, which knows
 * the reason; a first placement fires no reassignment, so it is told apart here.
 */
export function isFirstPlacement(before: SessionTarget | null | undefined, after: SessionTarget | null | undefined): boolean {
  return !before && !!after;
}
