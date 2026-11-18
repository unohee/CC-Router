/**
 * The continuity ledger: every time a client was shown a failure, by cause,
 * per hour; and every worker handoff with what it finished and dropped.
 *
 * The router's promise is that, while some seat has quota, a session is never
 * cut. This is the evidence for or against it, kept beside the usage history
 * (continuity.json, same atomic write, same persistence gate) so it survives
 * restarts and reloads. Health reports the last hour and the last day.
 *
 * Counted here is only what reached a client:
 *   http-401, http-429, http-5xx  a response with that status (pool exhausted,
 *                                 or the last refusal after failover)
 *   stream-stalled/-broken/-truncated  a stream the stream guard ended with
 *                                 overloaded_error (the client retries it)
 * Refusals the router failed over from never reach a client and are not here;
 * the failover counters have them. A 4xx other than 401/429 is the request's
 * own fault and is not a continuity failure.
 */
import type { HandoffReport } from "../daemon/handoff-protocol.js";

export const CONTINUITY_CAUSES = [
  "http-401", "http-429", "http-5xx", "stream-stalled", "stream-broken", "stream-truncated",
] as const;
export type ContinuityCause = typeof CONTINUITY_CAUSES[number];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Hours kept on disk. */
export const CONTINUITY_RETENTION_MS = 7 * DAY_MS;
/** Handoffs kept. */
export const MAX_HANDOFFS = 50;

/** The cause for a response status a client received, or null when it is not a continuity failure. */
export function causeOfStatus(status: number): ContinuityCause | null {
  if (status === 401) return "http-401";
  if (status === 429) return "http-429";
  if (status >= 500) return "http-5xx";
  return null;
}

type Counts = Record<ContinuityCause, number>;
const zero = (): Counts => Object.fromEntries(CONTINUITY_CAUSES.map(c => [c, 0])) as Counts;
const isCause = (c: unknown): c is ContinuityCause => (CONTINUITY_CAUSES as readonly unknown[]).includes(c);
const nonNegInt = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export interface ContinuityWindow {
  total: number;
  byCause: Counts;
}

export interface ContinuitySnapshot {
  lastHour: ContinuityWindow;
  lastDay: ContinuityWindow;
  handoffs: {
    lastDay: number;
    /** In-flight requests ended at the drain limit, last day. */
    droppedLastDay: number;
    last: HandoffReport | null;
    recent: HandoffReport[];
  };
  /** Workers that died and were replaced (from the supervisor), or null when not supervised. */
  workerCrashes: number | null;
}

/** On disk. */
export interface ContinuityFile {
  version: 1;
  hours: Array<[hourSec: number, counts: Partial<Counts>]>;
  handoffs: HandoffReport[];
}

export class ContinuityLedger {
  private readonly byHour = new Map<number, Counts>();
  private handoffs: HandoffReport[] = [];
  private isDirty = false;
  private crashes: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  get dirty(): boolean { return this.isDirty; }
  markClean(): void { this.isDirty = false; }

  record(cause: ContinuityCause, n = 1, ts = this.now()): void {
    if (!isCause(cause) || n <= 0) return;
    const hour = Math.floor(ts / HOUR_MS) * HOUR_MS;
    let counts = this.byHour.get(hour);
    if (!counts) { counts = zero(); this.byHour.set(hour, counts); }
    counts[cause] += n;
    this.isDirty = true;
  }

  /** Adds a handoff report once (a report is re-sent with every supervisor update). */
  recordHandoff(report: HandoffReport | null | undefined): void {
    if (!report || typeof report.at !== "number") return;
    if (this.handoffs.some(h => h.at === report.at && h.toPid === report.toPid)) return;
    this.handoffs.push({ ...report });
    this.handoffs.sort((a, b) => a.at - b.at);
    if (this.handoffs.length > MAX_HANDOFFS) this.handoffs = this.handoffs.slice(-MAX_HANDOFFS);
    this.isDirty = true;
  }

  noteCrashes(crashes: number | undefined): void {
    if (typeof crashes === "number") this.crashes = crashes;
  }

  private window(sinceMs: number): ContinuityWindow {
    const byCause = zero();
    for (const [hour, counts] of this.byHour) {
      if (hour + HOUR_MS <= sinceMs) continue;
      for (const c of CONTINUITY_CAUSES) byCause[c] += counts[c];
    }
    return { total: CONTINUITY_CAUSES.reduce((sum, c) => sum + byCause[c], 0), byCause };
  }

  /**
   * "Last hour" is the current clock hour and the one before it that overlaps
   * the last 60 minutes; "last day" the hours overlapping the last 24 h.
   * Hourly buckets make both a little generous, never short.
   */
  snapshot(): ContinuitySnapshot {
    const now = this.now();
    const dayAgo = now - DAY_MS;
    const recentHandoffs = this.handoffs.filter(h => h.at > dayAgo);
    return {
      lastHour: this.window(now - HOUR_MS),
      lastDay: this.window(dayAgo),
      handoffs: {
        lastDay: recentHandoffs.length,
        droppedLastDay: recentHandoffs.reduce((sum, h) => sum + nonNegInt(h.dropped), 0),
        last: this.handoffs.at(-1) ?? null,
        recent: this.handoffs.slice(-10),
      },
      workerCrashes: this.crashes,
    };
  }

  toFile(): ContinuityFile {
    const cutoff = this.now() - CONTINUITY_RETENTION_MS;
    for (const hour of [...this.byHour.keys()]) if (hour + HOUR_MS <= cutoff) this.byHour.delete(hour);
    const hours = [...this.byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, counts]) => {
      const kept: Partial<Counts> = {};
      for (const c of CONTINUITY_CAUSES) if (counts[c] > 0) kept[c] = counts[c];
      return [hour / 1000, kept] as [number, Partial<Counts>];
    });
    return { version: 1, hours, handoffs: this.handoffs };
  }

  /** Merges a file; false when it is not a continuity file. Malformed rows are skipped. */
  restore(raw: unknown): boolean {
    if (typeof raw !== "object" || raw === null) return false;
    const file = raw as Partial<ContinuityFile>;
    if (file.version !== 1) return false;
    const wasDirty = this.isDirty;
    const cutoff = this.now() - CONTINUITY_RETENTION_MS;
    for (const row of Array.isArray(file.hours) ? file.hours : []) {
      if (!Array.isArray(row) || typeof row[0] !== "number" || typeof row[1] !== "object" || row[1] === null) continue;
      const hour = Math.floor((row[0] * 1000) / HOUR_MS) * HOUR_MS;
      if (hour + HOUR_MS <= cutoff) continue;
      for (const [cause, n] of Object.entries(row[1])) {
        if (isCause(cause)) this.record(cause, nonNegInt(n), hour);
      }
    }
    for (const h of Array.isArray(file.handoffs) ? file.handoffs : []) {
      if (h && typeof h === "object" && typeof h.at === "number" && typeof h.toPid === "number") {
        this.recordHandoff({
          generation: nonNegInt(h.generation), at: h.at, fromPid: nonNegInt(h.fromPid), toPid: h.toPid,
          finished: nonNegInt(h.finished), dropped: nonNegInt(h.dropped), unsaved: nonNegInt(h.unsaved), drainMs: nonNegInt(h.drainMs),
        });
      }
    }
    // What was merged is already on disk; anything recorded before it is not.
    this.isDirty = wasDirty;
    return true;
  }
}
