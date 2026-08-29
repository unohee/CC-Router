/** One persisted assignment. Flat by design - it is written to disk as JSON. */
export interface SessionSnapshotEntry {
  sessionId: string;
  accountId: string;
  lastSeen: number;
}

export interface SessionRouterOptions {
  /** How long an unused assignment survives. Default 1 hour. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Fired when an existing session is moved to a different account. */
  onReassign?: (info: { sessionId: string; from: string; to: string }) => void;
  /** Fired whenever the assignment set changes, so it can be persisted. */
  onAssignmentsChanged?: () => void;
}

interface Assignment {
  accountId: string;
  lastSeen: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** Safety valve: a router that never forgets would grow without bound. */
const MAX_TRACKED_SESSIONS = 10_000;

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
 * Availability wins over cache locality: if the pinned account can no longer
 * serve (rate-limited, disabled, removed), the session is reassigned rather than
 * made to wait. That costs one cache write, which beats a stalled request.
 *
 * The router knows nothing about accounts beyond their ids - every judgement
 * about whether one can take traffic is the caller's, passed in as a predicate.
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
   * Resolve the account for `sessionId`, assigning one on first sight.
   *
   * `candidates` is the full set of account ids that exist right now; `isUsable`
   * decides which of them can take traffic at this instant. Assignment is made
   * from the usable subset, so a session is never pinned to an account that is
   * already unavailable. Returns null only when nothing is usable - the caller
   * then falls back to its own (degraded) selection.
   */
  resolve(
    sessionId: string,
    candidates: readonly string[],
    isUsable: (accountId: string) => boolean,
    /** Fraction of the binding quota window already spent (0-1). Used to break
     *  ties between equally-loaded accounts so a nearly-exhausted one does not
     *  keep taking new work. Absent means "unknown", treated as 0. */
    utilOf?: (accountId: string) => number,
    /** Whether an EXISTING pin may be kept. Defaults to `isUsable`. Separated
     *  because holding a pin tolerates transient states that would rightly
     *  disqualify an account for a new session. */
    isRetainable?: (accountId: string) => boolean,
  ): string | null {
    this.sweep();

    const existing = this.assignments.get(sessionId);
    if (existing && (isRetainable ?? isUsable)(existing.accountId)) {
      existing.lastSeen = this.now();
      // Refreshing the timestamp is itself a change worth persisting: a busy
      // long-lived session never re-assigns, so without this its snapshot keeps
      // the timestamp of its first request and restores as expired.
      this.onAssignmentsChanged?.();
      return existing.accountId;
    }

    const usable = candidates.filter(isUsable);
    if (usable.length === 0) return null;

    const accountId = this.leastLoaded(usable, utilOf);

    if (existing && existing.accountId !== accountId) {
      this.onReassign?.({ sessionId, from: existing.accountId, to: accountId });
    }

    this.assignments.set(sessionId, { accountId, lastSeen: this.now() });
    this.onAssignmentsChanged?.();
    return accountId;
  }

  /**
   * Serialisable view of the live assignments, for surviving a restart.
   *
   * Losing these on restart is not merely a cosmetic reset: a live Claude Code
   * session gets reassigned, and its entire conversation is then re-written
   * into the new account's prompt cache - measured at 917K tokens for one
   * session, billed at 1.25x. Sessions must outlive the process that routes
   * them.
   */
  snapshot(): SessionSnapshotEntry[] {
    this.sweep();
    return [...this.assignments].map(([sessionId, a]) => ({
      sessionId,
      accountId: a.accountId,
      lastSeen: a.lastSeen,
    }));
  }

  /**
   * Reload assignments saved earlier. Entries already past the TTL are dropped
   * rather than revived - a session idle that long has no warm cache left to
   * protect, so pinning it would only constrain placement for nothing.
   *
   * Accounts that no longer exist are kept as-is; `resolve` filters them through
   * `isUsable` and reassigns on the next request, so no validation is needed
   * against the current account list.
   */
  restore(entries: readonly SessionSnapshotEntry[]): void {
    const cutoff = this.now() - this.ttlMs;
    for (const entry of entries) {
      if (!entry?.sessionId || typeof entry.lastSeen !== "number") continue;
      if (typeof entry.accountId !== "string" || entry.accountId === "") continue;
      if (entry.lastSeen < cutoff) continue;
      this.assignments.set(entry.sessionId, {
        accountId: entry.accountId,
        lastSeen: entry.lastSeen,
      });
    }
  }

  /** Assignment for a session, without creating or refreshing one. */
  peek(sessionId: string): string | null {
    return this.assignments.get(sessionId)?.accountId ?? null;
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
   * Pick the account carrying the fewest live sessions, breaking ties by
   * round-robin so equal candidates still rotate.
   *
   * Plain rotation counts assignments, not work: one session can send hundreds
   * of requests while another sends two, so rotating alone lets an account that
   * is already saturated take the next session anyway. Counting live sessions
   * per account is the closest proxy for load that assignment can see - it
   * cannot know how busy a session will turn out to be, but it can avoid
   * stacking new ones onto an account that already holds several.
   */
  private leastLoaded(usable: readonly string[], utilOf?: (accountId: string) => number): string {
    const load = new Map<string, number>();
    for (const accountId of usable) load.set(accountId, 0);
    for (const assignment of this.assignments.values()) {
      const current = load.get(assignment.accountId);
      if (current !== undefined) load.set(assignment.accountId, current + 1);
    }

    let lightest = Infinity;
    for (const accountId of usable) lightest = Math.min(lightest, load.get(accountId) ?? 0);

    const tied = usable.filter(accountId => (load.get(accountId) ?? 0) === lightest);
    if (tied.length === 1) return tied[0];

    // Among equally-loaded accounts, prefer the one with the most quota left.
    // Session count alone would keep feeding an account sitting at 80% of its
    // weekly window while another at 50% waits its turn.
    if (utilOf) {
      let best = tied[0];
      let bestUtil = utilOf(best);
      for (const accountId of tied.slice(1)) {
        const util = utilOf(accountId);
        if (util < bestUtil) { best = accountId; bestUtil = util; }
      }
      // Only commit to the quota ordering when it actually distinguishes them;
      // otherwise fall through to rotation so identical accounts still alternate.
      if (tied.some(accountId => utilOf(accountId) !== bestUtil)) return best;
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
