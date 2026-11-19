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
  /** Each seat's size relative to a typical seat (seat-size.ts). Absent: all 1. */
  sizeOf?: (accountId: string) => number;
  /** The session router's ranking for a request with no session to pin
   *  (SessionRouter.rank): the failover pick and a request without a session
   *  id. Absent, or null from it: the caller's own order. */
  rank?: (candidates: SessionTarget[], isUsable: (t: SessionTarget) => boolean, utilOf: (t: SessionTarget) => TargetMetrics, mode: "score" | "rotate") => SessionTarget | null;
}

export interface Seats {
  /** Placement metrics for a target. */
  metrics: (t: SessionTarget) => TargetMetrics;
  /** May take new work now. */
  usable: (t: SessionTarget, model?: string) => boolean;
  /** May keep a session it already holds (judged more leniently than `usable`;
   *  see TokenPool.canRetain). */
  retainable: (t: SessionTarget, model?: string) => boolean;
  /** The failover pick: usable for this model, not tried yet, ranked as a new
   *  session would be (else coolest first); else a seat that can serve only
   *  as a last resort. Does not count the request; the caller does. */
  failoverPick: (tried: ReadonlySet<string>, model: string | undefined) => Account | null;
  /** The seat for a request with no session id: ranked as a new session would
   *  be, or null for the pool's own round-robin (TokenPool.getNext). */
  pickForRequest: (model: string | undefined) => Account | null;
}

export function createSeats(src: SeatSources): Seats {
  const { pool, openAIAccounts, canServeOpenAI, sizeOf, rank } = src;
  const openAI = (id: string) => openAIAccounts.some(a => a.id === id && canServeOpenAI(a));
  const metrics = (t: SessionTarget): TargetMetrics => {
    const m = seatMetrics(t.provider === "anthropic"
      ? pool.getById(t.accountId)?.rateLimits
      : openAIAccounts.find(a => a.id === t.accountId)?.rateLimits);
    return sizeOf ? { ...m, size: sizeOf(t.accountId) } : m;
  };
  /** The ranked pick among `accounts`, or null when the ranking is off. */
  const ranked = (accounts: Account[], model: string | undefined, mode: "score" | "rotate"): Account | null => {
    if (!rank || accounts.length === 0) return null;
    const t = rank(accounts.map(a => ({ provider: "anthropic" as const, accountId: a.id })), x => pool.canServe(x.accountId, model), metrics, mode);
    return t ? accounts.find(a => a.id === t.accountId) ?? null : null;
  };
  return {
    metrics,
    usable: (t, model) => t.provider === "anthropic" ? pool.canServe(t.accountId, model) : openAI(t.accountId),
    retainable: (t, model) => t.provider === "anthropic" ? pool.canRetain(t.accountId, model) : openAI(t.accountId),
    failoverPick: (tried, model) => {
      let candidates = pool.getAll().filter(a => !tried.has(a.id) && pool.canServe(a.id, model));
      const pick = ranked(candidates, model, "score");
      if (pick) return pick;
      // Before relaying a refusal: a seat whose refresh token died but whose
      // access token still works (TokenPool.canServeLastResort).
      if (candidates.length === 0) candidates = pool.getAll().filter(a => !tried.has(a.id) && pool.canServeLastResort(a.id, model));
      if (candidates.length === 0) return null;
      return candidates.reduce((best, a) => (worstWindowUtil(a.rateLimits) < worstWindowUtil(best.rateLimits) ? a : best));
    },
    pickForRequest: model => ranked(pool.getAll().filter(a => pool.canServe(a.id, model)), model, "rotate"),
  };
}

/**
 * The Anthropic account a request should stay on, given the pin the session
 * router already decided to keep.
 *
 * Judged with `canRetain`, not `canServe`: the router has just held this pin
 * through `canRetain`, so re-testing it with the stricter placement predicate
 * would discard the pin the moment the account is merely mid-request, and the
 * conversation would round-robin onto another account and re-write its whole
 * prompt cache. Measured at 670K tokens for one session that bounced
 * intrect -> kyte -> intrect inside 51 seconds. The two predicates must agree
 * about retention or the pin is decided twice, by different rules.
 */
export function pinnedAnthropicAccount(
  pool: Pick<TokenPool, "canRetain" | "getById">,
  target: SessionTarget | undefined,
  model?: string,
): Account | undefined {
  if (target?.provider !== "anthropic") return undefined;
  return pool.canRetain(target.accountId, model) ? pool.getById(target.accountId) : undefined;
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
