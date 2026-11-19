/**
 * Run-3 pool for the balance simulator: the live pool as the router RECORDED
 * it, not as a person described it. FROZEN after the milestone that introduced
 * it, with score-3.ts and docs/balance/baseline-3.json, under the same rule as
 * scenarios.ts and scenarios-2.ts: a placement change is judged against this
 * exact pool and may not reshape it.
 *
 * Built by `scripts/balance-capture.mjs` from the files in
 * docs/balance/capture-2026-11-19/ (quota-history 7d, usage-series 7d,
 * usage-history, health, and the routing/throttle sections of mini's config),
 * all read-only GETs from mini on 2026-11-19 ~09:26Z (health re-read at
 * ~10:05Z and cut to the fields the script reads), build 604e9de:
 *
 *   node scripts/balance-capture.mjs --quota .../quota-history.json \
 *     --series .../usage-series-7d.json --usage .../usage-history.json \
 *     --config .../config.json --health .../health.json \
 *     --start 2026-11-19T09:00Z --days 2 --out .../live-week.scenario.json
 *
 * The scenario below is that output, typed; balance-sim-3.test.ts checks the
 * two agree.
 *
 * Every figure below and where it came from (the script's `notes`):
 * - Start 2026-11-19T09:00Z: the newest hour at which kyte is measurable
 *   (18 pairs); the default start (03:00Z, the last hour with a reading for
 *   every seat) left kyte at the median cap.
 * - Seats, from each seat's newest reading at or before the start:
 *   heewon 68% of its week, reset in 82 h, cap 404.2M measured from 14 pairs
 *     over 17.7 h (moved 0.14, ±7.1%); 5-hour cap 65.0M measured (11 pairs,
 *     ±1.5%), 7% used, reset in 280 min.
 *   kyte 36%, reset in 143 h, cap 694.8M measured from 18 pairs over 17.7 h
 *     (moved 0.27, ±3.7%); never reported a 5-hour window: fiveHourCap 0.
 *     (Health reads this as 1.55x the median seat.)
 *   lyra 97%, reset in 23 h; cap UNMEASURED (3 pairs moved 0.04): the median
 *     measured cap 447.1M; 5-hour cap ASSUMED 15% of the week (2 pairs);
 *     newest reading 4 h before the start, so its utilization may be stale.
 *   rigel 98%, reset in 13 h; cap UNMEASURED (5 pairs moved 0.04): the median
 *     447.1M; 5-hour cap 100.5M measured from 3 pairs (moved 0.14, ±7.1%);
 *     newest reading 6 h before the start.
 *   vega 54%, reset in 95 h, cap 447.1M measured from 17 pairs over 17.8 h
 *     (moved 0.23, ±4.3%); 5-hour cap 72.6M measured (13 pairs, ±1.0%), 4%
 *     used, reset in 260 min.
 *   lyra's and rigel's resets fall inside the one-day run: the pool records
 *   what they leave unused, as the live router will within the day.
 * - Demand: 21,718 requests a day, the usage-history 1-day window (the day
 *   before the capture; the 7-day mean was 10,986, half of it, and the quota
 *   history's spend over the 18 h before the capture, 386M cost-weighted,
 *   runs at 515M a day, so the seats were meeting the recent rate, not the
 *   week's). The hourly profile is the series' requests folded by UTC hour
 *   over 7 days, normalised to the peak, then ROTATED by 9 h so simulated
 *   hour 0 carries UTC hour 09's demand (the simulator's clock starts at
 *   00:00). Token sizes per request from the 1-day totals: fresh input 674,
 *   output 742, prefix 173,708 (cache read per request) growing 5,311 a
 *   request (cache write per request); prefix cap ASSUMED max(2 x start,
 *   350,000); noSessionCost = 1.25 x 674 + 5 x 742 = 4,553 (weights input 1,
 *   output 5, cache write 1.25, cache read 0.1). noSessionShare 0: 0 of 49
 *   recent /messages log entries lacked a session id (count_tokens is not
 *   logged, so requests outside sessions may be undercounted; the simulator
 *   then shows the case where only sessions reach the seats). sessionsPerDay
 *   269: the floor that keeps requestChance at or under 0.6 (health
 *   placements.lastDay.placed was 15, which cannot carry 22K requests a day);
 *   requestChance 0.598 from requestsPerDay / (269 x 135). ASSUMED, not
 *   recorded: session lengths [30, 240] min.
 * - Routing: mini's config.routing verbatim (softCapUtil 0.98, weeklyPace
 *   enabled with fiveHour). Throttle: perAccountMaxInFlight 4, startUtil
 *   0.75, hardUtil 0.95 from config; maxWaitSeconds 20 (config has no
 *   maxWaitMs; throttle.ts default); serviceSeconds 5.5 from health
 *   performance.pool.p50Ms.
 * - seed 3101, TWO days: lyra's and rigel's resets fall in the first, and the
 *   second shows the pool with those two seats fresh while the other three
 *   run down (in the current policy's baseline heewon and vega reach the cap
 *   there). History available (the simulator seeds the last eight hours of
 *   readings as it does for every pool).
 *
 * What the capture already showed (probed while freezing this file): a seat
 * whose week has just reset is not shut out for long in this pool. Its weekly
 * reading is null, so paceTier drops it from the session pool, but a dry seat
 * (heewon, ratio 0.64) moves pins for pace and a null-week seat is a relief
 * target with infinite surplus, so the fresh seat answers a moved session
 * within a minute and is measured from then on. Letting unmeasured seats
 * compete for new sessions changed nothing here: served tokens and both
 * outcomes were identical to the baseline at 1, 2 and 4 days. The exclusion
 * bites only while no seat is dry and no request without a session arrives.
 */
