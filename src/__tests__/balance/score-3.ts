/**
 * Scoring for run 3: the run-2 score plus the two outcomes the live router
 * records about itself (quota-history.ts `SeatOutcomes`). FROZEN after the
 * milestone that introduced it, like score.ts and score-2.ts, which it extends
 * and does not edit.
 *
 * Why a third score: since run 2 the router measures its own objective per
 * seat, from its readings (health `balance.seats[].outcomes`): the share of the
 * week left unused at each weekly reset, and the minutes a seat sat at or past
 * the soft cap while another usable seat under the cap still had a fifth of
 * its week left. The run-1 and run-2 scores total absolute tokens from the
 * simulator's TRUE state (what upstream knows); a policy could improve them
 * and worsen what the dashboard shows, or the reverse. From here the offline
 * judge counts the live definitions too, computed in the simulator exactly as
 * the router computes them (sim.ts calls the same `strandedSeats` and the same
 * `QuotaHistory.outcomes` on the readings the simulated router holds).
 *
 * Weights, in cost-weighted tokens as before:
 * - A stranded seat-minute is priced at STRANDED_TOKENS_PER_MINUTE: what one
 *   seat of the live pool serves in a minute on average (about 285M cost-
 *   weighted tokens a day over five seats, 2026-11-19), the work that had to
 *   wait or move while that seat sat at its cap with room elsewhere.
 * - The unused share at reset is priced at UNUSED_SHARE_TOKENS per unit of
 *   share per reset: a typical Team week (450M). It double-counts the run-1
 *   `unusedAtReset` on purpose: that one is the true leftover in tokens, this
 *   one is the figure the router reports and the person reads, from readings
 *   rounded to 0.01 and up to an hour stale, and the two can differ.
 *
 * The regression gate fails on either outcome growing past its baseline by
 * more than its tolerance, besides the run-2 gates.
 */
import type { SeatOutcomes } from "../../proxy/quota-history.js";
import { regressions2, total2, TOLERANCE_2, type RunMetrics2, type ScenarioScore2 } from "./score-2.js";

export const STRANDED_TOKENS_PER_MINUTE = 40_000;
export const UNUSED_SHARE_TOKENS = 450e6;

export interface RunMetrics3 extends RunMetrics2 {
  /** Weekly resets the simulated router saw, summed over seats. */
  resets: number;
  /** Mean share of the week unused at those resets (0..1), as the router reads
   *  it; 0 when no reset fell inside the run. */
  unusedShareAtReset: number;
  /** Seat-minutes at or past the soft cap while another usable seat under the
   *  cap had a fifth of its week left, judged on the router's readings. */
  strandedSeatMinutes: number;
  /** The same two, per seat, for the report. */
  outcomesBySeat: Record<string, SeatOutcomes>;
}

export interface ScenarioScore3 extends RunMetrics3 {
  total: number;
}

/** The pool-level outcomes from the simulator's per-seat ones. */
export function poolOutcomes(outcomesBySeat: Record<string, SeatOutcomes>): { resets: number; unusedShareAtReset: number } {
  let resets = 0, unused = 0;
  for (const o of Object.values(outcomesBySeat)) {
    if (o.unusedAtReset === null) continue;
    resets += o.resets;
    unused += o.unusedAtReset * o.resets;
  }
  return { resets, unusedShareAtReset: resets > 0 ? unused / resets : 0 };
}

export function total3(m: RunMetrics3): number {
  return total2(m) + STRANDED_TOKENS_PER_MINUTE * m.strandedSeatMinutes + UNUSED_SHARE_TOKENS * m.unusedShareAtReset * m.resets;
}

export function score3(m: RunMetrics3): ScenarioScore3 {
  return { ...m, total: total3(m) };
}

export const TOLERANCE_3 = {
  ...TOLERANCE_2,
  /** `strandedSeatMinutes` may exceed the baseline by this fraction of it, plus STRANDED_MINUTES_FLOOR. */
  strandedRelative: 0.05,
  strandedMinutesFloor: 5,
  /** `unusedShareAtReset` may exceed the baseline by this much of a share (half a point of utilization). */
  unusedShare: 0.005,
} as const;

/** Why `current` is worse than `baseline` on one scenario under score-3; empty when it is not. */
export function regressions3(name: string, current: ScenarioScore3, baseline: ScenarioScore3): string[] {
  const out = regressions2(name, asScore2(current), asScore2(baseline));
  if (current.strandedSeatMinutes > baseline.strandedSeatMinutes * (1 + TOLERANCE_3.strandedRelative) + TOLERANCE_3.strandedMinutesFloor) {
    out.push(`${name}: stranded ${Math.round(current.strandedSeatMinutes)} seat-min > baseline ${Math.round(baseline.strandedSeatMinutes)}`);
  }
  if (current.unusedShareAtReset > baseline.unusedShareAtReset + TOLERANCE_3.unusedShare) {
    out.push(`${name}: unused at reset ${pct(current.unusedShareAtReset)} > baseline ${pct(baseline.unusedShareAtReset)}`);
  }
  if (current.total > baseline.total + TOLERANCE_3.totalOfDemand * baseline.demand) {
    out.push(`${name}: total3 ${fmt(current.total)} > baseline ${fmt(baseline.total)}`);
  }
  return out;
}

/**
 * Strictly better under score-3: nothing regressed (the run-2 gates and both
 * outcomes' tolerances), and at least one outcome better by more than its
 * tolerance: fewer stranded seat-minutes, or a smaller unused share at reset.
 * A better run-2 total alone is not enough here; that is strictlyBetter2.
 */
export function strictlyBetter3(current: ScenarioScore3, baseline: ScenarioScore3): boolean {
  if (regressions3("x", current, baseline).length > 0) return false;
  const strandedBetter = current.strandedSeatMinutes < baseline.strandedSeatMinutes - Math.max(TOLERANCE_3.strandedMinutesFloor, baseline.strandedSeatMinutes * TOLERANCE_3.strandedRelative);
  const unusedBetter = current.unusedShareAtReset < baseline.unusedShareAtReset - TOLERANCE_3.unusedShare;
  return strandedBetter || unusedBetter;
}

/** The run-2 view of a run-3 score (same fields, run-2 total). */
function asScore2(s: ScenarioScore3): ScenarioScore2 {
  const { resets: _r, unusedShareAtReset: _u, strandedSeatMinutes: _s, outcomesBySeat: _o, total: _t, ...m } = s;
  void _r; void _u; void _s; void _o; void _t;
  return { ...m, total: total2(m) };
}

function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(Math.round(n));
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
