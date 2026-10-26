/**
 * Turns the hourly usage store into what the dashboard draws: rolling totals,
 * a calendar-day grid in the viewer's time zone, model ranking and cache ratio.
 *
 * All of it is computed here rather than in the page. The page's script is an
 * inline string with no module system, so logic left there could only be tested
 * through a fake DOM; here it is plain functions over plain data.
 */

import { DAY_MS, HOUR_MS, type UsageBucket } from "./usage-history.js";

export interface Totals {
  /** input + output + cacheRead + cacheCreation. */
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  requests: number;
}

export type WindowKey = "1d" | "7d" | "14d" | "30d";
export const WINDOWS: ReadonlyArray<{ key: WindowKey; days: number }> = [
  { key: "1d", days: 1 }, { key: "7d", days: 7 }, { key: "14d", days: 14 }, { key: "30d", days: 30 },
];
/** The models list and cache ratio describe this rolling window. */
const DETAIL_WINDOW_DAYS = 30;
export const DISPLAY_DAYS = 90;

export interface WindowTotals extends Totals {
  /** True when recording began after this window opened, so it is not a full window. */
  partial: boolean;
}

export type Level = 0 | 1 | 2 | 3 | 4;

export interface DayCell extends Totals {
  /** Calendar date in the viewer's time zone, YYYY-MM-DD. */
  date: string;
  /** null: nothing was being recorded yet. 0: recorded, and nothing was used. */
  level: Level | null;
}
/** A blank slot that lines the first day up with its weekday (Sunday-first rows). */
export type Cell = { pad: true } | DayCell;

export interface ModelRow {
  model: string;
  provider: string;
  total: number;
  /** Fraction of the window's total, 0..1. */
  share: number;
  requests: number;
}

export interface UsageSummary {
  generatedAt: number;
  tz: string;
  /** True when the requested zone was unusable and UTC was used instead. */
  tzFallback: boolean;
  since: number | null;
  windows: Record<WindowKey, WindowTotals>;
  cells: Cell[];
  models: {
    windowDays: number;
    rows: ModelRow[];
    others: { count: number; total: number; share: number } | null;
  };
  details: {
    windowDays: number;
    displayDays: number;
    /** Anthropic rows only; null when there is nothing to divide by. */
    cacheHitRatio: number | null;
    avgTokensPerRequest: number | null;
    /** Busiest of the displayed days. */
    busiest: { date: string; total: number } | null;
    activeDays: number;
    recordedDays: number;
  };
}

export interface UsageSource {
  buckets(): UsageBucket[];
  readonly since: number | null;
}

const TZ_PATTERN = /^[A-Za-z0-9_+\-/]{1,64}$/;

/**
 * The zone to use for a requested name. The endpoint is open and the name comes
 * straight from a query string, so it is shape-checked first and only the zone's
 * canonical name (never the raw input) is handed back.
 */
export function resolveTimeZone(tz: unknown): { tz: string; fallback: boolean } {
  if (tz === undefined || tz === "") return { tz: "UTC", fallback: false };
  if (typeof tz !== "string" || !TZ_PATTERN.test(tz)) return { tz: "UTC", fallback: true };
  try {
    return { tz: new Intl.DateTimeFormat("en-CA", { timeZone: tz }).resolvedOptions().timeZone, fallback: false };
  } catch {
    return { tz: "UTC", fallback: true };
  }
}

function emptyTotals(): Totals {
  return { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0 };
}

function add(into: Totals, b: UsageBucket): void {
  into.input += b.input;
  into.output += b.output;
  into.cacheRead += b.cacheRead;
  into.cacheCreation += b.cacheCreation;
  into.requests += b.requests;
  into.total += b.input + b.output + b.cacheRead + b.cacheCreation;
}

/**
 * Whether an hourly bucket belongs to the rolling window ending at `now`.
 *
 * A bucket cannot be split, so it counts when more than half of it lies inside.
 * The error is at most 30 minutes of the oldest bucket (about 2% of a 1-day
 * window); a rule that included any overlap would over-count by up to 59.
 */
function inWindow(b: UsageBucket, now: number, days: number): boolean {
  return b.hour <= now && b.hour + HOUR_MS / 2 > now - days * DAY_MS;
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDateFn(tz: string): (ms: number) => string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return ms => {
    let y = "", m = "", d = "";
    for (const part of f.formatToParts(ms)) {
      if (part.type === "year") y = part.value;
      else if (part.type === "month") m = part.value;
      else if (part.type === "day") d = part.value;
    }
    return `${y}-${m}-${d}`;
  };
}

