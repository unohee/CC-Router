/**
 * The pools the balance simulator (sim.ts) runs. FROZEN after the milestone
 * that introduced it, together with score.ts and docs/balance/baseline.json:
 * a placement change is judged against these exact pools and may not reshape
 * them. A new pool goes in a new file with its own baseline.
 *
 * Calibration, from the live router on 2026-11-19 (read-only):
 * - Four Team max_5x seats and one personal Max 20x seat (kyte). Spend per
 *   7-day point measured from quota-history: about 4.5M cost-weighted tokens on
 *   the max_5x seats and about 9.2M on kyte, so a week is ~450M and ~920M.
 * - kyte reports no 5-hour window. The 5-hour capacity of a max_5x seat is not
 *   measured; it is taken as 15% of its week (about seven full windows a week),
 *   consistent with a seat going 36% -> 99% of its 5-hour window in ~45 minutes
 *   of heavy use.
 * - Pool demand forecast was ~289M per day against ~388M per day of capacity
 *   (about 75%), arriving mostly between 09:00 and 02:00.
 * - `routing` is the live config block, verbatim: soft cap 0.98, weekly pacing
 *   with the 5-hour window paced too. The simulator reads it with the router's
 *   own parsers.
 */

export interface SeatSpec {
  id: string;
  /** Cost-weighted tokens in a full 7-day window. */
  weeklyCap: number;
  /** Cost-weighted tokens in a full 5-hour window; 0 means the seat reports no
   *  5-hour window. */
  fiveHourCap: number;
  /** Share of the current 7-day window spent at the start. */
  weeklyUtil: number;
  /** Hours from the start until the 7-day window resets. */
  weeklyResetH: number;
  /** Share of the current 5-hour window spent at the start (0 when none is open). */
  fiveHourUtil?: number;
  /** Minutes until the open 5-hour window resets; absent means none is open. */
  fiveHourResetMin?: number;
}

export interface DemandSpec {
  /** New sessions per day, spread over the day by `profile`. */
  sessionsPerDay: number;
  /** Relative arrival weight per hour of day (24 entries, simulation clock). */
  profile: number[];
  /** Session length in minutes, uniform between the two. */
  sessionMinutes: [number, number];
  /** Chance an active session sends a request in a given minute. */
  requestChance: number;
  /** Prompt prefix: starting size and growth per request, in tokens, capped. */
  prefix: { start: number; perRequest: number; max: number };
  /** Per request: fresh input written to the cache, and output, in tokens. */
  freshInput: number;
  output: number;
  /** Share of requests that carry no session id (routed by the pool alone). */
  noSessionShare: number;
  /** Cost-weighted tokens of one request without a session id. */
  noSessionCost: number;
}

export interface ScenarioEvents {
  /** Every seat's readings are lost at this hour (a restart before readings
   *  were persisted, or a deploy that drops them). Pins survive. */
  wipeReadingsAtH?: number;
  /** A burst of new sessions arriving together. */
  burst?: { atH: number; sessions: number; withinMin: number };
  /** Sessions already pinned when the run starts (restored at a deploy), with
   *  their prompt prefix already this large. */
  restoredPins?: { perSeat: Record<string, number>; prefix: number };
}

export interface Scenario {
  name: string;
  description: string;
  seed: number;
  days: number;
  seats: SeatSpec[];
  demand: DemandSpec;
  /** The `routing` block of config.json, verbatim. */
  routing: Record<string, unknown>;
  /** Whether the run may expose spend history to a policy that estimates seat
   *  size. False models a router that has no quota history yet. */
  historyAvailable: boolean;
  events?: ScenarioEvents;
}

const WEEK_5X = 450e6;
const WEEK_20X = 920e6;
const FIVE_5X = 0.15 * WEEK_5X;

/** Busy 09:00-02:00, quiet overnight. */
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

/** The live pool at 2026-11-19 04:29Z. */
const LIVE_SEATS: SeatSpec[] = [
  { id: "rigel", weeklyCap: WEEK_5X, fiveHourCap: FIVE_5X, weeklyUtil: 0.98, weeklyResetH: 17.5, fiveHourUtil: 0.01, fiveHourResetMin: 217 },
  { id: "lyra", weeklyCap: WEEK_5X, fiveHourCap: FIVE_5X, weeklyUtil: 0.95, weeklyResetH: 27.5, fiveHourUtil: 0.13, fiveHourResetMin: 217 },
  { id: "heewon", weeklyCap: WEEK_5X, fiveHourCap: FIVE_5X, weeklyUtil: 0.65, weeklyResetH: 86.5, fiveHourUtil: 0.03, fiveHourResetMin: 247 },
  { id: "vega", weeklyCap: WEEK_5X, fiveHourCap: FIVE_5X, weeklyUtil: 0.53, weeklyResetH: 99.5, fiveHourUtil: 0.16, fiveHourResetMin: 217 },
  { id: "kyte", weeklyCap: WEEK_20X, fiveHourCap: 0, weeklyUtil: 0.19, weeklyResetH: 147.5 },
];

