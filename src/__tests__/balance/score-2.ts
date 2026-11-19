/**
 * Scoring for the run-2 pools (scenarios-2.ts). FROZEN after the milestone
 * that introduced it, like score.ts, which it extends and does not edit.
 *
 * Adds two costs to the run-1 metrics.
 *
 * 1. Time requests spent in a seat's admission queue. The live finding behind
 *    run 2 was not refusals but a queue (one seat at 4/4 with 501 waits in an
 *    hour while 8 slots sat free), so a policy that stacks a seat's queue
 *    must score for it.
 * 2. Spend past the pace line in windows still open at the end of the run
 *    (`overspendAtEnd`): a seat driven past an even spend plus the pacing
 *    slack has that much less for the rest of its week. The run-1 score sees
 *    only under-spend at the end, so on a one-day pool a policy could drain a
 *    seat to empty its queue and score as balance; this charges the drain.
 *
 * Unit: cost-weighted tokens, as in score.ts. A second of queue wait is priced
 * at QUEUE_WAIT_TOKENS_PER_SECOND so that the live hour's 4,929 s of waiting
 * (about 6 s per request on 802 requests) costs about as much as the
 * requests it delayed: 802 requests x ~9K tokens each ≈ 7.4M, over 4,929 s ≈
 * 1.5K tokens per second. A rewrite of a 250K prefix (312K) is then worth
 * about 200 s of waiting, which keeps moves and queues on one scale without
 * letting either dominate.
 */
import { DRY_WEIGHT, TOLERANCE, type RunMetrics, type ScenarioScore } from "./score.js";

export const QUEUE_WAIT_TOKENS_PER_SECOND = 1_500;

export interface RunMetrics2 extends RunMetrics {
  /** Cost-weighted tokens spent past the pace line in windows open at the end. */
  overspendAtEnd: number;
  /** Seconds requests waited in admission queues, summed over seats. */
  queueWait: number;
  /** The most any one seat's queue held over the run, in seconds. */
  queueWaitMaxSeat: number;
}

export interface ScenarioScore2 extends RunMetrics2 {
  total: number;
}

export function total2(m: RunMetrics2): number {
  return m.unusedAtReset + m.shortfallAtEnd + m.overspendAtEnd + DRY_WEIGHT * m.dry + m.moveCost + QUEUE_WAIT_TOKENS_PER_SECOND * m.queueWait;
}

export function score2(m: RunMetrics2): ScenarioScore2 {
  return { ...m, total: total2(m) };
}

export const TOLERANCE_2 = {
  ...TOLERANCE,
  /** `queueWait` may exceed the baseline by this fraction of the baseline's. */
  queueWaitRelative: 0.02,
} as const;

/** Why `current` is worse than `baseline` on one run-2 scenario; empty when it is not. */
export function regressions2(name: string, current: ScenarioScore2, baseline: ScenarioScore2): string[] {
  const out: string[] = [];
  if (Math.abs(current.demand - baseline.demand) > 0.02 * baseline.demand) {
    out.push(`${name}: demand ${fmt(current.demand)} differs from the baseline's ${fmt(baseline.demand)}: the workload changed`);
  }
  if (current.total > baseline.total + TOLERANCE_2.totalOfDemand * baseline.demand) {
    out.push(`${name}: total ${fmt(current.total)} > baseline ${fmt(baseline.total)}`);
  }
  if (current.dry > baseline.dry + TOLERANCE_2.dryOfDemand * baseline.demand) {
    out.push(`${name}: dry ${fmt(current.dry)} > baseline ${fmt(baseline.dry)}`);
  }
  if (current.queueWait > baseline.queueWait * (1 + TOLERANCE_2.queueWaitRelative) + 60) {
    out.push(`${name}: queue wait ${Math.round(current.queueWait)}s > baseline ${Math.round(baseline.queueWait)}s`);
  }
  return out;
}

/** Strictly better: lower total by more than the tolerance, and no more queue wait. */
export function strictlyBetter2(current: ScenarioScore2, baseline: ScenarioScore2): boolean {
  return current.total < baseline.total - TOLERANCE_2.totalOfDemand * baseline.demand
    && current.queueWait <= baseline.queueWait * (1 + TOLERANCE_2.queueWaitRelative) + 60;
}

function fmt(n: number): string {
  return `${(n / 1e6).toFixed(1)}M`;
}
