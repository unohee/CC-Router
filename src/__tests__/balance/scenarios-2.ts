/**
 * Run-2 pools for the balance simulator. FROZEN after the milestone that
 * introduced them, with score-2.ts and docs/balance/baseline-2.json, under the
 * same rule as scenarios.ts: a placement change is judged against these exact
 * pools and may not reshape them.
 *
 * Why a second file: the run-1 pools could not show what the first live hour
 * of the balance rules showed (2026-11-19 05:45-06:45Z). In the live-snapshot
 * pool kyte is on pace (ratio 0.92), so the "every seat behind pace" state
 * never arises; and none of them models the admission throttle, so a policy
 * that stacks one seat's queue (kyte: 501 waits, 4,929 s in that hour, while
 * heewon and vega had 8 free slots) costs nothing in them.
 *
 * Calibration, from mini on 2026-11-19 ~07:00Z (read-only):
 * - Weekly ratios heewon 0.68, vega 0.81, kyte 0.87 (every seat under
 *   1 - slack = 0.9); lyra and rigel over the 0.98 cap with 25 h and 15 h to
 *   their resets.
 * - Throttle: `perAccountMaxInFlight` 4, `maxWaitMs` 20000 (live config);
 *   p50 finish 4.8 s, p95 33.8 s since the deploy. Service time is taken as
 *   12 s, between the two, so the model neither frees slots every tick nor
 *   holds them for the whole minute.
 * - kyte reports no 5-hour window; its 5-hour cap in `kyte-five-hour` is an
 *   ASSUMED 15% of its week (as the Team seats are modelled), not a
 *   measurement: the pool exists so that concentrating on kyte can cost
 *   something in the simulator, not to assert kyte's limit.
 */
import type { Scenario, SeatSpec, DemandSpec, ScenarioEvents } from "./scenarios.js";

export interface ThrottleSpec {
  /** Requests a seat serves at once (live: 4). */
  perAccountMaxInFlight: number;
  /** How long a request holds a slot. */
  serviceSeconds: number;
  /** Longest a request waits before it goes anyway (live: 20). */
  maxWaitSeconds: number;
}

export interface ScenarioEvents2 extends ScenarioEvents {
  /** Documentation only: the seat whose weekly reset the pool is about. The
   *  reset itself is in that seat's `weeklyResetH`. */
  freshResetSeat?: string;
}

/** A run-1 scenario plus the admission throttle. `simulate` takes either. */
export interface Scenario2 extends Scenario {
  throttle?: ThrottleSpec;
  events?: ScenarioEvents2;
}

const WEEK_5X = 450e6;
const WEEK_20X = 920e6;
const FIVE_5X = 0.15 * WEEK_5X;
const FIVE_20X = 0.15 * WEEK_20X;

const WORKDAY = [
  0.6, 0.4, 0.2, 0.08, 0.05, 0.05, 0.05, 0.08, 0.3, 0.8, 1, 1,
  1, 1, 1, 1, 1, 1, 0.9, 0.9, 1, 1, 0.9, 0.8,
];

const DEMAND: DemandSpec = {
  sessionsPerDay: 210,
  profile: WORKDAY,
  sessionMinutes: [30, 240],
  requestChance: 0.6,
  prefix: { start: 25_000, perRequest: 1_500, max: 350_000 },
  freshInput: 3_000,
  output: 600,
  noSessionShare: 0.08,
  noSessionCost: 3_000,
};

const LIVE_ROUTING = { softCapUtil: 0.98, weeklyPace: { enabled: true, fiveHour: true } };
const LIVE_THROTTLE: ThrottleSpec = { perAccountMaxInFlight: 4, serviceSeconds: 12, maxWaitSeconds: 20 };

/**
 * The live pool at 2026-11-19 07:00Z: every seat under the cap is behind pace
 * (weekly ratios 0.68 / 0.81 / 0.87), the two near-limit seats are over it.
 * Utilizations are chosen so the ratios match: ratio = (1 - util) / (hoursLeft / 168).
 */
const BEHIND_SEATS: SeatSpec[] = [
  { id: "rigel", weeklyCap: WEEK_5X, fiveHourCap: FIVE_5X, weeklyUtil: 0.98, weeklyResetH: 39, fiveHourUtil: 0.01, fiveHourResetMin: 200 },
  { id: "lyra", weeklyCap: WEEK_5X, fiveHourCap: FIVE_5X, weeklyUtil: 0.98, weeklyResetH: 49, fiveHourUtil: 0.31, fiveHourResetMin: 200 },
  { id: "heewon", weeklyCap: WEEK_5X, fiveHourCap: FIVE_5X, weeklyUtil: 0.66, weeklyResetH: 84, fiveHourUtil: 0.11, fiveHourResetMin: 240 },
  { id: "vega", weeklyCap: WEEK_5X, fiveHourCap: FIVE_5X, weeklyUtil: 0.53, weeklyResetH: 97, fiveHourUtil: 0.16, fiveHourResetMin: 200 },
  { id: "kyte", weeklyCap: WEEK_20X, fiveHourCap: 0, weeklyUtil: 0.25, weeklyResetH: 145 },
];

/**
 * The live day's shape, denser than the run-1 demand: the same ~1,100
 * sessions a week but more requests each (the live pool sent ~800 requests an
 * hour to one seat), which is what fills a four-slot queue.
 */
const DENSE: DemandSpec = { ...DEMAND, requestChance: 0.9, sessionMinutes: [45, 300] };

export const SCENARIOS_2: Scenario2[] = [
  {
    name: "all-ahead",
    description: "The live pool at 07:00Z over one day: every seat under the cap is behind its weekly pace and no reset falls inside the run, with the live throttle. The first live hour put every new session on one seat while two others had free slots.",
    seed: 2101, days: 1, seats: BEHIND_SEATS, routing: LIVE_ROUTING, historyAvailable: true, throttle: LIVE_THROTTLE,
    demand: DENSE,
  },
  {
    name: "fresh-reset",
    description: "The same pool over two days, where vega's week resets 6 hours in while the others stay behind pace: a Team seat with a fresh week appears beside the Max 20x seat that still has most of its week. Today the fresh seat is the only candidate until it has spent ~10% of its week.",
    seed: 2207, days: 2, routing: LIVE_ROUTING, historyAvailable: true, throttle: LIVE_THROTTLE,
    seats: BEHIND_SEATS.map(s => s.id === "vega" ? { ...s, weeklyResetH: 6 } : s),
    demand: DENSE,
    events: { freshResetSeat: "vega" },
  },
  {
    name: "deploy-restore",
    description: "The same pool at a reload: 40 large sessions are restored onto heewon and vega, behind pace, with readings kept. Counts what the first half hour after a deploy does to those pins.",
    seed: 2303, days: 1, seats: BEHIND_SEATS, routing: LIVE_ROUTING, historyAvailable: true, throttle: LIVE_THROTTLE,
    demand: DENSE,
    events: { restoredPins: { perSeat: { heewon: 20, vega: 20 }, prefix: 250_000 } },
  },
  {
    name: "kyte-five-hour",
    description: "The same pool where kyte has an ASSUMED five-hour cap of 15% of its week and reports it (live it reports none), so that concentrating on kyte can run its five-hour window dry.",
    seed: 2409, days: 2, routing: LIVE_ROUTING, historyAvailable: true, throttle: LIVE_THROTTLE,
    seats: BEHIND_SEATS.map(s => s.id === "kyte" ? { ...s, fiveHourCap: FIVE_20X, fiveHourUtil: 0.3, fiveHourResetMin: 180 } : s),
    demand: DENSE,
  },
];
