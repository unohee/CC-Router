import { FIVE_HOUR_SEC, NO_PACE, weeklyPace, type WeeklyPace, type WeeklyPaceConfig } from "./weekly-pace.js";

/** A routable destination for one Claude Code session. */
export interface SessionTarget {
  provider: "anthropic" | "openai";
  accountId: string;
}

/** One persisted assignment. Flat by design — it is written to disk as JSON. */
export interface SessionSnapshotEntry {
  sessionId: string;
  provider: SessionTarget["provider"];
  accountId: string;
  lastSeen: number;
}

/**
 * What a target's quota looks like right now. A bare number is accepted
 * wherever this is, meaning utilization only, with no reset time known.
 */
export interface TargetMetrics {
  /** Fraction of the binding quota window already spent (0–1). */
  util: number;
  /** When that window resets, epoch seconds. Absent or 0 means no window is
   *  open (or none is known). */
  resetAtSec?: number;
  /** The window placement ranks by, when it differs from the binding one.
   *  Utilizations of different windows are fractions of different quotas, so
   *  ranking must compare every target on the same window. Absent means rank by
   *  `util`/`resetAtSec`. The soft-cap check always uses `util`. */
  pace?: { util: number; resetAtSec?: number };
  /** The 7-day window, for weekly pacing. Absent means no weekly window is
   *  known, which reads as on pace. */
  weekly?: { util: number; resetAtSec?: number };
  /** The 5-hour window, paced when `fiveHour` pacing is on. */
  fiveHour?: { util: number; resetAtSec?: number };
  /** The seat's weekly quota relative to a typical seat (seat-size.ts), so
   *  shares of different seats compare as amounts. Absent means 1. Read only
   *  by the balance rules. */
  size?: number;
}

/** Why an existing session left its target. */
export type ReassignReason = "unservable" | "soft-cap" | "weekly-pace";

export interface SessionRouterOptions {
  /** How long an unused assignment survives. Default 1 hour. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /**
   * Utilization (0–1) above which a target stops taking new sessions and its
   * pinned sessions move elsewhere — but only while some other target is still
   * below it. Disabled unless strictly between 0 and 1, which keeps placement
   * exactly as it was. See `resolve` for why this is a preference, not a ban.
   */
  softCapUtil?: number;
  /**
   * Weekly pacing (opt-in). Seats spending their 7-day window faster than the
   * week elapses take new sessions only after on-pace seats, and a pin on a
   * seat far ahead moves to an on-pace seat. Pace never makes a seat unusable.
   * A function is read on every decision, so the demand governor can turn
   * pacing on and off without a restart.
   */
  weeklyPace?: WeeklyPaceConfig | (() => WeeklyPaceConfig | null | undefined);
  /**
   * How seats are judged once `softCapUtil` or `weeklyPace` is set. True (the
   * default) uses the balance rules: the cap filters before pace, pace is a
   * ratio that holds up to the reset, the two windows are paced separately,
   * and new sessions rank on the weekly window's headroom per hour to its
   * reset. False keeps the rules as they were before them
   * (`routing.balance.legacy`). With neither key set this has no effect.
   */
  balance?: boolean;
  /** Fired when an existing session is moved to a different target. */
  onReassign?: (info: { sessionId: string; from: SessionTarget; to: SessionTarget; reason: ReassignReason }) => void;
  /** Fired whenever the assignment set changes, so it can be persisted. */
  onAssignmentsChanged?: () => void;
}