/** Five equal seats, fresh, weekly resets a day apart. */
const EQUAL_SEATS: SeatSpec[] = ["s1", "s2", "s3", "s4", "s5"].map((id, i) => ({
  id, weeklyCap: WEEK_5X * 1.2, fiveHourCap: FIVE_5X * 1.2, weeklyUtil: 0.15 * i, weeklyResetH: 24 * (i + 1),
}));

export const SCENARIOS: Scenario[] = [
  {
    name: "live-snapshot",
    description: "The live pool on 2026-11-19: two seats near their weekly limit with resets close, two Team seats with room, and the Max 20x seat at 19% with six days left.",
    seed: 1119, days: 8, seats: LIVE_SEATS, demand: DEMAND, routing: LIVE_ROUTING, historyAvailable: true,
  },
  {
    name: "equal-seats",
    description: "Five equal fresh seats with staggered weekly resets and the same demand.",
    seed: 2201, days: 8, seats: EQUAL_SEATS, demand: DEMAND, routing: LIVE_ROUTING, historyAvailable: true,
  },
  {
    name: "unknown-capacity",
    description: "The live pool, but no spend history exists, so a size estimate has nothing to work from.",
    seed: 3307, days: 8, seats: LIVE_SEATS, demand: DEMAND, routing: LIVE_ROUTING, historyAvailable: false,
  },
  {
    name: "restart-wiped",
    description: "The live pool, with every seat's readings lost 30 hours in while pins survive: until a seat serves again its utilization reads as 0.",
    seed: 4409, days: 8, seats: LIVE_SEATS, demand: DEMAND, routing: LIVE_ROUTING, historyAvailable: true,
    events: { wipeReadingsAtH: 30 },
  },
  {
    name: "session-burst",
    description: "The live pool with 60 new sessions arriving within 5 minutes on the first afternoon (a fan-out of subagents).",
    seed: 5501, days: 8, seats: LIVE_SEATS, demand: DEMAND, routing: LIVE_ROUTING, historyAvailable: true,
    events: { burst: { atH: 14, sessions: 60, withinMin: 5 } },
  },
  {
    name: "no-session-id",
    description: "The live pool where 40% of requests carry no session id and are placed by the pool alone.",
    seed: 6607, days: 8, seats: LIVE_SEATS, routing: LIVE_ROUTING, historyAvailable: true,
    demand: { ...DEMAND, noSessionShare: 0.4, sessionsPerDay: 150, noSessionCost: 12_000 },
  },
  {
    name: "restored-pins",
    description: "The live pool at a deploy: 40 large sessions are already pinned to the two seats near their weekly limit.",
    seed: 7703, days: 8, seats: LIVE_SEATS, demand: DEMAND, routing: LIVE_ROUTING, historyAvailable: true,
    events: { restoredPins: { perSeat: { rigel: 20, lyra: 20 }, prefix: 250_000 } },
  },
  {
    name: "live-heavy",
    description: "The live pool under a heavy week (1.8x the demand, more than the pool holds, as in the week of 2026-11-04 when every seat reached its limit): seats run dry and pins are pushed around.",
    seed: 9901, days: 8, seats: LIVE_SEATS, routing: LIVE_ROUTING, historyAvailable: true,
    demand: { ...DEMAND, sessionsPerDay: DEMAND.sessionsPerDay * 1.8 },
  },
  {
    name: "five-hour-ping-pong",
    description: "Heavy bursty sessions on equal seats with small 5-hour windows: early in a window a burst puts a seat ahead of its 5-hour pace, which can move pins back and forth.",
    seed: 8803, days: 4, seats: EQUAL_SEATS.map(s => ({ ...s, fiveHourCap: s.fiveHourCap * 0.5 })), routing: LIVE_ROUTING, historyAvailable: true,
    demand: { ...DEMAND, sessionsPerDay: 160, requestChance: 0.9, prefix: { start: 60_000, perRequest: 3_000, max: 400_000 } },
  },
];
