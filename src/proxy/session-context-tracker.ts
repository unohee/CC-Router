/**
 * Detects, router-side, that a session compacted — and at what size.
 *
 * Compaction happens inside the client, so the router has never been able to
 * see it. Answering "is compaction firing too early?" therefore meant mining
 * `~/.claude/projects/*.jsonl` by hand, which is how the question was answered
 * on 2026-09-18: sessions were compacting at 830-998K against a 1M window,
 * i.e. at the ceiling rather than prematurely. That archaeology is the gap this
 * closes. Premature compaction has a history here — a global 800K
 * `autoCompactWindow` once capped every session in the pool to accommodate one
 * target that could not hold 1M — and nothing in the router would report its
 * return.
 *
 * The signal is indirect but reliable: a request whose estimated prompt is a
 * fraction of what this session was carrying a moment ago means the client
 * dropped history. The size it dropped FROM is the number worth having.
 */

export interface CompactionObserved {
  /** Largest prompt this session was seen carrying before the drop. */
  fromTokens: number;
  /** Size it came back at. */
  toTokens: number;
}

export interface TrackerLimits {
  /** A drop to at most this fraction of the peak is a compaction candidate. */
  dropRatio: number;
  /** ...provided it is also this many tokens, so ordinary turn-to-turn
   *  variation in a small session never registers. */
  minDropTokens: number;
  /** Sessions remembered at once. A long-lived proxy sees many. */
  maxSessions: number;
}

export const DEFAULT_TRACKER_LIMITS: TrackerLimits = {
  dropRatio: 0.6,
  minDropTokens: 100_000,
  maxSessions: 500,
};

interface Entry {
  peak: number;
  lastSeen: number;
  /** A drop seen once, awaiting confirmation by the next request. */
  candidate: number | null;
}

export class SessionContextTracker {
  private readonly sessions = new Map<string, Entry>();
  private readonly limits: TrackerLimits;
  private readonly now: () => number;

  constructor(opts: { limits?: Partial<TrackerLimits>; now?: () => number } = {}) {
    this.limits = { ...DEFAULT_TRACKER_LIMITS, ...opts.limits };
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record this request's size, returning a compaction if one just became
   * certain.
   *
   * A single small request is NOT enough to call it. Claude Code issues small
   * side-calls under the same session id — a haiku title generation, a
   * sub-agent turn — and one of those arriving after a 900K turn looks exactly
   * like a compaction to 5K. So a drop is held as a candidate and only reported
   * once the following request is also small: a compaction persists, a
   * side-call does not. The cost is that the report arrives one request late,
   * which for a number used to tune thresholds is no cost at all.
   */
  observe(sessionId: string, estimatedPromptTokens: number | null): CompactionObserved | null {
    if (!sessionId || estimatedPromptTokens === null) return null;

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.evictIfFull();
      this.sessions.set(sessionId, {
        peak: estimatedPromptTokens, lastSeen: this.now(), candidate: null,
      });
      return null;
    }
    entry.lastSeen = this.now();

    const dropped =
      estimatedPromptTokens <= entry.peak * this.limits.dropRatio &&
      entry.peak - estimatedPromptTokens >= this.limits.minDropTokens;

    if (!dropped) {
      // Back up where it was: whatever the previous small request was, it was
      // not the conversation shrinking.
      entry.candidate = null;
      entry.peak = Math.max(entry.peak, estimatedPromptTokens);
      return null;
    }

    if (entry.candidate === null) {
      entry.candidate = estimatedPromptTokens;
      return null;
    }

    // Two small requests in a row against the same peak — the history is gone.
    const observed: CompactionObserved = {
      fromTokens: entry.peak,
      toTokens: Math.max(entry.candidate, estimatedPromptTokens),
    };
    entry.peak = estimatedPromptTokens;
    entry.candidate = null;
    return observed;
  }

  /** Peak prompt size seen for a session, for reporting. */
  peakOf(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.peak ?? null;
  }

  private evictIfFull(): void {
    if (this.sessions.size < this.limits.maxSessions) return;
    // Drop the least recently seen. Losing a peak only costs one missed report.
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, e] of this.sessions) {
      if (e.lastSeen < oldestAt) { oldestAt = e.lastSeen; oldestId = id; }
    }
    if (oldestId !== null) this.sessions.delete(oldestId);
  }
}