interface Assignment {
  target: SessionTarget;
  lastSeen: number;
  /** When the pin was placed or last moved; absent for restored pins. */
  pinnedAt?: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** Assumed time-to-reset for a target with no open window: a fresh window is
 *  taken to start on first use and last five hours. */
const UNOPENED_WINDOW_MIN = 5 * 60;
/** A pin past the soft cap whose window resets within this many minutes is
 *  kept: the quota is about to refill, and moving would pay a full cache
 *  rewrite to avoid a few minutes on a hot account. */
const SOFT_CAP_GRACE_MIN = 15;
/** Seats within this much of the least-ahead seat count as tied when every
 *  usable seat is ahead of pace, so placement still spreads across them. */
const PACE_TIE = 0.02;
/** Floor on time-to-reset, so a window seconds from rolling over does not
 *  score as unbounded capacity. */
const MIN_TTR_MIN = 5;
/** Balance rules: floor on the weekly window's time-to-reset in the score.
 *  The last hour of a week still ranks high (its quota is about to be lost),
 *  but no longer as a spike that takes every new session. */
const BALANCE_MIN_TTR_MIN = 60;
/** Balance rules: when every seat is ahead of its weekly pace, seats within
 *  this much of the best pace ratio count as tied. */
const PACE_RATIO_TIE = 0.05;
const WEEK_SEC = 7 * 24 * 60 * 60;
/** Balance rules: a pin is not moved for pace within this long of being
 *  placed or last moved. Every move is a cache rewrite, and the window that
 *  prompted one takes time to show the effect. */
const MIN_DWELL_MS = 30 * 60 * 1000;
/** Balance rules: a seat is "dry before reset" when its week is projected to
 *  run out this far ahead of the reset or more, by the even-spend ratio
 *  (`windowRatio`): r < 1 - DRY_MARGIN. */
const DRY_MARGIN = 0.25;
/** Balance rules: the seat a pin moves to must have this much more pace
 *  ratio than the one it leaves, or the move chases noise. */
const SURPLUS_MARGIN = 0.35;
/** Balance rules: a seat takes a pin shed over the soft cap only with this
 *  much of its binding window below the cap; a seat just under it would be
 *  over it a few requests later and shed the pin again. Chosen in the balance
 *  simulator: 0.05 / 0.1 / 0.2 gave 645 / 609 / 659 rewrites on the
 *  five-hour-bound pool (baseline 651). */
const CAP_RELIEF_ROOM = 0.1;
/** Safety valve: a router that never forgets would grow without bound. */
const MAX_TRACKED_SESSIONS = 10_000;

function sameTarget(a: SessionTarget, b: SessionTarget): boolean {
  return a.provider === b.provider && a.accountId === b.accountId;
}

function targetKey(t: SessionTarget): string {
  return `${t.provider}:${t.accountId}`;
}

/**
 * Pins each Claude Code session to one account for as long as that account can
 * serve it.
 *
 * Round-robin across *requests* defeats prompt caching: Claude Code resends the
 * whole conversation every turn and relies on the cached prefix, but the cache
 * lives with the account that wrote it, so spreading one conversation over N
 * accounts makes each of them re-write the prefix. Pinning per session keeps the
 * cache warm while still spreading *different* sessions across the pool.
 *
 * Availability wins over cache locality: if the pinned target can no longer
 * serve (rate-limited, disabled, removed), the session is reassigned rather than
 * made to wait. That costs one cache write, which beats a stalled request.
 */
export class SessionRouter {
  private readonly assignments = new Map<string, Assignment>();
  private cursor = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly softCapUtil: number | null;
  private readonly paceSource: () => WeeklyPaceConfig | null;
  private readonly balance: boolean;
  private readonly onReassign?: SessionRouterOptions["onReassign"];
  private readonly onAssignmentsChanged?: SessionRouterOptions["onAssignmentsChanged"];

  constructor(opts: SessionRouterOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    const cap = opts.softCapUtil;
    this.softCapUtil = typeof cap === "number" && cap > 0 && cap < 1 ? cap : null;
    const pace = opts.weeklyPace;
    this.paceSource = typeof pace === "function" ? () => pace() ?? null : () => pace ?? null;
    this.onReassign = opts.onReassign;
    this.onAssignmentsChanged = opts.onAssignmentsChanged;
    this.balance = opts.balance !== false;
  }

