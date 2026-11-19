import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionRouter, type SessionTarget, type TargetMetrics } from "../proxy/session-router.js";
import { SCENARIOS } from "./balance/scenarios.js";
import { SCENARIOS_2 } from "./balance/scenarios-2.js";
import { regressions, score, type ScenarioScore } from "./balance/score.js";
import { regressions2, score2, strictlyBetter2, type ScenarioScore2 } from "./balance/score-2.js";
import { simulate } from "./balance/sim.js";

// The state the live pool is in most of the time: every seat under the soft
// cap is behind its weekly pace (demand runs at ~80% of a week's capacity, so
// ratios sit under 1 - slack). The first live hour of the balance rules
// (2026-11-19 05:45-06:45Z) put every new session on one seat there: a 0.05
// tie band on the best pace ratio left one candidate while the size-and-load
// score rated another seat 8x higher, and that seat's admission queue ran at
// 4/4 (501 waits, 4,929 s) while two seats had 8 free slots.
//
// Now: with no seat on pace every seat under the cap competes on the score,
// with the pace ratio as a factor; a seat with no weekly reading is not the
// sole candidate while measured seats under the cap exist (since run 3 it
// competes among them: balance-explore.test.ts); and a seat whose admission
// gate is full scores down by (1 + saturation)^4.

const NOW = Date.UTC(2026, 10, 19, 7, 0);
const nowSec = NOW / 1000;
const H = 3600;
const T = (accountId: string): SessionTarget => ({ provider: "anthropic", accountId });

interface Win { util: number; hoursLeft: number }
function seat(week: Win, five: Win = { util: 0, hoursLeft: 0 }, extra: Partial<TargetMetrics> = {}): TargetMetrics {
  const w = { util: week.util, resetAtSec: nowSec + week.hoursLeft * H };
  const f = five.hoursLeft > 0 ? { util: five.util, resetAtSec: nowSec + five.hoursLeft * H } : { util: 0, resetAtSec: 0 };
  const bind = w.util > f.util ? w : f;
  return { util: bind.util, resetAtSec: bind.resetAtSec, pace: f, weekly: w, fiveHour: f, ...extra };
}
const PACE = { slack: 0.1, migrateAhead: 0.15, fiveHour: true, fiveHourSlack: 0.2 };
const LIVE = { softCapUtil: 0.98, weeklyPace: PACE };

/** The live pool at 07:00Z: weekly ratios heewon 0.68, vega 0.81, kyte 0.87; lyra and rigel over the cap. */
const BEHIND: Record<string, TargetMetrics> = {
  rigel: seat({ util: 0.98, hoursLeft: 15 }, { util: 0.01, hoursLeft: 3.3 }),
  lyra: seat({ util: 0.98, hoursLeft: 25 }, { util: 0.31, hoursLeft: 3.3 }),
  heewon: seat({ util: 0.66, hoursLeft: 84 }, { util: 0.11, hoursLeft: 4 }),
  vega: seat({ util: 0.53, hoursLeft: 97 }, { util: 0.16, hoursLeft: 3.3 }),
  kyte: seat({ util: 0.25, hoursLeft: 145 }, undefined, { size: 1.63 }),
};
const IDS = Object.keys(BEHIND);
const withSat = (sat: Record<string, number>) => (t: SessionTarget): TargetMetrics =>
  ({ ...BEHIND[t.accountId]!, saturation: sat[t.accountId] ?? 0 });

function placements(r: SessionRouter, utilOf: (t: SessionTarget) => TargetMetrics, n: number): string[] {
  return Array.from({ length: n }, (_, i) => r.resolve(`s${i}`, IDS.map(T), () => true, utilOf)!.accountId);
}

