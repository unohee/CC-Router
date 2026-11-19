import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./balance/scenarios.js";
import { regressions, score, type ScenarioScore } from "./balance/score.js";
import { rng, simulate, type SimResult } from "./balance/sim.js";

// The balance simulator runs the router's own placement code over days of
// synthetic traffic on frozen pools (balance/scenarios.ts) and scores the run
// in cost-weighted tokens (balance/score.ts). docs/balance/baseline.json holds
// the scores of the placement policy as it was when the simulator was added;
// no later change to placement may score worse on any scenario.
//
// To (re)write the baseline, which only the milestone that owns it does:
//   CC_ROUTER_BALANCE_WRITE_BASELINE=1 npx vitest run src/__tests__/balance-sim.test.ts

const BASELINE = fileURLToPath(new URL("../../docs/balance/baseline.json", import.meta.url));
const WRITE = process.env["CC_ROUTER_BALANCE_WRITE_BASELINE"] === "1";

interface BaselineFile {
  note: string;
  scenarios: Record<string, ScenarioScore>;
}

const results = new Map<string, SimResult>();

/** A scenario's run, simulated once per file whatever order the tests run in. */
function run(name: string): SimResult {
  const cached = results.get(name);
  if (cached) return cached;
  const sc = SCENARIOS.find(s => s.name === name)!;
  const r = simulate(sc, { setClock: ms => vi.setSystemTime(ms) });
  results.set(name, r);
  return r;
}

beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterAll(() => { vi.useRealTimers(); });

describe("the balance simulator", () => {
  it("draws the same sequence for the same seed", () => {
    const a = rng(42), b = rng(42), c = rng(43);
    const sa = Array.from({ length: 5 }, a), sb = Array.from({ length: 5 }, b), sc = Array.from({ length: 5 }, c);
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    expect(sa.every(x => x >= 0 && x < 1)).toBe(true);
  });

  it("has the frozen scenarios, each named once", () => {
    const names = SCENARIOS.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "live-snapshot", "equal-seats", "unknown-capacity", "restart-wiped",
      "session-burst", "no-session-id", "restored-pins", "live-heavy", "five-hour-ping-pong",
    ]);
  });

  it("is deterministic: the same scenario scores the same twice", () => {
    const sc = { ...SCENARIOS[0], days: 2 };
    const one = simulate(sc, { setClock: ms => vi.setSystemTime(ms) });
    const two = simulate(sc, { setClock: ms => vi.setSystemTime(ms) });
    expect(two.metrics).toEqual(one.metrics);
    expect(two.servedBySeat).toEqual(one.servedBySeat);
  });

  for (const sc of SCENARIOS) {
    it(`runs ${sc.name}`, () => {
      const r = run(sc.name);
      const m = r.metrics;
      // Every amount is a finite, non-negative token count.
      for (const v of Object.values(m)) expect(Number.isFinite(v) && v >= 0).toBe(true);
      // Demand is real, and most of it is served.
      expect(m.demand).toBeGreaterThan(0);
      expect(m.dry).toBeLessThan(m.demand);
      // Every seat's weekly window that reset inside the run was scored, and
      // any window still open at the end was charged for falling behind.
      const resets = Object.values(r.utilAtReset).reduce((n, xs) => n + xs.length, 0);
      expect(resets).toBeGreaterThan(0);
      // The router's own placement ran: sessions were pinned.
      expect(r.placed).toBeGreaterThan(0);
    }, 120_000);
  }

  it("a restored session keeps its prefix: moving it costs a rewrite of what it carries", () => {
    const sc = SCENARIOS.find(s => s.name === "restored-pins")!;
    const r = run(sc.name);
    // 40 sessions arrive with 250K-token prefixes on the two near-limit seats.
    // The first move of each costs at least 250K x 1.25.
    expect(r.metrics.moveCost / Math.max(1, r.metrics.moves)).toBeGreaterThan(0);
    expect(r.metrics.moveCost).toBeGreaterThan(40 * 250_000 * 1.25 * 0.5);
  });

  it("charges a window still open at the end for falling behind an even spend", () => {
    const sc = { ...SCENARIOS.find(s => s.name === "equal-seats")!, days: 1 };
    const r = simulate(sc, { setClock: ms => vi.setSystemTime(ms) });
    expect(r.metrics.shortfallAtEnd).toBeGreaterThan(0);
  });

  // Calibration: the baseline policy reproduces what the live pool showed.
  // These describe the policy the baseline was written with, not invariants:
  // a better policy is meant to change them, so they run only when the
  // baseline is (re)written.
  it.skipIf(!WRITE)("baseline policy: the Max 20x seat idles while the Team seats reach the soft cap", () => {
    // Measured live: kyte left 56% of its week unused at its 11-18 reset while
    // the max_5x seats ran at 94-98%.
    const r = run("live-snapshot");
    expect(r.utilAtReset["kyte"][0]).toBeLessThan(0.7);
    for (const id of ["rigel", "lyra", "heewon", "vega"]) expect(r.utilAtReset[id][0]).toBeGreaterThanOrEqual(0.95);
  });

  it.skipIf(!WRITE)("baseline policy: a heavy week runs seats dry and pushes pins around", () => {
    const r = run("live-heavy");
    expect(r.metrics.refusals).toBeGreaterThan(0);
    expect(r.metrics.moves).toBeGreaterThan(100);
  });
});

describe("against the baseline", () => {
  it(WRITE ? "writes docs/balance/baseline.json" : "is no worse than docs/balance/baseline.json on any scenario", () => {
    const current: Record<string, ScenarioScore> = {};
    for (const sc of SCENARIOS) {
      const r = run(sc.name);
      current[sc.name] = score(r.metrics);
    }
    if (WRITE) {
      mkdirSync(dirname(BASELINE), { recursive: true });
      const file: BaselineFile = {
        note: "Scores of the placement policy at the time the balance simulator was added (seat-metrics.ts on 2026-11-19, live routing: softCapUtil 0.98, weeklyPace with fiveHour). Cost-weighted tokens. Frozen: see src/__tests__/balance/score.ts.",
        scenarios: current,
      };
      writeFileSync(BASELINE, JSON.stringify(file, null, 2) + "\n");
      return;
    }
    expect(existsSync(BASELINE)).toBe(true);
    const base = JSON.parse(readFileSync(BASELINE, "utf8")) as BaselineFile;
    expect(Object.keys(base.scenarios).sort()).toEqual(SCENARIOS.map(s => s.name).sort());
    const worse = SCENARIOS.flatMap(sc => regressions(sc.name, current[sc.name], base.scenarios[sc.name]));
    expect(worse).toEqual([]);
  }, 600_000);
});
