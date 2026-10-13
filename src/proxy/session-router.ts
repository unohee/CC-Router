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
}

/** Why an existing session left its target. */
export type ReassignReason = "unservable" | "soft-cap";

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
  /** Fired when an existing session is moved to a different target. */
  onReassign?: (info: { sessionId: string; from: SessionTarget; to: SessionTarget; reason: ReassignReason }) => void;
  /** Fired whenever the assignment set changes, so it can be persisted. */
  onAssignmentsChanged?: () => void;
}

interface Assignment {
  target: SessionTarget;
  lastSeen: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** Assumed time-to-reset for a target with no open window: a fresh window is
 *  taken to start on first use and last five hours. */
const UNOPENED_WINDOW_MIN = 5 * 60;
/** Floor on time-to-reset, so a window seconds from rolling over does not
 *  score as unbounded capacity. */
const MIN_TTR_MIN = 5;
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
  private readonly onReassign?: SessionRouterOptions["onReassign"];
  private readonly onAssignmentsChanged?: SessionRouterOptions["onAssignmentsChanged"];

  constructor(opts: SessionRouterOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    const cap = opts.softCapUtil;
    this.softCapUtil = typeof cap === "number" && cap > 0 && cap < 1 ? cap : null;
    this.onReassign = opts.onReassign;
    this.onAssignmentsChanged = opts.onAssignmentsChanged;
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
        || !candidates.some(c => !sameTarget(c, existing.target) && isUsable(c) && !this.overSoftCap(c, utilOf))) {
        existing.lastSeen = this.now();
        // Refreshing the timestamp is itself a change worth persisting: a busy
        // long-lived session never re-assigns, so without this its snapshot
        // keeps the timestamp of its first request and restores as expired.
        this.onAssignmentsChanged?.();
        return existing.target;
      }
      reason = "soft-cap";
    }

    const usable = candidates.filter(isUsable);
    if (usable.length === 0) return null;

    const target = this.place(usable, utilOf);

    if (existing && !sameTarget(existing.target, target)) {
      this.onReassign?.({ sessionId, from: existing.target, to: target, reason });
    }

    this.assignments.set(sessionId, { target, lastSeen: this.now() });
    this.onAssignmentsChanged?.();
    return target;
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

  /** Live sessions pinned to each of `targets`. */
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
    const cap = this.softCapUtil;
    const utilOnly = (t: SessionTarget) => this.metricsOf(t, utilOf).util;
    if (cap === null) return this.leastLoaded(usable, utilOf ? utilOnly : undefined);

    const preferred = usable.filter(t => !this.overSoftCap(t, utilOf));
    if (preferred.length === 0) return this.leastLoaded(usable, utilOf ? utilOnly : undefined);

    const load = this.loadOf(preferred);
    const nowSec = this.now() / 1000;
    const score = (t: SessionTarget): number => {
      const { util, resetAtSec } = this.metricsOf(t, utilOf);
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
