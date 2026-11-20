import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./balance/scenarios.js";
import { SCENARIOS_2, type Scenario2 } from "./balance/scenarios-2.js";
import type { RunMetrics2 } from "./balance/score-2.js";
import { SCENARIOS_3 } from "./balance/scenarios-3.js";
import { SCENARIOS_4 } from "./balance/scenarios-4.js";
import { poolOutcomes, regressions3, score3, type RunMetrics3, type ScenarioScore3 } from "./balance/score-3.js";
import { simulate, type SimResult } from "./balance/sim.js";

// Run 4 adds live-week-2 (balance/scenarios-4.ts): the live pool captured with
// each seat started from health's live rate limits, over a full week. It is
// graded by score-3 like the run-3 pools. docs/balance/baseline-4.json holds
// the current policy's scores on every run-2, run-3 and run-4 pool; no later
// change may score worse on any of them.
//
// To (re)write the baseline, which only the milestone that owns it does:
//   CC_ROUTER_BALANCE_WRITE_BASELINE_4=1 npx vitest run src/__tests__/balance-sim-4.test.ts

const BASELINE = fileURLToPath(new URL("../../docs/balance/baseline-4.json", import.meta.url));
const CAPTURE = fileURLToPath(new URL("../../docs/balance/capture-2026-11-20-week/", import.meta.url));
const WRITE = process.env["CC_ROUTER_BALANCE_WRITE_BASELINE_4"] === "1";

interface BaselineFile { note: string; scenarios: Record<string, ScenarioScore3> }

const POOLS_4: Scenario2[] = [...SCENARIOS_2, ...SCENARIOS_3, ...SCENARIOS_4];

const results = new Map<string, SimResult>();
function run4(name: string): SimResult {
  const cached = results.get(name);
  if (cached) return cached;
  const sc = POOLS_4.find(s => s.name === name)!;
  const r = simulate(sc, { setClock: ms => vi.setSystemTime(ms) });
  results.set(name, r);
  return r;
}
/** score-3's metrics of a result (as balance-sim-3.test.ts builds them; not imported, or its tests would run here too). */
function metrics3(r: SimResult): RunMetrics3 {
  const waits = Object.values(r.queueWaitBySeat);
  const m2: RunMetrics2 = { ...r.metrics, overspendAtEnd: r.overspendAtEnd, queueWait: waits.reduce((a, b) => a + b, 0), queueWaitMaxSeat: Math.max(0, ...waits) };
  const pool = poolOutcomes(r.outcomesBySeat);
  return { ...m2, resets: pool.resets, unusedShareAtReset: pool.unusedShareAtReset, strandedSeatMinutes: r.strandedSeatMinutes, outcomesBySeat: r.outcomesBySeat };
}

beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterAll(() => { vi.useRealTimers(); });

describe("the run-4 pools", () => {
  it("are the run-2 and run-3 pools and live-week-2, named once", () => {
    const names = POOLS_4.map(s => s.name);
    expect(SCENARIOS_4.map(s => s.name)).toEqual(["live-week-2"]);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some(n => SCENARIOS.some(s => s.name === n))).toBe(false);
  });

  it("live-week-2 is the capture script's output for docs/balance/capture-2026-11-20-week, typed", () => {
    const live = SCENARIOS_4[0]!;
    const json = JSON.parse(readFileSync(`${CAPTURE}live-week-2.scenario.json`, "utf8")) as Scenario2 & { notes: string[]; capturedAt: string };
    const { notes, capturedAt, source: _s, ...fitted } = json as Scenario2 & { notes: string[]; capturedAt: string; source: unknown };
    void _s;
    expect({ ...fitted, description: live.description }).toEqual(live);
    expect(capturedAt).toBe("2026-11-20T10:00:00.000Z");
    expect(live.days).toBe(7);
    // Every seat started from health's live value, and its weekly reset falls inside the week.
    for (const s of live.seats) {
      expect(notes.some(n => n.startsWith(`${s.id}: start state from health`)), s.id).toBe(true);
      expect(s.weeklyResetH, s.id).toBeLessThan(live.days * 24);
    }
  });

  it("re-running the capture on the saved inputs gives the saved scenario", async () => {
    const url: string = new URL("../../scripts/balance-capture.mjs", import.meta.url).href;
    const cap = (await import(url)) as { buildScenario(input: Record<string, unknown>): { scenario: Record<string, unknown> } };
    const read = (f: string): unknown => JSON.parse(readFileSync(`${CAPTURE}${f}`, "utf8"));
    const { scenario } = cap.buildScenario({
      quota: read("quota-history.json"), series: read("usage-series-7d.json"), usage: read("usage-history.json"),
      config: read("config.json"), health: read("health.json"),
      startMs: Date.parse("2026-11-20T10:00:00Z"), days: 7, seed: 4101, name: "live-week-2",
    });
    expect(scenario).toEqual(read("live-week-2.scenario.json"));
  });

  it("the saved health is cut to what the capture reads", () => {
    const health = JSON.parse(readFileSync(`${CAPTURE}health.json`, "utf8")) as Record<string, unknown>;
    expect(Object.keys(health).sort()).toEqual(["accounts", "balance", "build", "note", "performance", "placements", "recentLogs"]);
    for (const a of health["accounts"] as Array<Record<string, unknown>>) expect(Object.keys(a).sort()).toEqual(["id", "rateLimits"]);
    for (const e of health["recentLogs"] as Array<Record<string, unknown>>) expect(Object.keys(e).sort()).toEqual(["sessionId", "statusCode"]);
  });

  it("runs live-week-2 and reports a reset for every seat", () => {
    const r = run4("live-week-2");
    const m = metrics3(r);
    for (const s of SCENARIOS_4[0]!.seats) expect(r.outcomesBySeat[s.id]!.resets, s.id).toBe(1);
    expect(m.resets).toBe(5);
    expect(m.unusedShareAtReset).toBeGreaterThanOrEqual(0);
    expect(m.unusedShareAtReset).toBeLessThanOrEqual(1);
  }, 180_000);
});

describe("against baseline-4", () => {
  it(WRITE ? "writes docs/balance/baseline-4.json" : "is no worse than docs/balance/baseline-4.json on any run-4 pool", () => {
    const current: Record<string, ScenarioScore3> = {};
    for (const sc of POOLS_4) current[sc.name] = score3(metrics3(run4(sc.name)));
    if (WRITE) {
      mkdirSync(dirname(BASELINE), { recursive: true });
      const file: BaselineFile = {
        note: "Scores of the placement policy at the time live-week-2 was added (balance rules as of run 4's unmeasured-seat change, goal/30, 2026-11-20), under score-3, on every run-2, run-3 and run-4 pool. Cost-weighted tokens; queueWait in seconds; strandedSeatMinutes in seat-minutes; unusedShareAtReset 0..1. Frozen with src/__tests__/balance/scenarios-4.ts.",
        scenarios: current,
      };
      writeFileSync(BASELINE, JSON.stringify(file, null, 2) + "\n");
      return;
    }
    expect(existsSync(BASELINE)).toBe(true);
    const base = JSON.parse(readFileSync(BASELINE, "utf8")) as BaselineFile;
    expect(Object.keys(base.scenarios).sort()).toEqual(POOLS_4.map(s => s.name).sort());
    const worse = POOLS_4.flatMap(sc => regressions3(sc.name, current[sc.name]!, base.scenarios[sc.name]!));
    expect(worse).toEqual([]);
  }, 900_000);
});
