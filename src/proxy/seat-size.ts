import type { QuotaReading } from "./quota-history.js";

/**
 * How big each seat's weekly quota is, relative to the others.
 *
 * Utilization is a share of one seat's own quota, so "40% left" is not the same
 * amount on a Max 20x seat as on a Max 5x one. Placement compares seats on what
 * they have left in tokens, which needs each seat's size. The plan name is not
 * a reliable guide: on the live pool (2026-11-19) the Max 20x seat bought about
 * 2x the tokens per 7-day point of the Team max_5x seats, not 4x. So size is
 * measured, and only when it cannot be measured does it fall back to a
 * configured weight, then to "the same as the others".
 *
 * Measurement pairs consecutive hourly quota readings of one seat inside one
 * 7-day window (quota-history.ts): the cost-weighted tokens the seat was billed
 * between them, against how far its weekly utilization moved. The estimate is
 * the ratio of the sums, so a pair that moved by one rounding step does not
 * swing it. It needs far fewer pairs than the supply model's capacity figure
 * (supply-model.ts, 24): placement only needs which seat is bigger and by
 * roughly how much, and a coarse ratio is better than calling every seat equal.
 */

export type SeatSizeSource = "measured" | "weight" | "equal";

export interface SeatSize {
  /** Multiplier against a typical seat: 1 is the median measured seat. */
  relative: number;
  source: SeatSizeSource;
  /** Cost-weighted tokens in a full 7-day window, when measured. */
  tokensPerWeek: number | null;
  /** Reading pairs the measurement used (0 when not measured). */
  samples: number;
  /** Hours between the oldest and newest reading the pairs span (0 when not measured). */
  spanHours: number;
  /** Relative error bound of tokensPerWeek: headers round utilization to 0.01
   *  and the moves telescope, so the estimate is off by at most 0.01 / moved.
   *  Null when not measured. */
  errorBand: number | null;
}

export interface SeatSizeOptions {
  /** Pairs needed before a measurement counts. */
  minSamples: number;
  /** Total weekly utilization the pairs must have moved (0-1). Headers round
   *  utilization to 0.01, and the moves telescope, so the estimate is off by
   *  at most 0.01 / moved: 0.08 bounds that at 12.5%. */
  minMoved: number;
  /** Measured seats within this factor of the typical one count as typical. */
  sameSize: number;
  /** Readings older than this are ignored. */
  maxAgeMs: number;
  /** Two readings are in the same window when their resets differ by at most this. */
  resetToleranceSec: number;
}

export const DEFAULT_SEAT_SIZE_OPTIONS: SeatSizeOptions = {
  minSamples: 3,
  minMoved: 0.08,
  sameSize: 1.2,
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  resetToleranceSec: 600,
};

/** Relative weights outside this range are ignored as typos. */
const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 50;
/** Upstream reports utilization to two places. */
const UTIL_ROUNDING = 0.01;

/**
 * Cost-weighted tokens per full 7-day window for one seat, from its readings,
 * or null when they are too few or moved too little.
 */
export function measureWeeklySize(
  readings: ReadonlyArray<QuotaReading>,
  now: number,
  opts: SeatSizeOptions = DEFAULT_SEAT_SIZE_OPTIONS,
): { tokensPerWeek: number | null; samples: number; spanHours: number; errorBand: number | null } {
  const sorted = readings.filter(r => r.sampledAt >= now - opts.maxAgeMs).sort((a, b) => a.sampledAt - b.sampledAt);
  let samples = 0, tokens = 0, moved = 0;
  let first: number | null = null, last: number | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (a.spentAt === null || b.spentAt === null || b.spentAt < a.spentAt) continue;
    const ra = a.sevenDay.resetAt, rb = b.sevenDay.resetAt;
    if (!(ra > 0 && rb > 0 && Math.abs(ra - rb) <= opts.resetToleranceSec)) continue;
    const du = b.sevenDay.util - a.sevenDay.util;
    if (du < 0) continue;
    const spent = b.spentAt - a.spentAt;
    if (spent === 0 && du === 0) continue;
    samples++;
    tokens += spent;
    moved += du;
    if (first === null) first = a.sampledAt;
    last = b.sampledAt;
  }
  const spanHours = first !== null && last !== null ? (last - first) / 3_600_000 : 0;
  if (samples < opts.minSamples || moved < opts.minMoved || tokens <= 0) return { tokensPerWeek: null, samples, spanHours, errorBand: null };
  return { tokensPerWeek: tokens / moved, samples, spanHours, errorBand: UTIL_ROUNDING / moved };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A configured weight, or null when absent or out of range. */
function weightOf(weights: Readonly<Record<string, unknown>> | undefined, id: string): number | null {
  const w = weights && Object.prototype.hasOwnProperty.call(weights, id) ? weights[id] : undefined;
  return typeof w === "number" && Number.isFinite(w) && w >= MIN_WEIGHT && w <= MAX_WEIGHT ? w : null;
}

/**
 * Every seat's size relative to a typical one.
 *
 * - **measured**: tokens per week over the median of the measured seats;
 * - **weight**: `capacityWeight[id]` (a multiplier against a typical seat);
 * - **equal**: 1.
 *
 * With no seat measured, weights stand alone against 1.
 */
export function seatSizes(
  ids: ReadonlyArray<string>,
  readings: ReadonlyArray<QuotaReading>,
  now: number,
  weights?: Readonly<Record<string, unknown>>,
  opts: SeatSizeOptions = DEFAULT_SEAT_SIZE_OPTIONS,
): Map<string, SeatSize> {
  const byId = new Map<string, QuotaReading[]>();
  for (const r of readings) {
    const list = byId.get(r.accountId);
    if (list) list.push(r); else byId.set(r.accountId, [r]);
  }
  const measured = new Map<string, ReturnType<typeof measureWeeklySize>>();
  for (const id of ids) measured.set(id, measureWeeklySize(byId.get(id) ?? [], now, opts));
  const known = [...measured.values()].map(m => m.tokensPerWeek).filter((x): x is number => x !== null);
  const reference = known.length > 0 ? median(known) : null;

  const out = new Map<string, SeatSize>();
  for (const id of ids) {
    const m = measured.get(id)!;
    if (m.tokensPerWeek !== null && reference !== null) {
      const ratio = m.tokensPerWeek / reference;
      // Within the measurement's error a seat is the typical size: a ratio
      // that is mostly rounding noise must not reorder equal seats.
      const relative = Math.max(ratio, 1 / ratio) < opts.sameSize ? 1 : ratio;
      out.set(id, { relative, source: "measured", tokensPerWeek: m.tokensPerWeek, samples: m.samples, spanHours: m.spanHours, errorBand: m.errorBand });
      continue;
    }
    const w = weightOf(weights, id);
    out.set(id, w !== null
      ? { relative: w, source: "weight", tokensPerWeek: null, samples: m.samples, spanHours: m.spanHours, errorBand: null }
      : { relative: 1, source: "equal", tokensPerWeek: null, samples: m.samples, spanHours: m.spanHours, errorBand: null });
  }
  return out;
}
