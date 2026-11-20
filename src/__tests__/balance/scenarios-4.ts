/**
 * Run-4 pool for the balance simulator: a second capture of the live pool,
 * this time started where each seat really was, and run for a full week so
 * every seat's weekly reset falls inside it. FROZEN after the milestone that
 * introduced it, with docs/balance/baseline-4.json, under the same rule as
 * scenarios.ts, scenarios-2.ts and scenarios-3.ts: a placement change is
 * judged against this exact pool and may not reshape it.
 *
 * Why a second capture: live-week (scenarios-3.ts) started each seat from its
 * newest hourly quota-history reading, which for lyra was four hours old
 * (97% while the live seat was at the 98% cap); the first live check
 * (docs/balance/live-outcomes-2026-11-20.md) missed lyra's stranded minutes by
 * 44% for that reason alone. scripts/balance-capture.mjs now takes each seat's
 * start from health's accounts[].rateLimits when that is newer than the
 * reading and from within the start hour (startState()).
 *
 * Built by `scripts/balance-capture.mjs` from the files in
 * docs/balance/capture-2026-11-20-week/ (quota-history 14d, usage-series 7d,
 * usage-history, health cut to the fields the script reads, and the routing
 * and throttle sections of mini's config), all read-only from mini at
 * 2026-11-20T10:29Z (health, usage and quota history by GET; the quota
 * history's secret was read on mini and never left it; config sections by
 * ssh), build 3f6ba11. The directory is suffixed "-week" because
 * capture-2026-11-20/ already holds the inputs of that day's outcomes report.
 *
 *   node scripts/balance-capture.mjs --quota .../quota-history.json \
 *     --series .../usage-series-7d.json --usage .../usage-history.json \
 *     --config .../config.json --health .../health.json \
 *     --start 2026-11-20T10:00Z --days 7 --seed 4101 --name live-week-2 \
 *     --out .../live-week-2.scenario.json
 *
 * The scenario below is that output, typed; balance-sim-4.test.ts checks the
 * two agree.
 *
 * Every figure below and where it came from (the script's `notes`):
 * - Start 2026-11-20T10:00Z, the hour of the capture (fetched 10:29Z, 29
 *   minutes into it).
 * - Start state per seat (source, taken at, age before the start hour ended):
 *   heewon  health 10:25:37Z, 0.6 h (hourly reading 10:20Z): week 85%, reset
 *           in 57 h; 5-hour 6%, reset in 290 min.
 *   kyte    health 10:29:20Z, 0.5 h (reading 10:01Z): week 60%, reset in
 *           118 h; no 5-hour window (the reading's, which has none).
 *   lyra    health 10:29:28Z, 0.5 h (reading 10:00Z): week 13%, reset in
 *           166 h (its week reset 2026-11-20T08:00Z); 5-hour 81%, reset in
 *           230 min.
 *   rigel   health 08:56:02Z, 2.1 h (reading 08:00Z; no response since,
 *           its 5-hour window at the cap): week 16%, reset in
 *           156 h; 5-hour 98%, reset in 40 min.
 *   vega    health 10:25:59Z, 0.6 h (reading 10:16Z): week 71%, reset in
 *           70 h; 5-hour 6%, reset in 140 min.
 * - Weekly caps, all MEASURED by the seat-size pairing (>= 3 pairs, >= 0.08
 *   moved, 14-day window): heewon 246.3M (23 pairs over 43.1 h, moved 0.30,
 *   +/-3.3%; live-week had 404.2M from 14 pairs over 17.7 h, outside each
 *   other's bands: the seat size moved, or one of the two pairings is off),
 *   kyte 606.8M (30 pairs, +/-2.0%), lyra
 *   482.3M (5 pairs, moved 0.12, +/-8.3%), rigel 401.7M (9 pairs, moved 0.09,
 *   +/-11.1%), vega 399.3M (33 pairs, +/-2.5%).
 * - 5-hour caps measured: heewon 56.6M (+/-1.0%), lyra 77.1M (+/-1.3%), rigel
 *   65.2M (+/-2.1%), vega 63.4M (+/-0.5%); kyte never reported a 5-hour
 *   window: 0.
 * - Demand: 7,830 requests a day from the usage-history 1-day window (the
 *   series' 7-day mean is 11,757); hourly profile folded by UTC hour over the
 *   7-day series and rotated by 10 h so simulated hour 0 is UTC 10:00. Token
 *   sizes per request from the 1-day totals: input 747, output 852, prefix
 *   182,922 (cache read) growing 7,652 a request (cache write); prefix cap
 *   ASSUMED max(2 x start, 350,000) = 365,844; noSessionCost 5,194.
 *   noSessionShare 0 (0 of 48 recent /messages entries lacked a session id).
 *   sessionsPerDay 117 from health balance.placements.lastDay.placed, above
 *   the floor 97; requestChance 0.496. ASSUMED: session lengths [30, 240] min.
 * - Routing: mini's config.routing verbatim (softCapUtil 0.98, weeklyPace
 *   with fiveHour). Throttle: 4 in flight, startUtil 0.75, hardUtil 0.95 from
 *   config; maxWaitSeconds 20 (throttle.ts default, config has none);
 *   serviceSeconds 3.6 from health performance.pool.p50Ms.
 * - seed 4101, SEVEN days: heewon (57 h), vega (70 h), kyte (118 h), rigel
 *   (156 h) and lyra (166 h) all reset inside the run, so the live-outcomes
 *   report a week from the capture can judge every seat against it.
 */