  /**
   * Resolve the target for `sessionId`, assigning one on first sight.
   *
   * `candidates` is the full set of targets that exist right now; `isUsable`
   * decides which of them can take traffic at this instant. Assignment is made
   * from the usable subset, so a session is never pinned to a target that is
   * already unavailable. Returns null only when nothing is usable — the caller
   * then falls back to its own (degraded) selection.
   */
  resolve(
    sessionId: string,
    candidates: SessionTarget[],
    isUsable: (target: SessionTarget) => boolean,
    /** The target's quota: utilization, optionally with its reset time.
     *  Absent means "unknown", treated as 0 — an unmeasured target has to take
     *  work before it can produce a reading. */
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
    /** Whether an EXISTING pin may be kept. Defaults to `isUsable`. Separated
     *  because holding a pin tolerates transient states that would rightly
     *  disqualify a target for a new session. */
    isRetainable?: (target: SessionTarget) => boolean,
  ): SessionTarget | null {
    this.sweep();

    const existing = this.assignments.get(sessionId);
    let reason: ReassignReason = "unservable";
    if (existing && (isRetainable ?? isUsable)(existing.target)) {
      // A pin past the soft cap is given up only when another target has room
      // below it. Otherwise it stays: once every target is hot, moving buys
      // nothing but a cache rewrite, and the last stretch of each window should
      // still be spent here rather than declared unusable — which would also
      // tip the caller into cross-provider fallback.
      if (!this.overSoftCap(existing.target, utilOf)
        || this.resetsWithin(existing.target, SOFT_CAP_GRACE_MIN, utilOf)
        || !candidates.some(c => this.softCapRelief(c, existing.target, isUsable, utilOf))) {
        if (!this.shouldLeaveForPace(existing.target, candidates, isUsable, utilOf, existing.pinnedAt)) {
          existing.lastSeen = this.now();
          // Refreshing the timestamp is itself a change worth persisting: a busy
          // long-lived session never re-assigns, so without this its snapshot
          // keeps the timestamp of its first request and restores as expired.
          this.onAssignmentsChanged?.();
          return existing.target;
        }
        reason = "weekly-pace";
      } else {
        reason = "soft-cap";
      }
    }

    // A soft-cap move stays within the provider: the session's cache is lost
    // either way, but switching the model that answers mid-conversation is a
    // bigger disruption than the 429 the move exists to prevent.
    // A weekly-pace move is held to the same rule, and goes only to seats on pace.
    const usable = reason === "soft-cap"
      ? candidates.filter(c => this.softCapRelief(c, existing!.target, isUsable, utilOf))
      : reason === "weekly-pace"
        ? candidates.filter(c => this.paceRelief(c, existing!.target, isUsable, utilOf))
        : candidates.filter(isUsable);
    if (usable.length === 0) return null;

    const target = this.place(usable, utilOf);

    if (existing && !sameTarget(existing.target, target)) {
      this.onReassign?.({ sessionId, from: existing.target, to: target, reason });
    }

    this.assignments.set(sessionId, { target, lastSeen: this.now(), pinnedAt: this.now() });
    this.onAssignmentsChanged?.();
    return target;
  }

  /**
   * The seat the balance rules would place a new session on, for a caller
   * that has no session to pin: the failover pick. Returns null when nothing
   * is usable, and under the legacy rules (the caller keeps its own order).
   * Does not pin.
   *
   * Not used for requests without a session id. They leave no pin for the
   * load term to see, so a run of them all lands on the top-scored seat; in
   * the balance simulator (2026-11-19) ranking them cost the five-hour-bound
   * pool 121M against 5M gained on the no-session-id pool, with or without
   * counting the last minute of them as load. TokenPool.getNext's round-robin
   * spreads them, and stays.
   */
  rank(
    candidates: SessionTarget[],
    isUsable: (target: SessionTarget) => boolean,
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): SessionTarget | null {
    if (!this.balanced) return null;
    const usable = candidates.filter(isUsable);
    if (usable.length === 0) return null;
    return this.placeBalanced(usable, utilOf);
  }

  /**
   * Pin `sessionId` to `target` as the seat that answered it, after failover
   * served the request there. The pin the session had was unusable (that is
   * why failover ran) and would have been re-placed on the next request,
   * possibly onto a third seat: two cache rewrites where one will do. No-op
   * when the session is already there.
   */
  pinTo(sessionId: string, target: SessionTarget): void {
    const existing = this.assignments.get(sessionId);
    if (existing && sameTarget(existing.target, target)) { existing.lastSeen = this.now(); return; }
    this.assignments.set(sessionId, { target, lastSeen: this.now(), pinnedAt: this.now() });
    this.onAssignmentsChanged?.();
  }

