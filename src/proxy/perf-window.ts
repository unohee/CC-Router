/**
 * Request performance over the last hour, per account, per model and for the
 * whole pool: how many requests, how many failed, how long they took to finish
 * and how fast they produced output.
 *
 * The activity log cannot answer this. It holds 100 entries, which at a busy
 * pool's pace is a few minutes — too few for a p95 to mean anything. This keeps
 * an hour of request entries instead, in memory only: a restart starts it empty,
 * and the page says "no reading" until requests arrive, rather than a zero.
 *
 * Entries are held by reference. The proxy logs a request when its headers
 * arrive and fills in output tokens and the completion time as the stream ends,
 * so a figure is read when a snapshot is taken, not when the entry is recorded.
 */

import type { LogEntry } from "./stats.js";

export const PERF_WINDOW_MS = 60 * 60 * 1000;
/** A hard bound on memory however busy the pool gets; the oldest go first. */
const MAX_ENTRIES = 20_000;

export interface PerfStat {
  /** Requests that reached an upstream (or failed trying) in the window. */
  requests: number;
  /** Status 400 and above, 429 included, plus responses that failed mid-stream.
   *  A client that hung up is not an error. */
  errors: number;
  /** The 429s among `errors`, so a quota wall reads apart from a fault. */
  rateLimited: number;
  /** errors / requests; null with no requests. */
  errorRate: number | null;
  /** Requests whose response finished, the population of the figures below. */
  completed: number;
  /** Time from receiving the request to the end of the response. */
  p50Ms: number | null;
  p95Ms: number | null;
  /** Median of output tokens ÷ completion time, over completed requests that
   *  produced output. It includes the wait for the first token. */
  outputTokensPerSecond: number | null;
}

export interface PerfSnapshot {
  windowMs: number;
  /** How much of the window has actually been observed: less than `windowMs`
   *  for the first hour after a restart. */
  observedMs: number;
  pool: PerfStat;
  accounts: Record<string, PerfStat>;
  models: Record<string, PerfStat>;
}

/** A request entry, as opposed to a notice (a re-pin, a refresh, a compaction). */
function isRequest(e: LogEntry): boolean {
  return e.method !== undefined && e.statusCode !== undefined;
}

function isError(e: LogEntry): boolean {
  if (e.clientClosed) return false;
  return e.type === "error" || (e.statusCode ?? 0) >= 400;
}

/** Nearest-rank percentile of an ascending list. */
function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function summarize(entries: LogEntry[]): PerfStat {
  let errors = 0, rateLimited = 0;
  const times: number[] = [];
  const speeds: number[] = [];
  for (const e of entries) {
    if (isError(e)) {
      errors++;
      if (e.statusCode === 429) rateLimited++;
      continue;
    }
    // Abandoned: the routes still log how long it ran, but a response cut
    // short by the client is not a completion and would drag the median down.
    if (e.clientClosed) continue;
    if (e.totalMs === undefined || e.totalMs <= 0) continue;
    times.push(e.totalMs);
    if (e.outputTokens && e.outputTokens > 0) speeds.push(e.outputTokens / (e.totalMs / 1000));
  }
  times.sort((a, b) => a - b);
  speeds.sort((a, b) => a - b);
  return {
    requests: entries.length,
    errors,
    rateLimited,
    errorRate: entries.length > 0 ? errors / entries.length : null,
    completed: times.length,
    p50Ms: times.length > 0 ? nearestRank(times, 0.5) : null,
    p95Ms: times.length > 0 ? nearestRank(times, 0.95) : null,
    outputTokensPerSecond: speeds.length > 0 ? nearestRank(speeds, 0.5) : null,
  };
}

function groupBy(entries: LogEntry[], key: (e: LogEntry) => string | null): Record<string, PerfStat> {
  const groups = new Map<string, LogEntry[]>();
  for (const e of entries) {
    const k = key(e);
    if (!k) continue;
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }
  const out: Record<string, PerfStat> = {};
  for (const [k, list] of groups) out[k] = summarize(list);
  return out;
}

export class PerfWindow {
  private entries: LogEntry[] = [];
  private readonly startedAt: number;

  constructor(
    private readonly windowMs = PERF_WINDOW_MS,
    now = Date.now(),
  ) {
    this.startedAt = now;
  }

  record(entry: LogEntry): void {
    if (!isRequest(entry)) return;
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }

  snapshot(now = Date.now()): PerfSnapshot {
    const cutoff = now - this.windowMs;
    // Entries arrive in time order, so everything expired sits at the front.
    let drop = 0;
    while (drop < this.entries.length && this.entries[drop].ts < cutoff) drop++;
    if (drop > 0) this.entries.splice(0, drop);
    const live = this.entries;
    return {
      windowMs: this.windowMs,
      observedMs: Math.min(this.windowMs, Math.max(0, now - this.startedAt)),
      pool: summarize(live),
      accounts: groupBy(live, e => e.accountId || null),
      models: groupBy(live, e => (e.model && e.model !== "-" ? e.model : null)),
    };
  }
}