import type { Scenario2 } from "./scenarios-2.js";

export const LIVE_WEEK_2: Scenario2 = {
  name: "live-week-2",
  description: "The live pool captured at 2026-11-20T10:00Z (docs/balance/capture-2026-11-20-week) with each seat started from health's live rate limits, over seven days at the last day's rate: every seat's weekly reset inside the run, kyte without a 5-hour window.",
  seed: 4101,
  days: 7,
  seats: [
    { id: "heewon", weeklyCap: 246_261_497, fiveHourCap: 56_617_504, weeklyUtil: 0.85, weeklyResetH: 57, fiveHourUtil: 0.06, fiveHourResetMin: 290 },
    { id: "kyte", weeklyCap: 606_775_443, fiveHourCap: 0, weeklyUtil: 0.6, weeklyResetH: 118 },
    { id: "lyra", weeklyCap: 482_319_063, fiveHourCap: 77_079_184, weeklyUtil: 0.13, weeklyResetH: 166, fiveHourUtil: 0.81, fiveHourResetMin: 230 },
    { id: "rigel", weeklyCap: 401_705_859, fiveHourCap: 65_170_057, weeklyUtil: 0.16, weeklyResetH: 156, fiveHourUtil: 0.98, fiveHourResetMin: 40 },
    { id: "vega", weeklyCap: 399_294_067, fiveHourCap: 63_365_123, weeklyUtil: 0.71, weeklyResetH: 70, fiveHourUtil: 0.06, fiveHourResetMin: 140 },
  ],
  demand: {
    sessionsPerDay: 117,
    profile: [0.69, 0.5, 0.69, 0.87, 0.83, 0.75, 0.5, 0.32, 0.15, 0.12, 0.08, 0.2, 0.24, 0.42, 0.37, 0.18, 0.61, 0.71, 0.44, 0.8, 0.71, 0.62, 0.91, 1],
    sessionMinutes: [30, 240],
    requestChance: 0.496,
    prefix: { start: 182_922, perRequest: 7_652, max: 365_844 },
    freshInput: 747,
    output: 852,
    noSessionShare: 0,
    noSessionCost: 5_194,
  },
  routing: { softCapUtil: 0.98, weeklyPace: { enabled: true, fiveHour: true } },
  historyAvailable: true,
  throttle: { perAccountMaxInFlight: 4, startUtil: 0.75, hardUtil: 0.95, serviceSeconds: 3.6, maxWaitSeconds: 20 },
};

export const SCENARIOS_4: Scenario2[] = [LIVE_WEEK_2];