  /**
   * Move a session onto one of `candidates`, away from wherever it is now.
   *
   * Idempotent by design. Several in-flight requests for one session can each
   * discover their target is unusable and all call this; without the early
   * return the second caller deletes the assignment the first just made, and
   * `leastLoaded` hands back a different account — deterministically, since the
   * cursor has advanced. One cache rewrite becomes one per concurrent request.
   */
  repinOnto(
    sessionId: string,
    candidates: SessionTarget[],
    isUsable: (target: SessionTarget) => boolean,
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
    isRetainable?: (target: SessionTarget) => boolean,
  ): SessionTarget | null {
    // Sweep first, exactly as `resolve` does. Reading the map directly would
    // let the early return hand back an assignment the TTL has already
    // retired — correctness must not depend on the caller having swept.
    this.sweep();

    const keepable = isRetainable ?? isUsable;
    const existing = this.assignments.get(sessionId);
    if (existing && candidates.some(c => sameTarget(c, existing.target)) && keepable(existing.target)) {
      // Keeping a pin still counts as using it, same as `resolve`. Without this
      // the TTL would measure from the last re-placement rather than the last
      // request, and a busy session could be swept while actively serving.
      existing.lastSeen = this.now();
      this.onAssignmentsChanged?.();
      return existing.target;
    }

    this.forget(sessionId);
    return this.resolve(sessionId, candidates, isUsable, utilOf, isRetainable);
  }

  /**
   * Serialisable view of the live assignments, for surviving a restart.
   *
   * Losing these on restart is not merely a cosmetic reset: a live Claude Code
   * session gets reassigned, and its entire conversation is then re-written
   * into the new account's prompt cache — measured at 917K tokens for one
   * session, billed at 1.25x. Sessions must outlive the process that routes
   * them.
   */
  snapshot(): SessionSnapshotEntry[] {
    this.sweep();
    return [...this.assignments].map(([sessionId, a]) => ({
      sessionId,
      provider: a.target.provider,
      accountId: a.target.accountId,
      lastSeen: a.lastSeen,
    }));
  }

  /**
   * Reload assignments saved earlier. Entries already past the TTL are dropped
   * rather than revived — a session idle that long has no warm cache left to
   * protect, so pinning it would only constrain placement for nothing.
   *
   * Targets that no longer exist are kept as-is; `resolve` filters them through
   * `isUsable` and reassigns on the next request, so no validation is needed
   * against the current account list.
   */
  restore(entries: readonly SessionSnapshotEntry[]): void {
    const cutoff = this.now() - this.ttlMs;
    for (const entry of entries) {
      if (!entry?.sessionId || typeof entry.lastSeen !== "number") continue;
      if (entry.lastSeen < cutoff) continue;
      if (entry.provider !== "anthropic" && entry.provider !== "openai") continue;
      this.assignments.set(entry.sessionId, {
        target: { provider: entry.provider, accountId: entry.accountId },
        lastSeen: entry.lastSeen,
      });
    }
  }

  /** Assignment for a session, without creating or refreshing one. */
  peek(sessionId: string): SessionTarget | null {
    return this.assignments.get(sessionId)?.target ?? null;
  }

  /** Number of sessions currently pinned (post-sweep). Exposed for the dashboard. */
  size(): number {
    this.sweep();
    return this.assignments.size;
  }

  /**
   * Drop a session's assignment.
   *
   * Persists, because losing a deletion is not symmetric with losing an
   * addition: a stale snapshot restores the very pin the caller just decided
   * was wrong, and the session returns to an account that refuses it.
   */
  forget(sessionId: string): void {
    if (!this.assignments.delete(sessionId)) return;
    this.onAssignmentsChanged?.();
  }

  /**
   * Live sessions pinned to each of `targets`, idle ones included.
   *
   * Leaving out pins that had been quiet for ten minutes was tried in the
   * balance simulator (2026-11-19): a pin that goes quiet is likely to come
   * back, and once it no longer counts, a burst of new sessions lands on the
   * seat that holds the most of them, so the five-hour-bound pool scored worse
   * than with every pin counted (1498M vs 1377M), and the result swung with
   * the cut-off (20 min 1411M, 30 min 1503M, 45 min 1487M). Counting them at
   * half weight was worse too (1477M). The TTL sweep (an hour) is what retires
   * a pin whose session has really ended.
   */
  private loadOf(targets: SessionTarget[]): Map<string, number> {
    const load = new Map<string, number>();
    for (const target of targets) load.set(targetKey(target), 0);
    for (const assignment of this.assignments.values()) {
      const key = targetKey(assignment.target);
      const current = load.get(key);
      if (current !== undefined) load.set(key, current + 1);
    }
    return load;
  }

