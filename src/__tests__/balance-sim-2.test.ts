import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./balance/scenarios.js";
import { SCENARIOS_2 } from "./balance/scenarios-2.js";
import { regressions2, score2, type RunMetrics2, type ScenarioScore2 } from "./balance/score-2.js";
import { simulate, type SimResult } from "./balance/sim.js";

// The run-2 pools (balance/scenarios-2.ts): every seat behind pace, a fresh
// reset among them, a deploy with restored pins, and kyte with an assumed
// five-hour cap; all with the live admission throttle modelled. Scored by
// score-2.ts, which adds queue wait to the run-1 metrics.
// docs/balance/baseline-2.json holds the scores of the policy as it was when
// these pools were added; no later change may score worse on any of them.
//
// To (re)write the baseline, which only the milestone that owns it does:
//   CC_ROUTER_BALANCE_WRITE_BASELINE_2=1 npx vitest run src/__tests__/balance-sim-2.test.ts

const BASELINE = fileURLToPath(new URL("../../docs/balance/baseline-2.json", import.meta.url));
const WRITE = process.env["CC_ROUTER_BALANCE_WRITE_BASELINE_2"] === "1";

interface BaselineFile { note: string; scenarios: Record<string, ScenarioScore2> }

const results = new Map<string, SimResult>();
function run(name: string): SimResult {
  const cached = results.get(name);
  if (cached) return cached;
  const sc = SCENARIOS_2.find(s => s.name === name)!;
  const r = simulate(sc, { setClock: ms => vi.setSystemTime(ms) });
  results.set(name, r);
  return r;
}
export function metrics2(r: SimResult): RunMetrics2 {
  const waits = Object.values(r.queueWaitBySeat);
  return { ...r.metrics, queueWait: waits.reduce((a, b) => a + b, 0), queueWaitMaxSeat: Math.max(0, ...waits) };
}

beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterAll(() => { vi.useRealTimers(); });

describe("the run-2 pools", () => {
  it("are the four frozen ones, named once, and distinct from the run-1 names", () => {
    const names = SCENARIOS_2.map(s => s.name);
    expect(names).toEqual(["all-ahead", "fresh-reset", "deploy-restore", "kyte-five-hour"]);
    expect(names.some(n => SCENARIOS.some(s => s.name === n))).toBe(false);
  });

  it("model the throttle: a run-1 pool, which sets none, reports no queue wait", () => {
    const sc = { ...SCENARIOS[0], days: 1 };
    const r = simulate(sc, { setClock: ms => vi.setSystemTime(ms) });
    expect(Object.values(r.queueWaitBySeat).every(w => w === 0)).toBe(true);
    expect(r.queued).toBe(0);
  });

  for (const sc of SCENARIOS_2) {
    it(`runs ${sc.name}`, () => {
      const r = run(sc.name);
      const m = metrics2(r);
      for (const v of Object.values(m)) expect(Number.isFinite(v) && v >= 0).toBe(true);
      expect(m.demand).toBeGreaterThan(0);
      expect(r.placed).toBeGreaterThan(0);
      // The throttle is live in these pools: some request waited somewhere.
      expect(r.queued).toBeGreaterThan(0);
    }, 120_000);
  }

  it.skipIf(!WRITE)("baseline policy: in the all-ahead pool one seat takes nearly every new session and holds the queue", () => {
    const r = run("all-ahead");
    const served = r.servedBySeat;
    const top = Object.entries(served).sort((a, b) => b[1] - a[1])[0]!;
    const total = Object.values(served).reduce((a, b) => a + b, 0);
    expect(top[1] / total).toBeGreaterThan(0.6);
    const waits = r.queueWaitBySeat;
    expect(waits[top[0]]).toBeGreaterThan(0.8 * Object.values(waits).reduce((a, b) => a + b, 0));
  });
});

describe("against baseline-2", () => {
  it(WRITE ? "writes docs/balance/baseline-2.json" : "is no worse than docs/balance/baseline-2.json on any run-2 pool", () => {
    const current: Record<string, ScenarioScore2> = {};
    for (const sc of SCENARIOS_2) current[sc.name] = score2(metrics2(run(sc.name)));
    if (WRITE) {
      mkdirSync(dirname(BASELINE), { recursive: true });
      const file: BaselineFile = {
        note: "Scores of the placement policy at the time the run-2 pools were added (balance rules as of PR #47, 2026-11-19). Cost-weighted tokens; queueWait in seconds. Frozen: see src/__tests__/balance/score-2.ts.",
        scenarios: current,
      };
      writeFileSync(BASELINE, JSON.stringify(file, null, 2) + "\n");
      return;
    }
    expect(existsSync(BASELINE)).toBe(true);
    const base = JSON.parse(readFileSync(BASELINE, "utf8")) as BaselineFile;
    expect(Object.keys(base.scenarios).sort()).toEqual(SCENARIOS_2.map(s => s.name).sort());
    const worse = SCENARIOS_2.flatMap(sc => regressions2(sc.name, current[sc.name], base.scenarios[sc.name]));
    expect(worse).toEqual([]);
  }, 600_000);
});
