/** A routable destination for one Claude Code session. */
export interface SessionTarget {
  provider: "anthropic" | "openai";
  accountId: string;
}

export interface SessionRouterOptions {
  /** How long an unused assignment survives. Default 1 hour. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Fired when an existing session is moved to a different target. */
  onReassign?: (info: { sessionId: string; from: SessionTarget; to: SessionTarget }) => void;
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

  constructor(opts: SessionRouterOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.onReassign = opts.onReassign;
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
  ): SessionTarget | null {
    this.sweep();

    const existing = this.assignments.get(sessionId);
    if (existing && isUsable(existing.target)) {
      existing.lastSeen = this.now();
      return existing.target;
    }

    const usable = candidates.filter(isUsable);
    if (usable.length === 0) return null;

    const target = usable[this.cursor % usable.length];
    this.cursor = (this.cursor + 1) % usable.length;

    if (existing && !sameTarget(existing.target, target)) {
      this.onReassign?.({ sessionId, from: existing.target, to: target });
    }

    this.assignments.set(sessionId, { target, lastSeen: this.now() });
    return target;
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