  private metricsOf(
    target: SessionTarget,
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): TargetMetrics {
    const m = utilOf?.(target);
    if (m === undefined) return { util: 0 };
    return typeof m === "number" ? { util: m } : m;
  }

  /** Whether `c` can take a session that `from` is shedding for the soft cap. */
  private softCapRelief(
    c: SessionTarget,
    from: SessionTarget,
    isUsable: (target: SessionTarget) => boolean,
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): boolean {
    if (!(c.provider === from.provider && !sameTarget(c, from) && isUsable(c) && !this.overSoftCap(c, utilOf))) return false;
    // Balance rules: a move over the cap is still a cache rewrite, so the
    // relief seat must have real room on the window that tripped the cap.
    if (this.balanced && this.softCapUtil !== null) {
      const room = this.softCapUtil - this.metricsOf(c, utilOf).util;
      if (room < CAP_RELIEF_ROOM) return false;
    }
    return true;
  }

  /** The pacing config in force right now, or null when pacing is off. */
  private get weeklyPace(): WeeklyPaceConfig | null { return this.paceSource(); }

  /** Pace of a target's weekly window, or null when pacing is off. */
  private paceOf(
    target: SessionTarget,
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): WeeklyPace | null {
    if (!this.weeklyPace) return null;
    const m = this.metricsOf(target, utilOf);
    const week = m.weekly
      ? weeklyPace(m.weekly.util, m.weekly.resetAtSec, this.now(), this.weeklyPace.slack)
      : NO_PACE;
    if (!this.weeklyPace.fiveHour || !m.fiveHour) return week;
    // The tighter window is what stops the seat, so the worse of the two counts.
    const five = weeklyPace(m.fiveHour.util, m.fiveHour.resetAtSec, this.now(),
      this.weeklyPace.fiveHourSlack, FIVE_HOUR_SEC);
    return five.ahead > week.ahead ? five : week;
  }

  /** Whether `c` can take a session that `from` is shedding for weekly pace. */
  private paceRelief(
    c: SessionTarget,
    from: SessionTarget,
    isUsable: (target: SessionTarget) => boolean,
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): boolean {
    const onPace = this.balanced
      ? this.paceRatios(c, utilOf).onPace
      : (this.paceOf(c, utilOf)?.ahead ?? 1) <= 0;
    return c.provider === from.provider && !sameTarget(c, from) && isUsable(c)
      && !this.overSoftCap(c, utilOf) && onPace;
  }

  /** Whether the balance rules are in force: on, and some rule configured. */
  private get balanced(): boolean {
    return this.balance && (this.softCapUtil !== null || this.weeklyPace !== null);
  }

  /**
   * Balance rules: a window's pace as a ratio,
   *
   *     r = share of the quota left / share of the window left
   *
   * 1 is an even spend; below 1 the seat is spending faster than the window
   * allows, above 1 it has quota to spare. Unlike the difference against a
   * line clamped at 1, the ratio does not go blind near the reset: a seat at
   * 98% with a sixth of its week left reads r = 0.12, where the old line read
   * it as on pace. Null when the window's reset is unknown or past (no pace).
   */
  private windowRatio(w: { util: number; resetAtSec?: number } | undefined, windowSec: number): number | null {
    const nowSec = this.now() / 1000;
    if (!w || !w.resetAtSec || w.resetAtSec <= nowSec || !Number.isFinite(w.util)) return null;
    const timeLeft = Math.min(1, (w.resetAtSec - nowSec) / windowSec);
    return Math.max(0, 1 - w.util) / Math.max(timeLeft, 1e-6);
  }

