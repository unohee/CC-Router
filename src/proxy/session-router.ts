import { FIVE_HOUR_SEC, NO_PACE, paceRatio, weeklyPace, type WeeklyPace, type WeeklyPaceConfig } from "./weekly-pace.js";

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
  /** When the pin was placed or last moved. Absent in snapshots from before
   *  it was kept; `restore` then takes `lastSeen`, so a restored pin keeps
   *  its dwell either way. */
  pinnedAt?: number;
}

/** One request counted as load (`noteRequest`), for a snapshot. */
export interface LoadSnapshotEntry {
  at: number;
  provider: SessionTarget["provider"];
  accountId: string;
  weight: number;
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
  /** How full the seat's admission gate is right now: requests in flight over
   *  the slots the throttle allows it at its utilization (0 = idle, 1 = full,
   *  above 1 = queueing). Absent means unknown, read as 0. Read only by the
   *  balance rules: a seat whose queue is full cannot absorb a new session
   *  however much of its week is left. */
  saturation?: number;
}

/** Why an existing session left its target. */
export type ReassignReason = "unservable" | "soft-cap" | "weekly-pace";

/** What placement sees for one seat (SessionRouter.explain). */
export interface SeatExplanation {
  /** Pace ratio of the 7-day window (paceRatio in weekly-pace.ts); null with no window. */
  weekRatio: number | null;
  /** The same for the 5-hour window. */
  fiveHourRatio: number | null;
  /** On pace on every paced window. */
  onPace: boolean;
  /** At or past the soft cap on its binding window. */
  overCap: boolean;
  /** Could take a new session now (the caller's usable predicate). */
  usable: boolean;
  /** The load the score divides by: requests in the last ten minutes, as sessions. */
  load: number;
  /** The balance score (cost-weighted tokens left per hour to the weekly reset, scaled). */
  score: number;
  /** Where a new session would be placed: 1 first. */
  rank: number;
  /** In the set a new session is placed from right now. */
  placeable: boolean;
}

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
/** Balance rules: when every seat under the cap is behind its weekly pace,
 *  no tier applies and the weekly ratio enters the score as a factor,
 *  ratio^PACE_POWER. A tie band on the best ratio was tried first and is what
 *  the first live hour showed (2026-11-19): it left one seat placeable while
 *  the size-and-load score rated another 8x higher. */
const PACE_POWER = 1;
/** Balance rules: a seat's score is divided by (1 + saturation)^this. The
 *  live finding behind it (2026-11-19): one seat at 4/4 in flight with 501
 *  waits in an hour kept taking every new session while two seats had 8 free
 *  slots; the request-rate load term alone did not stop it. Chosen in the
 *  balance simulator on the run-2 pools: 2 / 4 gave all-ahead queue wait
 *  15,581 / 8,868 s (baseline 23,871) with every other pool better too. */
const SATURATION_POWER = 4;
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
/** Balance rules: load on a seat is the requests it was given in this
 *  window, pinned or not (`noteRequest`), scaled to the count of sessions
 *  that would produce it at one request a minute. A pin that has gone quiet
 *  adds nothing; a request with no session adds the same as a pinned one. */
const LOAD_WINDOW_MS = 10 * 60 * 1000;
/** Balance rules: a seat takes a pin shed over the soft cap only with this
 *  much of its binding window below the cap; a seat just under it would be
 *  over it a few requests later and shed the pin again, and every move is a
 *  cache rewrite. Chosen in the balance simulator together with
 *  FIVE_HOUR_ROOM_POWER on the five-hour-bound pool: 0.2 / 0.3 / 0.4 / 0.5
 *  gave 669 / 650 / 639 / 647 rewrites (baseline 651), totals
 *  1419M / 1455M / 1386M / 1404M. */
const CAP_RELIEF_ROOM = 0.4;
/** Balance rules: how strongly a seat's five-hour headroom scales its score.
 *  Squared: a session stays for hours, so a seat whose five-hour window is
 *  half spent should rank well below one with a fresh window, not at half.
 *  1 / 2 / 3 gave 699 / 669 / 716 rewrites on the five-hour-bound pool at
 *  CAP_RELIEF_ROOM 0.2. */
