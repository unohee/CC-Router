/**
 * The hourly usage store as a time series, split by model: what the dashboard's
 * activity chart draws for the last 24 hours, 7 days or 30 days.
 *
 * Like usage-summary.ts, everything is computed here and the page only draws
 * it, and the endpoint serving it is open, so it carries aggregates only — no
 * account ids, no session ids.
 *
 * Series are the models with the most tokens over the last 30 days whatever
 * range is asked for, so a model keeps its place (and its colour) when the
 * viewer switches range. Every model is kept as a separate series.
 */

import { DAY_MS, HOUR_MS, type UsageBucket } from "./usage-history.js";
import { localDateFn, resolveTimeZone, type UsageSource } from "./usage-summary.js";

export type SeriesRange = "24h" | "7d" | "30d";
export const SERIES_RANGES: Record<SeriesRange, { step: "hour" | "day"; count: number }> = {
  "24h": { step: "hour", count: 24 },
  "7d": { step: "hour", count: 168 },
  "30d": { step: "day", count: 30 },
};
const RANKING_DAYS = 30;

export interface SeriesInfo {
  model: string;
  provider: string;
  /** True for the series that folds every model past the named ones. */
  other?: true;
}

export interface SeriesPoint {
  /** Start of the step, epoch ms. */
  start: number;
  /** The viewer's calendar date, YYYY-MM-DD. For an hour, the date it starts on. */
  date: string;
  /** False for a step that ended before recording began: no data, not zero. */
  recorded: boolean;
  /** One figure per entry of `series`, in the same order. */
  requests: number[];
  output: number[];
  total: number[];
}

export interface RangeTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  /** Anthropic only, as in the usage summary; null with nothing to divide. */
  cacheHitRatio: number | null;
}

export interface UsageSeries {
  generatedAt: number;
  tz: string;
  tzFallback: boolean;
  since: number | null;
  range: SeriesRange;
  step: "hour" | "day";
  series: SeriesInfo[];
  points: SeriesPoint[];
  totals: RangeTotals;
}

export function parseSeriesRange(raw: unknown): SeriesRange {
  return raw === "7d" || raw === "30d" ? raw : "24h";
}

const keyOf = (b: { provider: string; model: string }): string => `${b.provider}\u0000${b.model}`;