  /**
   * Balance rules: each window paced on its own. A seat is ahead on a window
   * when `r < 1 - slack` (the slack of that window); the weekly and five-hour
   * figures are never compared with each other, because they are shares of
   * different quotas over different spans.
   */
  private paceRatios(
    t: SessionTarget,
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): { week: number | null; five: number | null; weekAhead: boolean; fiveAhead: boolean; onPace: boolean } {
    const cfg = this.weeklyPace;
    const m = this.metricsOf(t, utilOf);
    const week = this.windowRatio(m.weekly, WEEK_SEC);
    const five = this.windowRatio(m.fiveHour, FIVE_HOUR_SEC);
    const weekAhead = !!cfg && week !== null && week < 1 - cfg.slack;
    const fiveAhead = !!cfg && cfg.fiveHour && five !== null && five < 1 - cfg.fiveHourSlack;
    return { week, five, weekAhead, fiveAhead, onPace: !weekAhead && !fiveAhead };
  }

  /**
   * A pin moves for weekly pace only when its seat is more than `migrateAhead`
   * past its line, its weekly window is not about to reset, and an on-pace
   * seat of the same provider can take the session. The move costs a full
   * cache rewrite, so it is reserved for seats that would otherwise run dry.
   */
  private shouldLeaveForPace(
    target: SessionTarget,
    candidates: SessionTarget[],
    isUsable: (target: SessionTarget) => boolean,
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
    pinnedAt?: number,
  ): boolean {
    const m = this.metricsOf(target, utilOf);
    const nowSec = this.now() / 1000;
    if (this.balanced) {
      // Only the weekly window moves a pin: a five-hour burst passes within the
      // hour, and moving on it would pay a cache rewrite to chase a window that
      // is about to refill (and could bounce the session back and forth).
      // A move needs the seat to be projected dry before its reset (its pace
      // ratio under 1 - DRY_MARGIN), another seat with a clear surplus over
      // it, and the pin to have dwelt here a while. The release is time-based:
      // the ratio rises as the week elapses, so a seat that stops spending is
      // on pace again without anything being reset by hand.
      if (!this.weeklyPace) return false;
      if (pinnedAt !== undefined && this.now() - pinnedAt < MIN_DWELL_MS) return false;
      const week = this.windowRatio(m.weekly, WEEK_SEC);
      if (week === null || week >= 1 - DRY_MARGIN) return false;
      const resetAt = m.weekly?.resetAtSec;
      if (resetAt && resetAt - nowSec <= SOFT_CAP_GRACE_MIN * 60) return false;
      return candidates.some(c => this.paceRelief(c, target, isUsable, utilOf)
        && (this.windowRatio(this.metricsOf(c, utilOf).weekly, WEEK_SEC) ?? Infinity) >= week + SURPLUS_MARGIN);
    }
    const pace = this.paceOf(target, utilOf);
    if (!pace || pace.ahead <= this.weeklyPace!.migrateAhead) return false;
    // Moving costs a cache rewrite; skip it when either window is about to refill.
    for (const resetAt of [m.weekly?.resetAtSec, this.weeklyPace!.fiveHour ? m.fiveHour?.resetAtSec : undefined]) {
      if (resetAt && resetAt > nowSec && resetAt - nowSec <= SOFT_CAP_GRACE_MIN * 60) return false;
    }
    return candidates.some(c => this.paceRelief(c, target, isUsable, utilOf));
  }

  /**
   * With pacing on, narrow `usable` to the seats on pace. When every seat is
   * ahead, keep those closest to their line. Never empty when `usable` is not:
   * pace reorders, it does not refuse.
   */
  private paceFilter(
    usable: SessionTarget[],
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): SessionTarget[] {
    if (!this.weeklyPace || usable.length <= 1) return usable;
    const aheads = usable.map(t => this.paceOf(t, utilOf)!.ahead);
    const onPace = usable.filter((_, i) => aheads[i] <= 0);
    if (onPace.length > 0) return onPace;
    const least = Math.min(...aheads);
    return usable.filter((_, i) => aheads[i] - least <= PACE_TIE);
  }

  private resetsWithin(
    target: SessionTarget,
    minutes: number,
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): boolean {
    const { resetAtSec } = this.metricsOf(target, utilOf);
    const nowSec = this.now() / 1000;
    return !!resetAtSec && resetAtSec > nowSec && resetAtSec - nowSec <= minutes * 60;
  }

  private overSoftCap(
    target: SessionTarget,
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): boolean {
    return this.softCapUtil !== null && this.metricsOf(target, utilOf).util >= this.softCapUtil;
  }

