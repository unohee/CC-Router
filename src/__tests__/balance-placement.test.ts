import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionRouter, type SessionTarget, type TargetMetrics } from "../proxy/session-router.js";
import { parseBalanceRules } from "../config/manager.js";
import { SCENARIOS } from "./balance/scenarios.js";
import { score, strictlyBetter, type ScenarioScore } from "./balance/score.js";
import { rng, simulate } from "./balance/sim.js";

// The balance rules (session-router.ts, `balance`) change how seats are judged
// once `softCapUtil` or `weeklyPace` is set. Each test here names the defect in
// the rules before them and shows it fixed, with the legacy result beside it
// where it differs; `routing.balance.legacy` keeps the old rules.

const NOW = Date.UTC(2026, 10, 19, 4, 29);
const nowSec = NOW / 1000;
const H = 3600;
const T = (accountId: string): SessionTarget => ({ provider: "anthropic", accountId });

interface Win { util: number; hoursLeft: number }
/** Production-shaped metrics (seat-metrics.ts): binding window, the 5-hour
 *  window as `pace` and `fiveHour`, the 7-day window as `weekly`. A 5-hour
 *  window with hoursLeft 0 is unopened. */
function seat(week: Win, five: Win = { util: 0, hoursLeft: 0 }): TargetMetrics {
  const w = { util: week.util, resetAtSec: nowSec + week.hoursLeft * H };
  const f = five.hoursLeft > 0 ? { util: five.util, resetAtSec: nowSec + five.hoursLeft * H } : { util: 0, resetAtSec: 0 };
  const bind = w.util > f.util ? w : f;
  return { util: bind.util, resetAtSec: bind.resetAtSec, pace: f, weekly: w, fiveHour: f };
}
const metrics = (m: Record<string, TargetMetrics>) => (t: SessionTarget) => m[t.accountId]!;
const PACE = { slack: 0.1, migrateAhead: 0.15, fiveHour: true, fiveHourSlack: 0.2 };
const LIVE = { softCapUtil: 0.98, weeklyPace: PACE };

/** The live pool on 2026-11-19 04:29Z. */
const LIVE_POOL = metrics({
  rigel: seat({ util: 0.98, hoursLeft: 17.5 }, { util: 0.01, hoursLeft: 3.6 }),
  lyra: seat({ util: 0.95, hoursLeft: 27.5 }, { util: 0.13, hoursLeft: 3.6 }),
  heewon: seat({ util: 0.65, hoursLeft: 86.5 }, { util: 0.03, hoursLeft: 4.1 }),
  vega: seat({ util: 0.53, hoursLeft: 99.5 }, { util: 0.16, hoursLeft: 3.6 }),
  kyte: seat({ util: 0.19, hoursLeft: 147.5 }),
});
const LIVE_SEATS = ["rigel", "lyra", "heewon", "vega", "kyte"].map(T);

function place(opts: ConstructorParameters<typeof SessionRouter>[0], pool: SessionTarget[], utilOf: (t: SessionTarget) => TargetMetrics, id = "new"): string {
  const r = new SessionRouter({ now: () => NOW, ...opts });
  return r.resolve(id, pool, () => true, utilOf)!.accountId;
}

