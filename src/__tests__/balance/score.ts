/**
 * How a simulated run is scored. FROZEN after the milestone that introduced it:
 * later changes to placement are judged by this file and by
 * docs/balance/baseline.json, and must not edit either (the milestone checks
 * run `git diff --quiet origin/main -- <these files>`). A new measure goes in a
 * new file with its own baseline.
 *
 * Every amount is in cost-weighted tokens (input 1, output 5, cache write 1.25,
 * cache read 0.1; the weights of supply-model.ts), the unit a seat's quota is
 * spent in, so amounts on different seats add up.
 */

export interface RunMetrics {
  /** Quota left in a seat's 7-day window when that window reset, summed over
   *  every reset inside the run. Quota not spent by the reset is lost. */
  unusedAtReset: number;
  /** Demand no seat served: the request was refused by every seat, or no seat
   *  was available to try. */
  dry: number;
  /** Cache rewrites: a session served by a seat other than the one holding its
   *  prompt cache re-writes its whole prefix there (prefix x 1.25). Covers pin
   *  moves and failover alike. */
  moveCost: number;
  /** Demand offered over the run, served or not. */
  demand: number;
  /** Requests a seat refused because one of its windows was exhausted. */
  refusals: number;
  /** Number of cache rewrites (the count behind `moveCost`). */
  moves: number;
  /** Minutes during which some seat could not serve because a window was
   *  exhausted while another seat still had at least 20% of its week left. */
  strandedMinutes: number;
}

/**
 * Unserved demand weighs more than unused quota: a refused request is a client
 * that waited or failed, while unused quota is only a missed opportunity.
 */
export const DRY_WEIGHT = 3;

/** One number to compare runs by. Lower is better. */
export function total(m: RunMetrics): number {
  return m.unusedAtReset + DRY_WEIGHT * m.dry + m.moveCost;
}

export interface ScenarioScore extends RunMetrics {
  total: number;
}

export function score(m: RunMetrics): ScenarioScore {
  return { ...m, total: total(m) };
}

/**
 * Tolerances for "no worse than the baseline". The simulator is deterministic,
 * so the current policy reproduces its baseline exactly; the slack exists only
 * so a policy that is better overall is not failed by noise-sized shifts.
 */
export const TOLERANCE = {
  /** `total` may exceed the baseline by this fraction of the scenario's demand. */
  totalOfDemand: 0.002,
  /** `dry` may exceed the baseline by this fraction of the scenario's demand. */
  dryOfDemand: 0.001,
} as const;

/** Why `current` is worse than `baseline` on one scenario; empty when it is not. */
export function regressions(name: string, current: ScenarioScore, baseline: ScenarioScore): string[] {
  const out: string[] = [];
  const slackTotal = TOLERANCE.totalOfDemand * baseline.demand;
  const slackDry = TOLERANCE.dryOfDemand * baseline.demand;
  if (current.total > baseline.total + slackTotal) {
    out.push(`${name}: total ${fmt(current.total)} > baseline ${fmt(baseline.total)}`);
  }
  if (current.dry > baseline.dry + slackDry) {
    out.push(`${name}: dry ${fmt(current.dry)} > baseline ${fmt(baseline.dry)}`);
  }
  return out;
}

/** Strictly better: lower total by more than the tolerance. */
export function strictlyBetter(current: ScenarioScore, baseline: ScenarioScore): boolean {
  return current.total < baseline.total - TOLERANCE.totalOfDemand * baseline.demand;
}

function fmt(n: number): string {
  return `${(n / 1e6).toFixed(1)}M`;
}