  /**
   * Choose a target for a new or displaced session from `usable`.
   *
   * With no soft cap configured this is `leastLoaded`, unchanged. With one,
   * targets below the cap are ranked by how fast they could absorb new work:
   *
   *     (softCap - util) / minutesToReset / (1 + liveSessions)
   *
   * Headroom alone is the wrong measure, because unspent quota is lost at the
   * reset: 60% left in a window closing in five minutes is worth more right
   * now than 80% left in one closing in three hours. A target with no open
   * window is assumed to open a full one on first use, so it ranks low and is
   * held in reserve; that keeps the accounts' windows staggered instead of
   * starting together and running out together. Dividing by live sessions
   * stands in for the load a reading cannot show yet — utilization only moves
   * once responses come back, so without it a burst of new sessions would all
   * land on one target.
   *
   * When every usable target is past the cap, placement falls back to
   * `leastLoaded`: there is no headroom left to rank by.
   */
  private place(
    usable: SessionTarget[],
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): SessionTarget {
    if (this.balanced) return this.placeBalanced(usable, utilOf);
    usable = this.paceFilter(usable, utilOf);
    const cap = this.softCapUtil;
    const utilOnly = (t: SessionTarget) => this.metricsOf(t, utilOf).util;
    if (cap === null) return this.leastLoaded(usable, utilOf ? utilOnly : undefined);

    const preferred = usable.filter(t => !this.overSoftCap(t, utilOf));
    if (preferred.length === 0) return this.leastLoaded(usable, utilOf ? utilOnly : undefined);

    const load = this.loadOf(preferred);
    const nowSec = this.now() / 1000;
    const score = (t: SessionTarget): number => {
      const m = this.metricsOf(t, utilOf);
      const { util, resetAtSec } = m.pace ?? m;
      const ttrMin = resetAtSec && resetAtSec > nowSec ? (resetAtSec - nowSec) / 60 : UNOPENED_WINDOW_MIN;
      return (cap - util) / Math.max(ttrMin, MIN_TTR_MIN) / (1 + (load.get(targetKey(t)) ?? 0));
    };

    const scores = preferred.map(score);
    const best = Math.max(...scores);
    // Relative tolerance: identical inputs must tie, and float noise must not
    // break the rotation between them.
    const tied = preferred.filter((_, i) => best - scores[i] <= Math.abs(best) * 1e-9);
    const chosen = tied[this.cursor % tied.length];
    this.cursor = (this.cursor + 1) % Math.max(tied.length, 1);
    return chosen;
  }