describe("the balance rules", () => {
  it("apply the soft cap before pace: pace can no longer narrow the choice to a seat over the cap", () => {
    // `over` is on pace only because its reset is close; `room` is ahead of
    // its weekly line but has a third of its week left.
    const pool = [T("over"), T("room")];
    const m = metrics({
      over: seat({ util: 0.985, hoursLeft: 10 }),
      room: seat({ util: 0.65, hoursLeft: 86 }),
    });
    expect(place({ ...LIVE, balance: false }, pool, m)).toBe("over");
    expect(place(LIVE, pool, m)).toBe("room");
  });

  it("score on the window the cap reads: an idle five-hour window no longer hides a nearly spent week", () => {
    const pool = [T("spent"), T("fresh")];
    const m = metrics({
      spent: seat({ util: 0.97, hoursLeft: 40 }, { util: 0, hoursLeft: 0.5 }),
      fresh: seat({ util: 0.3, hoursLeft: 100 }, { util: 0.4, hoursLeft: 3 }),
    });
    expect(place({ softCapUtil: 0.98, balance: false }, pool, m)).toBe("spent");
    expect(place({ softCapUtil: 0.98 }, pool, m)).toBe("fresh");
  });

  it("keep pace alive up to the reset: 98% used with a tenth of the week left is ahead, not on pace", () => {
    // The old line clamps its target at 1 in the last `slack` of the week, so
    // `late` read as on pace and, holding fewer sessions, took the next one.
    const pool = [T("late"), T("even")];
    const m = metrics({
      late: seat({ util: 0.98, hoursLeft: 17 }),
      even: seat({ util: 0.5, hoursLeft: 84 }),
    });
    const weeklyOnly = { weeklyPace: { ...PACE, fiveHour: false } };
    const pick = (balance: boolean) => {
      const r = new SessionRouter({ now: () => NOW, ...weeklyOnly, balance });
      r.resolve("held", pool, t => t.accountId === "even", m);
      return r.resolve("new", pool, () => true, m)!.accountId;
    };
    expect(pick(false)).toBe("late");
    expect(pick(true)).toBe("even");
  });

  it("pace the two windows separately: a seat ahead only on its five hours ranks before one ahead on its week", () => {
    // The old rules took the larger of the two `ahead` figures, a share of a
    // five-hour quota against a share of a weekly one, and chose by it.
    const pool = [T("burst"), T("weekAhead")];
    const m = metrics({
      // Five-hour window 30 minutes old and 90% spent: far ahead on five hours, which refill soon.
      burst: seat({ util: 0.4, hoursLeft: 120 }, { util: 0.9, hoursLeft: 4.5 }),
      // Week ahead: 70% spent with 60% of it left.
      weekAhead: seat({ util: 0.7, hoursLeft: 100 }, { util: 0.05, hoursLeft: 4.9 }),
    });
    expect(place({ weeklyPace: PACE, balance: false }, pool, m)).toBe("weekAhead");
    expect(place({ weeklyPace: PACE }, pool, m)).toBe("burst");
  });

  it("do not move a pin for a five-hour burst; a weekly overspend still moves it", () => {
    const moves: string[] = [];
    const r = new SessionRouter({ now: () => NOW, ...LIVE, onReassign: ({ to, reason }) => moves.push(`${to.accountId}:${reason}`) });
    const pool = [T("a"), T("b")];
    r.resolve("s", pool, t => t.accountId === "a", metrics({ a: seat({ util: 0.3, hoursLeft: 100 }), b: seat({ util: 0.3, hoursLeft: 100 }) }));
    // a: five-hour 90% spent half an hour into its window. Stays.
    const burst = metrics({ a: seat({ util: 0.35, hoursLeft: 100 }, { util: 0.9, hoursLeft: 4.5 }), b: seat({ util: 0.3, hoursLeft: 100 }) });
    expect(r.resolve("s", pool, () => true, burst)!.accountId).toBe("a");
    expect(moves).toEqual([]);
    // a: week far ahead (85% spent with 60% of it left). Moves.
    const week = metrics({ a: seat({ util: 0.85, hoursLeft: 100 }), b: seat({ util: 0.3, hoursLeft: 100 }) });
    expect(r.resolve("s", pool, () => true, week)!.accountId).toBe("b");
    expect(moves).toEqual(["b:weekly-pace"]);
  });

  it("bound the near-reset spike: a five-hour window minutes from rolling over no longer takes every new session", () => {
    const pool = [T("rolling"), T("roomy")];
    const m = metrics({
      rolling: seat({ util: 0.4, hoursLeft: 100 }, { util: 0.85, hoursLeft: 4 / 60 }),
      roomy: seat({ util: 0.4, hoursLeft: 100 }, { util: 0.2, hoursLeft: 3 }),
    });
    expect(place({ softCapUtil: 0.98, balance: false }, pool, m)).toBe("rolling");
    expect(place({ softCapUtil: 0.98 }, pool, m)).toBe("roomy");
    // A weekly window minutes from its reset ranks high (its quota is about to
    // be lost), but scores as if an hour were left, not a few minutes.
    const near = metrics({ rolling: seat({ util: 0.5, hoursLeft: 2 / 60 }), roomy: seat({ util: 0.5, hoursLeft: 1 }) });
    const r = new SessionRouter({ now: () => NOW, softCapUtil: 0.98 });
    const picks = ["a", "b", "c", "d"].map(id => r.resolve(id, pool, () => true, near)!.accountId);
    expect(new Set(picks)).toEqual(new Set(["rolling", "roomy"]));
  });

  it("rank the live pool by the week each seat has left, not by its five-hour window", () => {
    // Soft cap alone (no pacing), so the score decides. The old score ranked
    // on five-hour windows and put lyra (95% of its week used) first; the new
    // one puts kyte, vega and heewon ahead of lyra and never picks rigel.
    const cap = { softCapUtil: 0.98 };
    const r = new SessionRouter({ now: () => NOW, ...cap });
    const picks = Array.from({ length: 3 }, (_, i) => r.resolve(`s${i}`, LIVE_SEATS, () => true, LIVE_POOL)!.accountId);
    expect(picks).toEqual(["kyte", "vega", "heewon"]);
    expect(place({ ...cap, balance: false }, LIVE_SEATS, LIVE_POOL)).not.toBe("kyte");
    // With the live pacing too, only kyte is on pace on both windows.
    expect(place(LIVE, LIVE_SEATS, LIVE_POOL)).toBe("kyte");
  });
});

