import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./balance/scenarios.js";
import { SCENARIOS_2, type Scenario2 } from "./balance/scenarios-2.js";
import type { RunMetrics2 } from "./balance/score-2.js";
import { SCENARIOS_3 } from "./balance/scenarios-3.js";
import { poolOutcomes, regressions3, score3, strictlyBetter3, type RunMetrics3, type ScenarioScore3 } from "./balance/score-3.js";
import { simulate, type SimResult } from "./balance/sim.js";

// Run 3 grades placement by the outcomes the live router records about itself
// (quota-history.ts SeatOutcomes): the share of the week unused at each weekly
// reset and the seat-minutes at the soft cap while another seat had room,
// both computed in the simulator exactly as the router computes them, on the
// readings the simulated router holds. score-3.ts adds them to the run-2
// score. The pools are the four run-2 ones plus `live-week`
// (balance/scenarios-3.ts), built from mini's recorded readings and demand.
// docs/balance/baseline-3.json holds the current policy's scores on all five;
// no later change may score worse on any of them.
//
// To (re)write the baseline, which only the milestone that owns it does:
//   CC_ROUTER_BALANCE_WRITE_BASELINE_3=1 npx vitest run src/__tests__/balance-sim-3.test.ts

const BASELINE = fileURLToPath(new URL("../../docs/balance/baseline-3.json", import.meta.url));
const WRITE = process.env["CC_ROUTER_BALANCE_WRITE_BASELINE_3"] === "1";

interface BaselineFile { note: string; scenarios: Record<string, ScenarioScore3> }

export const POOLS_3: Scenario2[] = [...SCENARIOS_2, ...SCENARIOS_3];

const results = new Map<string, SimResult>();
export function run3(name: string): SimResult {
  const cached = results.get(name);
  if (cached) return cached;
  const sc = POOLS_3.find(s => s.name === name)!;
  const r = simulate(sc, { setClock: ms => vi.setSystemTime(ms) });
  results.set(name, r);
  return r;
}
/** The run-2 metrics of a result (as balance-sim-2.test.ts builds them; not imported from there, or its tests would run here too). */
function metrics2(r: SimResult): RunMetrics2 {
  const waits = Object.values(r.queueWaitBySeat);
  return { ...r.metrics, overspendAtEnd: r.overspendAtEnd, queueWait: waits.reduce((a, b) => a + b, 0), queueWaitMaxSeat: Math.max(0, ...waits) };
}
export function metrics3(r: SimResult): RunMetrics3 {
  const pool = poolOutcomes(r.outcomesBySeat);
  return { ...metrics2(r), resets: pool.resets, unusedShareAtReset: pool.unusedShareAtReset, strandedSeatMinutes: r.strandedSeatMinutes, outcomesBySeat: r.outcomesBySeat };
}

beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterAll(() => { vi.useRealTimers(); });