import type { Scenario2 } from "./scenarios-2.js";

export const LIVE_WEEK: Scenario2 = {
  name: "live-week",
  description: "The live pool captured at 2026-11-19T09:00Z from the router's recorded quota and usage (docs/balance/capture-2026-11-19), over two days at the last day's rate: three seats behind pace, two at the cap whose weeks reset inside the first day, kyte without a 5-hour window.",
  seed: 3101,
  days: 2,
  seats: [
    { id: "heewon", weeklyCap: 404_200_091, fiveHourCap: 64_951_409, weeklyUtil: 0.68, weeklyResetH: 82, fiveHourUtil: 0.07, fiveHourResetMin: 280 },
    { id: "kyte", weeklyCap: 694_838_583, fiveHourCap: 0, weeklyUtil: 0.36, weeklyResetH: 143 },
    { id: "lyra", weeklyCap: 447_076_577, fiveHourCap: 67_061_487, weeklyUtil: 0.97, weeklyResetH: 23 },
    { id: "rigel", weeklyCap: 447_076_577, fiveHourCap: 100_487_297, weeklyUtil: 0.98, weeklyResetH: 13 },
    { id: "vega", weeklyCap: 447_076_577, fiveHourCap: 72_634_023, weeklyUtil: 0.54, weeklyResetH: 95, fiveHourUtil: 0.04, fiveHourResetMin: 260 },
  ],
  demand: {
    sessionsPerDay: 269,
    profile: [0.85, 0.57, 0.45, 0.73, 1, 0.96, 0.87, 0.58, 0.37, 0.16, 0.14, 0.1, 0.21, 0.26, 0.47, 0.43, 0.22, 0.67, 0.8, 0.5, 0.71, 0.85, 0.68, 0.81],
    sessionMinutes: [30, 240],
    requestChance: 0.598,
    prefix: { start: 173_708, perRequest: 5_311, max: 350_000 },
    freshInput: 674,
    output: 742,
    noSessionShare: 0,
    noSessionCost: 4_553,
  },
  routing: { softCapUtil: 0.98, weeklyPace: { enabled: true, fiveHour: true } },
  historyAvailable: true,
  throttle: { perAccountMaxInFlight: 4, startUtil: 0.75, hardUtil: 0.95, serviceSeconds: 5.5, maxWaitSeconds: 20 },
};

export const SCENARIOS_3: Scenario2[] = [LIVE_WEEK];
