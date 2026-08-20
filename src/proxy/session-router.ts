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

export interface SessionRouterOptions {
  /** How long an unused assignment survives. Default 1 hour. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Fired when an existing session is moved to a different target. */
  onReassign?: (info: { sessionId: string; from: SessionTarget; to: SessionTarget }) => void;
  /** Fired whenever the assignment set changes, so it can be persisted. */
  onAssignmentsChanged?: () => void;
}

interface Assignment {
  target: SessionTarget;
  lastSeen: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
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
  private readonly onReassign?: SessionRouterOptions["onReassign"];
  private readonly onAssignmentsChanged?: SessionRouterOptions["onAssignmentsChanged"];

  constructor(opts: SessionRouterOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
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
    /** Fraction of the binding quota window already spent (0–1). Used to break
     *  ties between equally-loaded targets so a nearly-exhausted account does
     *  not keep taking new work. Absent means "unknown", treated as 0. */
    utilOf?: (target: SessionTarget) => number,
    /** Whether an EXISTING pin may be kept. Defaults to `isUsable`. Separated
     *  because holding a pin tolerates transient states that would rightly
     *  disqualify a target for a new session. */
    isRetainable?: (target: SessionTarget) => boolean,
  ): SessionTarget | null {
    this.sweep();

    const existing = this.assignments.get(sessionId);
    if (existing && (isRetainable ?? isUsable)(existing.target)) {
      existing.lastSeen = this.now();
      // Refreshing the timestamp is itself a change worth persisting: a busy
      // long-lived session never re-assigns, so without this its snapshot keeps
      // the timestamp of its first request and restores as expired.
      this.onAssignmentsChanged?.();
      return existing.target;
    }

    const usable = candidates.filter(isUsable);
    if (usable.length === 0) return null;

    const target = this.leastLoaded(usable, utilOf);

    if (existing && !sameTarget(existing.target, target)) {
      this.onReassign?.({ sessionId, from: existing.target, to: target });
    }

    this.assignments.set(sessionId, { target, lastSeen: this.now() });
    this.onAssignmentsChanged?.();
    return target;
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

  forget(sessionId: string): void {
    this.assignments.delete(sessionId);
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
    const load = new Map<string, number>();
    for (const target of usable) load.set(targetKey(target), 0);
    for (const assignment of this.assignments.values()) {
      const key = targetKey(assignment.target);
      const current = load.get(key);
      if (current !== undefined) load.set(key, current + 1);
    }

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