/** Nearest-rank percentile of an ascending list. */
function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function summarizeUsage(
  src: UsageSource,
  opts: { now: number; tz?: string; days?: number; modelLimit?: number },
): UsageSummary {
  const { now } = opts;
  const days = opts.days ?? DISPLAY_DAYS;
  const modelLimit = opts.modelLimit ?? 8;
  const zone = resolveTimeZone(opts.tz);
  const dateOf = localDateFn(zone.tz);
  const buckets = src.buckets();

  // Rolling windows.
  const windows = {} as Record<WindowKey, WindowTotals>;
  for (const { key, days: n } of WINDOWS) {
    const t = emptyTotals();
    for (const b of buckets) if (inWindow(b, now, n)) add(t, b);
    windows[key] = { ...t, partial: src.since === null || src.since > now - n * DAY_MS };
  }

  // Calendar days. The last `days` dates are built by calendar arithmetic in
  // UTC, never by subtracting 24 hours: a DST day is 23 or 25 hours long.
  const [ty, tm, td] = dateOf(now).split("-").map(Number);
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) dates.push(new Date(Date.UTC(ty, tm - 1, td - i)).toISOString().slice(0, 10));
  const byDate = new Map<string, Totals>(dates.map(d => [d, emptyTotals()]));

  // A bucket is attributed to the day its midpoint falls on. Using its start
  // would put a whole 18:00Z hour on the previous day in a UTC+5:30 zone, where
  // that hour straddles local midnight.
  const dayOfHour = new Map<number, string>();
  for (const b of buckets) {
    if (b.hour > now) continue;
    let date = dayOfHour.get(b.hour);
    if (date === undefined) { date = dateOf(b.hour + HOUR_MS / 2); dayOfHour.set(b.hour, date); }
    const t = byDate.get(date);
    if (t) add(t, b);
  }

  const sinceDay = src.since === null ? null : dateOf(src.since);
  const recorded = (date: string): boolean => sinceDay !== null && date >= sinceDay;

  // Heat levels come from the days that had any use: quartiles, so that one
  // enormous day cannot flatten every other day to the palest shade.
  const used = dates.filter(d => recorded(d) && byDate.get(d)!.total > 0).map(d => byDate.get(d)!.total).sort((a, b) => a - b);
  const thresholds = used.length === 0 ? [] : [0.25, 0.5, 0.75].map(p => nearestRank(used, p));
  const levelOf = (total: number): Level => (1 + thresholds.filter(t => t < total).length) as Level;

  const dayCells: DayCell[] = dates.map(date => {
    const t = byDate.get(date)!;
    const level: Level | null = !recorded(date) ? null : t.total === 0 ? 0 : levelOf(t.total);
    return { date, ...t, level };
  });

  // Sunday-first rows: pad the front so column 0 starts on a Sunday.
  const [fy, fm, fd] = dates[0].split("-").map(Number);
  const padCount = new Date(Date.UTC(fy, fm - 1, fd)).getUTCDay();
  const cells: Cell[] = [...Array.from({ length: padCount }, (): Cell => ({ pad: true })), ...dayCells];

  // Models and cache ratio over the rolling detail window.
  const grouped = new Map<string, { model: string; provider: string; t: Totals }>();
  const anthropic = emptyTotals();
  const detailTotals = emptyTotals();
  for (const b of buckets) {
    if (!inWindow(b, now, DETAIL_WINDOW_DAYS)) continue;
    add(detailTotals, b);
    if (b.provider === "anthropic") add(anthropic, b);
    const key = `${b.provider}\u0000${b.model}`;
    let g = grouped.get(key);
    if (!g) { g = { model: b.model, provider: b.provider, t: emptyTotals() }; grouped.set(key, g); }
    add(g.t, b);
  }
  const ranked = [...grouped.values()].sort((a, b) => b.t.total - a.t.total || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  const share = (n: number): number => (detailTotals.total > 0 ? n / detailTotals.total : 0);
  const top = ranked.slice(0, modelLimit);
  const rest = ranked.slice(modelLimit);
  const restTotal = rest.reduce((n, g) => n + g.t.total, 0);

  // Anthropic only: OpenAI rows carry no cache fields and their input already
  // includes cached tokens, so mixing them in would understate the ratio.
  const cacheDenominator = anthropic.cacheRead + anthropic.cacheCreation + anthropic.input;

  let busiest: { date: string; total: number } | null = null;
  for (const c of dayCells) if (c.total > 0 && (busiest === null || c.total > busiest.total)) busiest = { date: c.date, total: c.total };

  return {
    generatedAt: now,
    tz: zone.tz,
    tzFallback: zone.fallback,
    since: src.since,
    windows,
    cells,
    models: {
      windowDays: DETAIL_WINDOW_DAYS,
      rows: top.map(g => ({ model: g.model, provider: g.provider, total: g.t.total, share: share(g.t.total), requests: g.t.requests })),
      others: rest.length === 0 ? null : { count: rest.length, total: restTotal, share: share(restTotal) },
    },
    details: {
      windowDays: DETAIL_WINDOW_DAYS,
      displayDays: days,
      cacheHitRatio: cacheDenominator > 0 ? anthropic.cacheRead / cacheDenominator : null,
      avgTokensPerRequest: detailTotals.requests > 0 ? detailTotals.total / detailTotals.requests : null,
      busiest,
      activeDays: dayCells.filter(c => c.total > 0).length,
      recordedDays: dayCells.filter(c => c.level !== null).length,
    },
  };
}

/**
 * `summarizeUsage` with a short per-zone memo.
 *
 * The endpoint is unauthenticated, so how often it recomputes must not be up to
 * the caller. A summary costs a few milliseconds, so two seconds bounds the work
 * at a fraction of a core however hard the route is hit, and is invisible on a
 * page that refreshes once a minute. The key count is capped so distinct zone
 * names cannot grow the memo.
 */
export function createUsageSummaryProvider(
  src: UsageSource,
  opts: { ttlMs?: number; maxKeys?: number; now?: () => number } = {},
): (tz: unknown) => UsageSummary {
  const ttlMs = opts.ttlMs ?? 2_000;
  const maxKeys = opts.maxKeys ?? 8;
  const clock = opts.now ?? Date.now;
  const memo = new Map<string, { at: number; value: UsageSummary }>();
  return tz => {
    const zone = resolveTimeZone(tz);
    const key = `${zone.tz}|${zone.fallback}`;
    const now = clock();
    const hit = memo.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    // The same zone again may be a different string ("Asia/Calcutta"), so pass
    // the canonical name, not the raw one, and keep the fallback flag honest.
    const value = summarizeUsage(src, { now, tz: zone.fallback ? "" : zone.tz });
    const result = zone.fallback ? { ...value, tzFallback: true } : value;
    memo.delete(key);
    memo.set(key, { at: now, value: result });
    while (memo.size > maxKeys) memo.delete(memo.keys().next().value as string);
    return result;
  };
}