  /**
   * Placement under the balance rules.
   *
   * 1. The soft cap filters first: a seat past it takes a new session only
   *    when every usable seat is (then `leastLoaded`, as before). Pace used to
   *    run first and could narrow the choice to one seat that was over the cap.
   * 2. With pacing on, seats on pace on both windows go first; then seats
   *    ahead only on the five-hour window (it refills within hours); then the
   *    seats closest to their weekly pace.
   * 3. Among those, the most weekly headroom per hour to the weekly reset:
   *
   *        (cap - weeklyUtil) x size / max(hoursToWeeklyReset, 1) x (cap - fiveHourUtil) / (1 + liveSessions)
   *
   *    The soft cap and the score now read the same window: a seat at 97% of
   *    its week used to score on an idle five-hour window as if it had 98% to
   *    give. Quota a seat cannot spend before its weekly reset is lost, so the
   *    seat that must spend fastest to use it goes first. The five-hour
   *    headroom scales that down: a seat near its five-hour limit is stopped
   *    by it first, whatever its week holds (an unopened five-hour window
   *    counts as full). Tried in the balance simulator against a cut-off at
   *    30% and 50% of the window: proportional served the five-hour-bound
   *    pool best. A seat with no known weekly window is taken to have a full
   *    week ahead. `size` (seat-size.ts) turns the weekly share into an
   *    amount: 40% left on a seat twice the size is twice the tokens, so the
   *    score is the cost-weighted tokens left per hour to the weekly reset.
   */
  private placeBalanced(
    usable: SessionTarget[],
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): SessionTarget {
    const cap = this.softCapUtil ?? 1;
    const utilOnly = (t: SessionTarget) => this.metricsOf(t, utilOf).util;
    let pool = usable.filter(t => !this.overSoftCap(t, utilOf));
    if (pool.length === 0) return this.leastLoaded(usable, utilOf ? utilOnly : undefined);

    if (this.weeklyPace && pool.length > 1) {
      const paces = pool.map(t => this.paceRatios(t, utilOf));
      const onPace = pool.filter((_, i) => paces[i].onPace);
      const weekOk = pool.filter((_, i) => !paces[i].weekAhead);
      if (onPace.length > 0) pool = onPace;
      else if (weekOk.length > 0) pool = weekOk;
      else {
        const best = Math.max(...paces.map(p => p.week ?? 1));
        pool = pool.filter((_, i) => (paces[i].week ?? 1) >= best - PACE_RATIO_TIE);
      }
    }

    const load = this.loadOf(pool);
    const nowSec = this.now() / 1000;
    const score = (t: SessionTarget): number => {
      const m = this.metricsOf(t, utilOf);
      const week = m.weekly && m.weekly.resetAtSec && m.weekly.resetAtSec > nowSec ? m.weekly : null;
      const util = week ? week.util : m.weekly?.util ?? 0;
      const ttrMin = week ? (week.resetAtSec! - nowSec) / 60 : WEEK_SEC / 60;
      const five = m.fiveHour && m.fiveHour.resetAtSec && m.fiveHour.resetAtSec > nowSec ? m.fiveHour : null;
      const fiveRoom = five ? Math.min(1, Math.max(0, cap - five.util)) : 1;
      const size = typeof m.size === "number" && Number.isFinite(m.size) && m.size > 0 ? m.size : 1;
      return Math.max(0, cap - util) * size / Math.max(ttrMin, BALANCE_MIN_TTR_MIN) * fiveRoom
        / (1 + (load.get(targetKey(t)) ?? 0));
    };

    const scores = pool.map(score);
    const best = Math.max(...scores);
    const tied = pool.filter((_, i) => best - scores[i] <= Math.abs(best) * 1e-9);
    const chosen = tied[this.cursor % tied.length];
    this.cursor = (this.cursor + 1) % Math.max(tied.length, 1);
    return chosen;
  }

  /**
   * Pick the target carrying the fewest live sessions, breaking ties by
   * round-robin so equal candidates still rotate.
   *
   * Plain rotation counts assignments, not work: one session can send hundreds
   * of requests while another sends two, so rotating alone lets an account that
   * is already saturated take the next session anyway. Counting live sessions
   * per target is the closest proxy for load that assignment can see — it
   * cannot know how busy a session will turn out to be, but it can avoid
   * stacking new ones onto an account that already holds several.
   */
  private leastLoaded(
    usable: SessionTarget[],
    utilOf?: (target: SessionTarget) => number,
  ): SessionTarget {
    const load = this.loadOf(usable);

    let lightest = Infinity;
    for (const target of usable) lightest = Math.min(lightest, load.get(targetKey(target)) ?? 0);

    const tied = usable.filter(target => (load.get(targetKey(target)) ?? 0) === lightest);
    if (tied.length === 1) return tied[0];

    // Among equally-loaded targets, prefer the one with the most quota left.
    // Session count alone would keep feeding an account sitting at 80% of its
    // weekly window while another at 50% waits its turn.
    if (utilOf) {
      let best = tied[0];
      let bestUtil = utilOf(best);
      for (const target of tied.slice(1)) {
        const util = utilOf(target);
        if (util < bestUtil) { best = target; bestUtil = util; }
      }
      // Only commit to the quota ordering when it actually distinguishes them;
      // otherwise fall through to rotation so identical targets still alternate.
      if (tied.some(target => utilOf(target) !== bestUtil)) return best;
    }

    const chosen = tied[this.cursor % tied.length];
    this.cursor = (this.cursor + 1) % Math.max(tied.length, 1);
    return chosen;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, a] of this.assignments) {
      if (a.lastSeen < cutoff) this.assignments.delete(id);
    }

    // Map preserves insertion order, so the oldest surviving entries come first.
    let overflow = this.assignments.size - MAX_TRACKED_SESSIONS;
    if (overflow <= 0) return;
    for (const id of this.assignments.keys()) {
      this.assignments.delete(id);
      if (--overflow <= 0) break;
    }
  }
}