describe("the run-3 pools", () => {
  it("are the four run-2 pools and live-week, named once", () => {
    const names = POOLS_3.map(s => s.name);
    expect(SCENARIOS_3.map(s => s.name)).toEqual(["live-week"]);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some(n => SCENARIOS.some(s => s.name === n))).toBe(false);
  });

  it("live-week is the capture script's output for docs/balance/capture-2026-11-19, typed", () => {
    const live = SCENARIOS_3[0]!;
    const json = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/balance/capture-2026-11-19/live-week.scenario.json", import.meta.url)), "utf8")) as Scenario2 & { notes: string[] };
    const { notes: _n, capturedAt: _c, source: _s, ...fitted } = json as Scenario2 & { notes: unknown; capturedAt: unknown; source: unknown };
    void _n; void _c; void _s;
    expect({ ...fitted, description: live.description }).toEqual(live);
    expect(live.description).toMatch(/2026-11-19/);
    expect(live.seats.map(s => s.id).sort()).toEqual(["heewon", "kyte", "lyra", "rigel", "vega"]);
    expect(live.throttle).toMatchObject({ perAccountMaxInFlight: 4, startUtil: 0.75, hardUtil: 0.95 });
    expect(live.routing).toMatchObject({ softCapUtil: 0.98 });
  });

  for (const sc of POOLS_3) {
    it(`runs ${sc.name} and reports the live outcomes`, () => {
      const r = run3(sc.name);
      const m = metrics3(r);
      expect(Number.isFinite(m.strandedSeatMinutes) && m.strandedSeatMinutes >= 0).toBe(true);
      expect(m.unusedShareAtReset).toBeGreaterThanOrEqual(0);
      expect(m.unusedShareAtReset).toBeLessThanOrEqual(1);
      for (const s of sc.seats) expect(r.outcomesBySeat[s.id]).toBeDefined();
      // The pool-level share is the reset-weighted mean of the seats'.
      const seatsWith = Object.values(r.outcomesBySeat).filter(o => o.unusedAtReset !== null);
      expect(m.resets).toBe(seatsWith.reduce((n, o) => n + o.resets, 0));
    }, 180_000);
  }

  it("the simulated router sees the same resets upstream rolled: fresh-reset has one, and reads about what was left", () => {
    const r = run3("fresh-reset");
    const sc = POOLS_3.find(s => s.name === "fresh-reset")!;
    const seat = sc.seats.find(s => s.weeklyResetH < sc.days * 24)!;
    const o = r.outcomesBySeat[seat.id]!;
    expect(o.resets).toBe(r.utilAtReset[seat.id]!.length);
    // Read from headers rounded to 0.01, at most an hour of spend stale: within a few points of the true figure.
    const trueUnused = 1 - r.utilAtReset[seat.id]![0]!;
    expect(Math.abs(o.unusedAtReset! - trueUnused)).toBeLessThan(0.05);
  }, 180_000);

  it("stranded seat-minutes follow the live judgement: a pool with every seat under the cap has none; one with seats at the cap and room elsewhere has them, per seat as the store records them", () => {
    // equal-seats (run 1): fresh seats under the cap, demand under capacity.
    const under = simulate({ ...SCENARIOS.find(s => s.name === "equal-seats")!, days: 1 }, { setClock: ms => vi.setSystemTime(ms) });
    expect(under.strandedSeatMinutes).toBe(0);
    // all-ahead: lyra and rigel sit at 0.98 all day while heewon, vega and kyte have most of their weeks.
    const r = run3("all-ahead");
    expect(r.strandedSeatMinutes).toBeGreaterThan(0);
    expect(r.outcomesBySeat["rigel"]!.strandedMinutes + r.outcomesBySeat["lyra"]!.strandedMinutes).toBe(r.strandedSeatMinutes);
    expect(r.outcomesBySeat["kyte"]!.strandedMinutes).toBe(0);
  }, 180_000);

  it("score-3 is monotone in its costs and strictlyBetter3 wants an outcome better, not only the total", () => {
    const base = score3(metrics3(run3("all-ahead")));
    const same = score3({ ...base });
    expect(strictlyBetter3(same, base)).toBe(false);
    const fewerStranded = score3({ ...base, strandedSeatMinutes: Math.max(0, base.strandedSeatMinutes - 100) });
    expect(fewerStranded.total).toBeLessThanOrEqual(base.total);
    // Past the tolerance (5% of the baseline plus a 5-minute floor).
    const moreStranded = score3({ ...base, strandedSeatMinutes: base.strandedSeatMinutes * 1.1 + 100 });
    expect(regressions3("x", moreStranded, base).some(w => w.includes("stranded"))).toBe(true);
    const moreUnused = score3({ ...base, resets: Math.max(1, base.resets), unusedShareAtReset: base.unusedShareAtReset + 0.02 });
    expect(regressions3("x", moreUnused, base).some(w => w.includes("unused at reset"))).toBe(true);
    const lessUnused = score3({ ...base, resets: Math.max(1, base.resets), unusedShareAtReset: 0.1 });
    const worseBase = score3({ ...base, resets: Math.max(1, base.resets), unusedShareAtReset: 0.2 });
    expect(strictlyBetter3(lessUnused, worseBase)).toBe(true);
  }, 180_000);
});

describe("against baseline-3", () => {
  it(WRITE ? "writes docs/balance/baseline-3.json" : "is no worse than docs/balance/baseline-3.json on any run-3 pool", () => {
    const current: Record<string, ScenarioScore3> = {};
    for (const sc of POOLS_3) current[sc.name] = score3(metrics3(run3(sc.name)));
    if (WRITE) {
      mkdirSync(dirname(BASELINE), { recursive: true });
      const file: BaselineFile = {
        note: "Scores of the placement policy at the time the run-3 pools were added (balance rules as of PR #52, 2026-11-19), under score-3: the run-2 metrics plus the live outcomes (unused share at reset, stranded seat-minutes) as the simulated router reads them. Cost-weighted tokens; queueWait in seconds; strandedSeatMinutes in seat-minutes; unusedShareAtReset 0..1. Frozen: see src/__tests__/balance/score-3.ts.",
        scenarios: current,
      };
      writeFileSync(BASELINE, JSON.stringify(file, null, 2) + "\n");
      return;
    }
    expect(existsSync(BASELINE)).toBe(true);
    const base = JSON.parse(readFileSync(BASELINE, "utf8")) as BaselineFile;
    expect(Object.keys(base.scenarios).sort()).toEqual(POOLS_3.map(s => s.name).sort());
    const worse = POOLS_3.flatMap(sc => regressions3(sc.name, current[sc.name], base.scenarios[sc.name]));
    expect(worse).toEqual([]);
  }, 900_000);
});