describe("routing.balance.legacy", () => {
  it("is read from the routing block: the balance rules are on unless legacy is true", () => {
    expect(parseBalanceRules(undefined)).toBe(true);
    expect(parseBalanceRules({})).toBe(true);
    expect(parseBalanceRules({ balance: {} })).toBe(true);
    expect(parseBalanceRules({ balance: { legacy: false } })).toBe(true);
    expect(parseBalanceRules({ balance: { legacy: true } })).toBe(false);
  });

  it("restores the placement from before the balance rules", () => {
    const pool = [T("over"), T("room")];
    const m = metrics({ over: seat({ util: 0.985, hoursLeft: 10 }), room: seat({ util: 0.65, hoursLeft: 86 }) });
    expect(place({ ...LIVE, balance: false }, pool, m)).toBe("over");
  });

  it("is passed to the router by the server", () => {
    const src = readFileSync(fileURLToPath(new URL("../proxy/server.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/new SessionRouter\(\{[\s\S]{0,200}balance: getBalanceRules\(\)/);
  });
});

describe("a router with neither softCapUtil nor weeklyPace", () => {
  it("places exactly as before, whatever the readings", () => {
    const rand = rng(77);
    const ids = ["a", "b", "c", "d"];
    const pool = ids.map(T);
    const fresh = new SessionRouter({ now: () => NOW });
    const legacy = new SessionRouter({ now: () => NOW, balance: false });
    for (let i = 0; i < 400; i++) {
      const m: Record<string, TargetMetrics> = {};
      for (const id of ids) {
        m[id] = seat({ util: Math.round(rand() * 100) / 100, hoursLeft: 1 + rand() * 160 },
          rand() < 0.3 ? { util: 0, hoursLeft: 0 } : { util: Math.round(rand() * 100) / 100, hoursLeft: rand() * 5 });
      }
      const usable = (t: SessionTarget) => (i + t.accountId.charCodeAt(0)) % 7 !== 0;
      const session = `s${Math.floor(rand() * 40)}`;
      const a = fresh.resolve(session, pool, usable, metrics(m));
      const b = legacy.resolve(session, pool, usable, metrics(m));
      expect(a, `step ${i}`).toEqual(b);
    }
  });
});

describe("in the balance simulator", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterAll(() => { vi.useRealTimers(); });

  it("is strictly better than the baseline on the live snapshot", () => {
    const base = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/balance/baseline.json", import.meta.url)), "utf8")) as
      { scenarios: Record<string, ScenarioScore> };
    const sc = SCENARIOS.find(s => s.name === "live-snapshot")!;
    const current = score(simulate(sc, { setClock: ms => vi.setSystemTime(ms) }).metrics);
    expect(strictlyBetter(current, base.scenarios["live-snapshot"]), `${current.total} vs ${base.scenarios["live-snapshot"].total}`).toBe(true);
  }, 120_000);
});