describe("when every seat under the cap is behind its weekly pace", () => {
  it("every one of them is placeable, ranked by the score with pace as a factor; none is shut out by a tie band", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const x = r.explain(IDS.map(T), () => true, t => BEHIND[t.accountId]!)!;
    for (const id of ["heewon", "vega", "kyte"]) expect(x.get(`anthropic:${id}`)!.placeable, id).toBe(true);
    for (const id of ["rigel", "lyra"]) expect(x.get(`anthropic:${id}`)!.placeable, id).toBe(false);
    // Every placeable seat has a score; the top one is where resolve goes.
    const top = [...x.entries()].filter(([, v]) => v.placeable).sort((a, b) => a[1].rank - b[1].rank)[0]![0].replace("anthropic:", "");
    expect(r.resolve("new", IDS.map(T), () => true, t => BEHIND[t.accountId]!)!.accountId).toBe(top);
  });

  it("spreads a run of new sessions across the seats with room instead of stacking one", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const picks = placements(r, t => BEHIND[t.accountId]!, 12);
    const counts = picks.reduce((m, id) => m.set(id, (m.get(id) ?? 0) + 1), new Map<string, number>());
    expect(counts.get("rigel") ?? 0).toBe(0);
    expect(counts.get("lyra") ?? 0).toBe(0);
    // At least two of the three seats with room took sessions, and no seat took them all.
    expect([...counts.keys()].length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...counts.values())).toBeLessThan(12);
  });

  it("a seat whose admission gate is full scores far below one with free slots, whatever its week holds", () => {
    // kyte at 4/4 in flight (saturation 1) against vega idle: vega goes first.
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    expect(r.resolve("a", IDS.map(T), () => true, withSat({ kyte: 1 }))!.accountId).not.toBe("kyte");
    // kyte queueing (saturation 2): still not kyte.
    expect(r.resolve("b", IDS.map(T), () => true, withSat({ kyte: 2 }))!.accountId).not.toBe("kyte");
    // Everyone equally saturated: back to the plain score.
    const even = new SessionRouter({ now: () => NOW, ...LIVE });
    const plain = new SessionRouter({ now: () => NOW, ...LIVE });
    expect(even.resolve("c", IDS.map(T), () => true, withSat({ heewon: 1, vega: 1, kyte: 1 }))!.accountId)
      .toBe(plain.resolve("c", IDS.map(T), () => true, t => BEHIND[t.accountId]!)!.accountId);
  });

  it("the pace ratio still counts: of two seats alike, the one further behind its week ranks lower", () => {
    const pool = [T("a"), T("b")];
    const m = (t: SessionTarget) => t.accountId === "a"
      ? seat({ util: 0.7, hoursLeft: 100 })   // ratio 0.50
      : seat({ util: 0.55, hoursLeft: 100 }); // ratio 0.76
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    expect(r.resolve("s", pool, () => true, m)!.accountId).toBe("b");
  });
});

describe("a seat with no weekly reading", () => {
  const measured = (t: SessionTarget) => t.accountId === "fresh"
    ? seat({ util: 0, hoursLeft: 0 }, { util: 0, hoursLeft: 0 })   // no weekly window known
    : BEHIND[t.accountId]!;
  const pool = [...IDS, "fresh"].map(T);

  it("is not the sole candidate while measured seats under the cap exist", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const x = r.explain(pool, () => true, measured)!;
    expect(IDS.filter(id => x.get(`anthropic:${id}`)!.placeable).length).toBeGreaterThan(0);
    const picks = Array.from({ length: 10 }, (_, i) => r.resolve(`s${i}`, pool, () => true, measured)!.accountId);
    expect(picks.filter(p => p === "fresh").length).toBeLessThan(10);
  });

  it("still takes work when it is the only seat under the cap, so that it produces a reading", () => {
    const over = (t: SessionTarget) => t.accountId === "fresh"
      ? seat({ util: 0, hoursLeft: 0 }, { util: 0, hoursLeft: 0 })
      : seat({ util: 0.99, hoursLeft: 50 });
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    expect(r.resolve("s", pool, () => true, over)!.accountId).toBe("fresh");
  });
});

describe("in the balance simulator", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterAll(() => { vi.useRealTimers(); });

  const base1 = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/balance/baseline.json", import.meta.url)), "utf8")) as { scenarios: Record<string, ScenarioScore> };
  const base2 = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/balance/baseline-2.json", import.meta.url)), "utf8")) as { scenarios: Record<string, ScenarioScore2> };

  it("is strictly better than baseline-2 on all-ahead and fresh-reset, and no worse on every pool in both baselines", () => {
    const worse: string[] = [];
    const current2: Record<string, ScenarioScore2> = {};
    for (const sc of SCENARIOS_2) {
      const r = simulate(sc, { setClock: ms => vi.setSystemTime(ms) });
      const waits = Object.values(r.queueWaitBySeat);
      current2[sc.name] = score2({ ...r.metrics, overspendAtEnd: r.overspendAtEnd, queueWait: waits.reduce((a, b) => a + b, 0), queueWaitMaxSeat: Math.max(0, ...waits) });
      worse.push(...regressions2(sc.name, current2[sc.name], base2.scenarios[sc.name]));
    }
    for (const sc of SCENARIOS) {
      const r = simulate(sc, { setClock: ms => vi.setSystemTime(ms) });
      worse.push(...regressions(sc.name, score(r.metrics), base1.scenarios[sc.name]));
    }
    expect(worse).toEqual([]);
    for (const name of ["all-ahead", "fresh-reset"]) {
      const c = current2[name], b = base2.scenarios[name];
      expect(strictlyBetter2(c, b), `${name}: ${c.total} vs ${b.total}, queue ${c.queueWait} vs ${b.queueWait}`).toBe(true);
      expect(c.queueWait).toBeLessThan(b.queueWait);
    }
  }, 600_000);
});