export function summarizeSeries(
  src: UsageSource,
  opts: { now: number; tz?: string; range: SeriesRange },
): UsageSeries {
  const { now, range } = opts;
  const { step, count } = SERIES_RANGES[range];
  const zone = resolveTimeZone(opts.tz);
  const dateOf = localDateFn(zone.tz);
  const buckets = src.buckets().filter(b => b.hour <= now);

  // Series: the top models over the ranking window, whatever range is drawn.
  const ranked = new Map<string, { model: string; provider: string; total: number }>();
  for (const b of buckets) {
    if (b.hour + HOUR_MS / 2 <= now - RANKING_DAYS * DAY_MS) continue;
    const k = keyOf(b);
    const r = ranked.get(k) ?? { model: b.model, provider: b.provider, total: 0 };
    r.total += b.input + b.output + b.cacheRead + b.cacheCreation;
    ranked.set(k, r);
  }
  const order = [...ranked.values()]
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  const named = order;
  const series: SeriesInfo[] = named.map(r => ({ model: r.model, provider: r.provider }));
  const index = new Map(named.map((r, i) => [keyOf(r), i]));
  // A calendar-day range may include a bucket just outside the ranking window.
  const slotOf = (b: UsageBucket): number => {
    const existing = index.get(keyOf(b));
    if (existing !== undefined) return existing;
    const slot = series.length;
    series.push({ model: b.model, provider: b.provider });
    index.set(keyOf(b), slot);
    return slot;
  };

  // Steps. Hours are whole UTC hours ending with the current one; days are the
  // viewer's calendar days ending today, built by calendar arithmetic so a DST
  // day is not cut at 24 hours.
  const sinceMs = src.since;
  const sinceDay = sinceMs === null ? null : dateOf(sinceMs);
  const steps: Array<{ start: number; date: string; recorded: boolean }> = [];
  const stepOfBucket = new Map<number, number>();
  if (step === "hour") {
    const last = Math.floor(now / HOUR_MS) * HOUR_MS;
    for (let i = count - 1; i >= 0; i--) {
      const start = last - i * HOUR_MS;
      stepOfBucket.set(start, steps.length);
      steps.push({ start, date: dateOf(start), recorded: sinceMs !== null && start + HOUR_MS > sinceMs });
    }
  } else {
    const [ty, tm, td] = dateOf(now).split("-").map(Number);
    const dayIndex = new Map<string, number>();
    for (let i = count - 1; i >= 0; i--) {
      const date = new Date(Date.UTC(ty, tm - 1, td - i)).toISOString().slice(0, 10);
      dayIndex.set(date, steps.length);
      // The start of a local day, found from its date: the first hour whose
      // midpoint falls on it. Only used to label and order the step.
      steps.push({ start: 0, date, recorded: sinceDay !== null && date >= sinceDay });
    }
    // A bucket belongs to the day its midpoint falls on, as in the day grid.
    for (const b of buckets) {
      if (stepOfBucket.has(b.hour)) continue;
      const i = dayIndex.get(dateOf(b.hour + HOUR_MS / 2));
      if (i !== undefined) stepOfBucket.set(b.hour, i);
    }
    for (const s of steps) {
      const [y, m, d] = s.date.split("-").map(Number);
      s.start = Date.UTC(y, m - 1, d);
    }
  }

  // Pass one completes the model list, pass two fills the aligned arrays.
  const hits: Array<{ b: UsageBucket; at: number; slot: number }> = [];
  for (const b of buckets) {
    const at = stepOfBucket.get(b.hour);
    if (at === undefined) continue;
    hits.push({ b, at, slot: slotOf(b) });
  }
  const width = series.length;
  const points: SeriesPoint[] = steps.map(s => ({
    ...s,
    requests: new Array<number>(width).fill(0),
    output: new Array<number>(width).fill(0),
    total: new Array<number>(width).fill(0),
  }));
  const totals: RangeTotals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, cacheHitRatio: null };
  let anthropicRead = 0, anthropicDenominator = 0;
  for (const { b, at, slot } of hits) {
    const p = points[at];
    const sum = b.input + b.output + b.cacheRead + b.cacheCreation;
    p.requests[slot] += b.requests;
    p.output[slot] += b.output;
    p.total[slot] += sum;
    totals.requests += b.requests;
    totals.input += b.input;
    totals.output += b.output;
    totals.cacheRead += b.cacheRead;
    totals.cacheCreation += b.cacheCreation;
    totals.total += sum;
    if (b.provider === "anthropic") {
      anthropicRead += b.cacheRead;
      anthropicDenominator += b.cacheRead + b.cacheCreation + b.input;
    }
  }
  totals.cacheHitRatio = anthropicDenominator > 0 ? anthropicRead / anthropicDenominator : null;

  return {
    generatedAt: now,
    tz: zone.tz,
    tzFallback: zone.fallback,
    since: src.since,
    range,
    step,
    series,
    points,
    totals,
  };
}

/**
 * `summarizeSeries` with a short memo per range and zone, for the same reason
 * as the usage summary's: the endpoint is open, so how often it recomputes must
 * not be up to the caller.
 */
export function createUsageSeriesProvider(
  src: UsageSource,
  opts: { ttlMs?: number; maxKeys?: number; now?: () => number } = {},
): (range: unknown, tz: unknown) => UsageSeries {
  const ttlMs = opts.ttlMs ?? 2_000;
  const maxKeys = opts.maxKeys ?? 12;
  const clock = opts.now ?? Date.now;
  const memo = new Map<string, { at: number; value: UsageSeries }>();
  return (rawRange, tz) => {
    const range = parseSeriesRange(rawRange);
    const zone = resolveTimeZone(tz);
    const key = `${range}|${zone.tz}|${zone.fallback}`;
    const now = clock();
    const hit = memo.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value = summarizeSeries(src, { now, range, tz: zone.fallback ? "" : zone.tz });
    const result = zone.fallback ? { ...value, tzFallback: true } : value;
    memo.delete(key);
    memo.set(key, { at: now, value: result });
    while (memo.size > maxKeys) memo.delete(memo.keys().next().value as string);
    return result;
  };
}