const FIVE_HOUR_ROOM_POWER = 2;
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
  /** Rotation for requests with no session (`rank` in rotate mode), kept
   *  apart from `cursor` so they do not disturb the rotation among tied seats
   *  that spreads sessions. */
  private requestCursor = 0;
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
          this.noteRequest(existing.target);
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
    // A session just placed is about to send more: it counts as one session's
    // worth of requests for the window, not as the single request it is.
    this.noteRequest(target, LOAD_WINDOW_MS / 60_000);
    this.onAssignmentsChanged?.();
    return target;
  }

  /**
   * The seat the balance rules would place a new session on, for a caller
   * that has no session to pin: a request without a session id, or the
   * failover pick. Returns null when nothing is usable, and under the legacy
   * rules (the caller keeps its own order). Does not pin; the request is
   * counted as load on the seat (`noteRequest`), which is what spreads a run
   * of them.
   */
  rank(
    candidates: SessionTarget[],
    isUsable: (target: SessionTarget) => boolean,
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
    mode: "score" | "rotate" = "score",
  ): SessionTarget | null {
    if (!this.balanced) return null;
    const usable = candidates.filter(isUsable);
    if (usable.length === 0) return null;
    const chosen = this.placeBalanced(usable, utilOf, mode);
    // A request without a session counts here. The failover pick (score
    // mode) does not: the caller pins the session to the seat that answers
    // (`pinTo`), which counts it once as a session's worth.
    if (mode === "rotate") this.noteRequest(chosen);
    return chosen;
  }

  /**
   * What placement sees for each of `candidates` right now, for health: the
   * pace ratio of each window, whether the seat is on pace, the load the score
   * divides by, the score itself, and the rank a new session would be placed
   * by (1 is first; seats over the cap or filtered out by pace rank after the
   * rest in the order the score gives them). Null under the legacy rules.
   * Reads only; it does not pin, count or rotate.
   */
  explain(
    candidates: SessionTarget[],
    isUsable: (target: SessionTarget) => boolean,
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): Map<string, SeatExplanation> | null {
    if (!this.balanced) return null;
    const out = new Map<string, SeatExplanation>();
    const usable = candidates.filter(isUsable);
    const underCap = usable.filter(t => !this.overSoftCap(t, utilOf));
    const load = this.loadOf(candidates);
    // The same narrowing placeBalanced applies, so the rank is the real order.
    let pool = underCap;
    let behind = false;
    if (this.weeklyPace && pool.length > 1) {
      const tiered = this.paceTier(pool, utilOf);
      pool = tiered.pool;
      behind = tiered.behind;
    }
    const inPool = new Set(pool.map(targetKey));
    const scored = candidates.map(t => {
      const p = this.paceRatios(t, utilOf);
      const base = this.balanceScore(t, utilOf, load);
      return {
        t, key: targetKey(t), pace: p,
        usable: usable.includes(t), overCap: this.overSoftCap(t, utilOf),
        load: load.get(targetKey(t)) ?? 0,
        score: behind ? base * this.paceFactor(t, utilOf) : base,
      };
    });
    // Rank: the pool first by score, then the rest by score.
    const order = [...scored].sort((a, b) => {
      const pa = inPool.has(a.key) ? 0 : a.usable ? 1 : 2;
      const pb = inPool.has(b.key) ? 0 : b.usable ? 1 : 2;
      return pa - pb || b.score - a.score;
    });
    order.forEach((s, i) => {
      out.set(s.key, {
        weekRatio: s.pace.week, fiveHourRatio: s.pace.five, onPace: s.pace.onPace,
        overCap: s.overCap, usable: s.usable, load: Math.round(s.load * 100) / 100,
        score: s.score, rank: i + 1, placeable: inPool.has(s.key),
      });
    });
    return out;
  }

  /**
   * Pin `sessionId` to `target` as the seat that answered it, after failover
   * served the request there. The pin the session had was unusable (that is
   * why failover ran) and would have been re-placed on the next request,
   * possibly onto a third seat: two cache rewrites where one will do. No-op
   * when the session is already there.
   */
  pinTo(sessionId: string, target: SessionTarget): void {
    this.noteRequest(target, LOAD_WINDOW_MS / 60_000);
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
      ...(a.pinnedAt !== undefined ? { pinnedAt: a.pinnedAt } : {}),
    }));
  }

  /**
   * The load window (`noteRequest`), for surviving a reload with the pins.
   * Without it every seat reads as idle for ten minutes after each deploy,
   * and the first sessions placed then all land on the top-scored seat.
   */
  loadSnapshot(): LoadSnapshotEntry[] {
    const since = this.now() - LOAD_WINDOW_MS;
    return this.requests.filter(r => r.at >= since).map(r => {
      const [provider, accountId] = r.key.split(":", 2) as [SessionTarget["provider"], string];
      return { at: r.at, provider, accountId, weight: r.weight };
    });
  }

  /** Reload the load window. Entries outside the window, or malformed, are dropped. */
  restoreLoad(entries: readonly LoadSnapshotEntry[]): void {
    const since = this.now() - LOAD_WINDOW_MS;
    const kept = entries
      .filter(e => e && typeof e.at === "number" && e.at >= since && e.at <= this.now()
        && (e.provider === "anthropic" || e.provider === "openai") && typeof e.accountId === "string"
        && typeof e.weight === "number" && Number.isFinite(e.weight) && e.weight > 0)
      .map(e => ({ at: e.at, key: targetKey({ provider: e.provider, accountId: e.accountId }), weight: e.weight }));
    this.requests.splice(0, 0, ...kept);
    this.requests.sort((a, b) => a.at - b.at);
    while (this.requests.length > MAX_TRACKED_SESSIONS) this.requests.shift();
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
      // A restored pin keeps its dwell: without pinnedAt the 30-minute dwell
      // check was skipped, and every pin could move for pace on its first
      // request after a deploy.
      this.assignments.set(entry.sessionId, {
        target: { provider: entry.provider, accountId: entry.accountId },
        lastSeen: entry.lastSeen,
        pinnedAt: typeof entry.pinnedAt === "number" && Number.isFinite(entry.pinnedAt) ? entry.pinnedAt : entry.lastSeen,
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
   * Load on each of `targets`.
   *
   * Legacy rules: live sessions pinned there, idle ones included.
   *
   * Balance rules: the requests each seat was given in the last
   * LOAD_WINDOW_MS, pinned or not, as the number of sessions that would send
   * them at one a minute. An idle pin is then no load (it holds no request),
   * and a request with no session id counts the same as a pinned one, so a
   * run of them is spread like sessions are. Counting pins and leaving the
   * idle ones out was tried first and made the five-hour-bound pool worse
   * (a quiet pin usually comes back, and new sessions stacked onto the seat
   * holding the most of them); counting requests instead is what both rules
   * needed.
   */
  private loadOf(targets: SessionTarget[]): Map<string, number> {
    const load = new Map<string, number>();
    for (const target of targets) load.set(targetKey(target), 0);
    if (this.balanced) {
      const since = this.now() - LOAD_WINDOW_MS;
      while (this.requests.length > 0 && this.requests[0].at < since) this.requests.shift();
      const perSession = LOAD_WINDOW_MS / 60_000;
      for (const r of this.requests) {
        const current = load.get(r.key);
        if (current !== undefined) load.set(r.key, current + r.weight / perSession);
      }
      return load;
    }
    for (const assignment of this.assignments.values()) {
      const key = targetKey(assignment.target);
      const current = load.get(key);
      if (current !== undefined) load.set(key, current + 1);
    }
    return load;
  }

  /** Requests given to each seat, newest last, for the balance load. */
  private readonly requests: Array<{ at: number; key: string; weight: number }> = [];

  /**
   * Count a request given to `target`, with or without a session. The server
   * calls this for every request it routes; `resolve` and `rank` call it for
   * the seat they return, so a caller that routes only through them need not.
   */
  noteRequest(target: SessionTarget, weight = 1): void {
    if (!this.balanced) return;
    this.requests.push({ at: this.now(), key: targetKey(target), weight });
    if (this.requests.length > MAX_TRACKED_SESSIONS) this.requests.shift();
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
    return w ? paceRatio(w.util, w.resetAtSec, this.now(), windowSec) : null;
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
   *        (cap - weeklyUtil) x size / max(hoursToWeeklyReset, 1) x (cap - fiveHourUtil)^2 / (1 + load) / (1 + saturation)^4
   *
   *    `saturation` is the seat's admission gate: requests in flight over the
   *    slots the throttle allows it. A full queue cannot absorb a session
   *    however much week is left. When every seat is behind its weekly pace
   *    the score is also multiplied by the seat's weekly pace ratio (`paceTier`).
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
    mode: "score" | "rotate" = "score",
  ): SessionTarget {
    const cap = this.softCapUtil ?? 1;
    const utilOnly = (t: SessionTarget) => this.metricsOf(t, utilOf).util;
    let pool = usable.filter(t => !this.overSoftCap(t, utilOf));
    if (mode === "rotate") {
      // A request with no session: the seats under the cap in turn, and when
      // none is, every usable seat in turn. It leaves no cache behind and is
      // failed over if refused, so it is the right thing to spend a seat's
      // last stretch under the cap on; it is not paced (pace keeps a seat for
      // the sessions that will live on it; a one-off request does not).
      const ring = pool.length > 0 ? pool : usable;
      const chosen = ring[this.requestCursor % ring.length];
      this.requestCursor = (this.requestCursor + 1) % Math.max(ring.length, 1);
      return chosen;
    }
    if (pool.length === 0) return this.leastLoaded(usable, utilOf ? utilOnly : undefined);

    let behind = false;
    if (this.weeklyPace && pool.length > 1) {
      const tiered = this.paceTier(pool, utilOf);
      pool = tiered.pool;
      behind = tiered.behind;
    }

    const load = this.loadOf(pool);
    const score = (t: SessionTarget): number => this.balanceScore(t, utilOf, load);

    const scores = pool.map(t => behind ? score(t) * this.paceFactor(t, utilOf) : score(t));
    const best = Math.max(...scores);
    const tied = pool.filter((_, i) => best - scores[i] <= Math.abs(best) * 1e-9);
    const chosen = tied[this.cursor % tied.length];
    this.cursor = (this.cursor + 1) % Math.max(tied.length, 1);
    return chosen;
  }

  /**
   * Balance rules: the seats a new session is placed from, by pace. Seats on
   * pace on every paced window come first; then seats not ahead on their
   * week (a five-hour burst refills within hours). When every seat is behind
   * on its week, all of them compete, and the score is scaled by each seat's
   * weekly pace ratio (`paceFactor`) so pace still counts without ever
   * narrowing the choice to one seat. A seat with no weekly reading counts as
   * on pace only while no measured seat under the cap exists: a fresh seat
   * (or one the router has never read) must take work to produce a reading,
   * but must not take every session while measured seats have room.
   */
  private paceTier(
    pool: SessionTarget[],
    utilOf?: (target: SessionTarget) => number | TargetMetrics,
  ): { pool: SessionTarget[]; behind: boolean } {
    const paces = pool.map(t => this.paceRatios(t, utilOf));
    const measured = pool.filter((_, i) => paces[i].week !== null);
    const among = measured.length > 0 ? measured : pool;
    const amongPaces = among.map(t => paces[pool.indexOf(t)]);
    const onPace = among.filter((_, i) => amongPaces[i].onPace);
    const weekOk = among.filter((_, i) => !amongPaces[i].weekAhead);
    if (onPace.length > 0) return { pool: onPace, behind: false };
    if (weekOk.length > 0) return { pool: weekOk, behind: false };
    return { pool: among, behind: true };
  }

  /** The weekly pace ratio as a score factor (1 with no reading), to PACE_POWER. */
  private paceFactor(t: SessionTarget, utilOf?: (target: SessionTarget) => number | TargetMetrics): number {
    const week = this.windowRatio(this.metricsOf(t, utilOf).weekly, WEEK_SEC);
    return week === null ? 1 : Math.pow(Math.max(week, 1e-3), PACE_POWER);
  }

  /** The balance score of one seat (see placeBalanced), given the load map. */
  private balanceScore(
    t: SessionTarget,
    utilOf: ((target: SessionTarget) => number | TargetMetrics) | undefined,
    load: Map<string, number>,
  ): number {
    const cap = this.softCapUtil ?? 1;
    const nowSec = this.now() / 1000;
    const m = this.metricsOf(t, utilOf);
    const week = m.weekly && m.weekly.resetAtSec && m.weekly.resetAtSec > nowSec ? m.weekly : null;
    const util = week ? week.util : m.weekly?.util ?? 0;
    const ttrMin = week ? (week.resetAtSec! - nowSec) / 60 : WEEK_SEC / 60;
    const five = m.fiveHour && m.fiveHour.resetAtSec && m.fiveHour.resetAtSec > nowSec ? m.fiveHour : null;
    const fiveRoom = five ? Math.pow(Math.min(1, Math.max(0, cap - five.util)), FIVE_HOUR_ROOM_POWER) : 1;
    const size = typeof m.size === "number" && Number.isFinite(m.size) && m.size > 0 ? m.size : 1;
    const sat = typeof m.saturation === "number" && Number.isFinite(m.saturation) && m.saturation > 0 ? m.saturation : 0;
    return Math.max(0, cap - util) * size / Math.max(ttrMin, BALANCE_MIN_TTR_MIN) * fiveRoom
      / (1 + (load.get(targetKey(t)) ?? 0)) / Math.pow(1 + sat, SATURATION_POWER);
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
