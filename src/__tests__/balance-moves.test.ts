import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionRouter, type SessionTarget, type TargetMetrics } from "../proxy/session-router.js";
import { SCENARIOS } from "./balance/scenarios.js";
import { regressions, score, type ScenarioScore } from "./balance/score.js";
import { simulate } from "./balance/sim.js";

// When a pinned session moves under the balance rules. Every move is a cache
// rewrite of the whole conversation, so a pin leaves its seat only when that
// seat is projected to run dry before its weekly reset and another seat has a
// clear surplus, after a minimum dwell; a seat shed over the soft cap goes
// only to a seat with real room under it. Nothing is reset by hand: the pace
// ratio rises as the week elapses, so a seat that stops spending is on pace
// again by itself.

const T0 = Date.UTC(2026, 10, 19, 4, 29);
const H = 3600;
const MIN = 60_000;
const T = (accountId: string): SessionTarget => ({ provider: "anthropic", accountId });

interface Win { util: number; hoursLeft: number }
function seat(now: number, week: Win, five: Win = { util: 0, hoursLeft: 0 }): TargetMetrics {
  const nowSec = now / 1000;
  const w = { util: week.util, resetAtSec: nowSec + week.hoursLeft * H };
  const f = five.hoursLeft > 0 ? { util: five.util, resetAtSec: nowSec + five.hoursLeft * H } : { util: 0, resetAtSec: 0 };
  const bind = w.util > f.util ? w : f;
  return { util: bind.util, resetAtSec: bind.resetAtSec, pace: f, weekly: w, fiveHour: f };
}
const PACE = { slack: 0.1, migrateAhead: 0.15, fiveHour: true, fiveHourSlack: 0.2 };
const LIVE = { softCapUtil: 0.98, weeklyPace: PACE };

/** A router with a controllable clock and a log of moves. */
function router(opts: Record<string, unknown> = LIVE) {
  const clock = { now: T0 };
  const moves: string[] = [];
  const r = new SessionRouter({ now: () => clock.now, ...opts, onReassign: ({ from, to, reason }) => moves.push(`${from.accountId}>${to.accountId}:${reason}`) });
  return { r, clock, moves };
}

describe("a pin moves for weekly pace only when", () => {
  const pool = [T("a"), T("b")];
  // a: 85% of its week spent with 60% of it left (ratio 0.375: dry well before reset).
  // b: 30% spent with 60% left (ratio 1.75: surplus).
  const dryVsSurplus = (now: number) => (t: SessionTarget) =>
    t.accountId === "a" ? seat(now, { util: 0.85, hoursLeft: 100 }) : seat(now, { util: 0.3, hoursLeft: 100 });

  it("its seat is projected dry before the reset, another seat has a surplus, and it has dwelt a while", () => {
    const { r, clock, moves } = router();
    r.resolve("s", pool, t => t.accountId === "a", dryVsSurplus(clock.now));
    // Just placed: no move yet, whatever the numbers say.
    expect(r.resolve("s", pool, () => true, dryVsSurplus(clock.now))!.accountId).toBe("a");
    expect(moves).toEqual([]);
    clock.now += 31 * MIN;
    expect(r.resolve("s", pool, () => true, dryVsSurplus(clock.now))!.accountId).toBe("b");
    expect(moves).toEqual(["a>b:weekly-pace"]);
    // Moved: dwell starts again, so it does not bounce straight back.
    const reversed = (t: SessionTarget) => dryVsSurplus(clock.now)(t.accountId === "a" ? T("b") : T("a"));
    expect(r.resolve("s", pool, () => true, reversed)!.accountId).toBe("b");
    expect(moves).toHaveLength(1);
  });

  it("not when its seat is merely ahead of its line but still on course to last", () => {
    const { r, clock, moves } = router();
    // a: 52% spent with 60% of the week left (ratio 0.81: ahead of its line,
    // but not dry by the margin).
    const ahead = (t: SessionTarget) => t.accountId === "a" ? seat(clock.now, { util: 0.52, hoursLeft: 100 }) : seat(clock.now, { util: 0.3, hoursLeft: 100 });
    r.resolve("s", pool, t => t.accountId === "a", ahead);
    clock.now += 45 * MIN;
    expect(r.resolve("s", pool, () => true, ahead)!.accountId).toBe("a");
    expect(moves).toEqual([]);
  });

  it("not when the other seat has no clear surplus over it", () => {
    const { r, clock, moves } = router();
    // Both dry-ish: a at ratio 0.375, b at 0.5. b is better but not by the margin.
    const both = (t: SessionTarget) => t.accountId === "a" ? seat(clock.now, { util: 0.85, hoursLeft: 100 }) : seat(clock.now, { util: 0.8, hoursLeft: 100 });
    r.resolve("s", pool, t => t.accountId === "a", both);
    clock.now += 45 * MIN;
    expect(r.resolve("s", pool, () => true, both)!.accountId).toBe("a");
    expect(moves).toEqual([]);
  });

  it("not for a five-hour burst, however far ahead", () => {
    const { r, clock, moves } = router();
    const burst = (t: SessionTarget) => t.accountId === "a"
      ? seat(clock.now, { util: 0.3, hoursLeft: 100 }, { util: 0.95, hoursLeft: 4.5 })
      : seat(clock.now, { util: 0.3, hoursLeft: 100 });
    r.resolve("s", pool, t => t.accountId === "a", burst);
    clock.now += 45 * MIN;
    expect(r.resolve("s", pool, () => true, burst)!.accountId).toBe("a");
    expect(moves).toEqual([]);
  });

  it("is released by time: a seat that stops spending is on pace again as its week elapses", () => {
    const { r, clock, moves } = router();
    // a: 60% spent with 60% of the week (100 h) left: ratio 0.67, dry by the
    // margin, but the other seat has no surplus yet either (0.4 at 50% spent).
    // As the week elapses with nothing spent, a's ratio climbs past the line.
    const util = 0.6;
    const at = (hoursLeft: number) => (t: SessionTarget) =>
      t.accountId === "a" ? seat(clock.now, { util, hoursLeft }) : seat(clock.now, { util: 0.1, hoursLeft });
    r.resolve("s", pool, t => t.accountId === "a", at(100));
    clock.now += 31 * MIN;
    // Dry and b has a surplus: it would move now.
    expect(r.resolve("probe", pool, () => true, at(99.5))!.accountId).toBe("b");
    // But say the seat spent nothing for 40 hours (a's ratio then reads
    // 0.4 / (60/168) = 1.12, on pace): the same pin, kept alive by a request
    // every 45 minutes once it is on pace again, stays.
    const quiet = new SessionRouter({ now: () => clock.now, ...LIVE, onReassign: () => moves.push("moved") });
    clock.now += 40 * H * 1000;
    quiet.restore([{ sessionId: "s2", provider: "anthropic", accountId: "a", lastSeen: clock.now }]);
    for (let left = 60; left >= 30; left -= 0.75) {
      clock.now += 45 * MIN;
      expect(quiet.resolve("s2", pool, () => true, at(left))!.accountId).toBe("a");
    }
    expect(moves).toEqual([]);
  });
});

describe("load", () => {
  it("is the requests a seat was given lately: an idle pin counts for nothing, a request with no session counts like a pinned one", () => {
    const { r, clock } = router({ softCapUtil: 0.98 });
    const pool = [T("a"), T("b")];
    const same = (t: SessionTarget) => seat(clock.now, { util: 0.5, hoursLeft: 80 });
    // Ten sessions on a, each sent one request; b is empty. New sessions go to b.
    for (let i = 0; i < 10; i++) r.resolve(`on-a-${i}`, pool, t => t.accountId === "a", same);
    expect(r.resolve("new", pool, () => true, same)!.accountId).toBe("b");
    // Eleven minutes later those pins are idle: a and b tie, and the next two rotate.
    clock.now += 11 * MIN;
    const picks = ["p", "q"].map(id => r.resolve(id, pool, () => true, same)!.accountId).sort();
    expect(picks).toEqual(["a", "b"]);
    // Requests with no session land as load too: send twelve to a, and a new session goes to b.
    for (let i = 0; i < 12; i++) r.rank([T("a")], () => true, same, "rotate");
    expect(r.resolve("after", pool, () => true, same)!.accountId).toBe("b");
    // Under the legacy rules pins are load for as long as they live.
    const legacy = router({ softCapUtil: 0.98, balance: false });
    for (let i = 0; i < 10; i++) legacy.r.resolve(`on-a-${i}`, pool, t => t.accountId === "a", same);
    legacy.clock.now += 11 * MIN;
    expect(legacy.r.resolve("new", pool, () => true, same)!.accountId).toBe("b");
  });
});

describe("a pin shed over the soft cap", () => {
  it("goes only to a seat with real room under the cap", () => {
    const { r, clock, moves } = router({ softCapUtil: 0.98 });
    const pool = [T("hot"), T("edge"), T("room")];
    const m = (t: SessionTarget) => ({
      hot: seat(clock.now, { util: 0.99, hoursLeft: 50 }),
      edge: seat(clock.now, { util: 0.92, hoursLeft: 50 }),   // under the cap by 6%: not relief
      room: seat(clock.now, { util: 0.5, hoursLeft: 50 }),
    })[t.accountId]!;
    r.resolve("s", pool, t => t.accountId === "hot", m);
    expect(r.resolve("s", pool, () => true, m)!.accountId).toBe("room");
    expect(moves).toEqual(["hot>room:soft-cap"]);
  });

  it("stays when the only seat under the cap is about to be over it too", () => {
    const { r, clock, moves } = router({ softCapUtil: 0.98 });
    const pool = [T("hot"), T("edge")];
    const m = (t: SessionTarget) => t.accountId === "hot" ? seat(clock.now, { util: 0.99, hoursLeft: 50 }) : seat(clock.now, { util: 0.92, hoursLeft: 50 });
    r.resolve("s", pool, t => t.accountId === "hot", m);
    expect(r.resolve("s", pool, () => true, m)!.accountId).toBe("hot");
    expect(moves).toEqual([]);
    // The legacy rules moved it.
    const legacy = router({ softCapUtil: 0.98, balance: false });
    legacy.r.resolve("s", pool, t => t.accountId === "hot", m);
    expect(legacy.r.resolve("s", pool, () => true, m)!.accountId).toBe("edge");
  });
});

describe("in the balance simulator", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterAll(() => { vi.useRealTimers(); });

  const base = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/balance/baseline.json", import.meta.url)), "utf8")) as
    { scenarios: Record<string, ScenarioScore> };

  it("is no worse than the baseline on any scenario, and better on the ping-pong pool", () => {
    const worse: string[] = [];
    let pingPong: ScenarioScore | null = null;
    for (const sc of SCENARIOS) {
      const current = score(simulate(sc, { setClock: ms => vi.setSystemTime(ms) }).metrics);
      worse.push(...regressions(sc.name, current, base.scenarios[sc.name]));
      if (sc.name === "five-hour-ping-pong") pingPong = current;
    }
    expect(worse).toEqual([]);
    const b = base.scenarios["five-hour-ping-pong"];
    expect(pingPong!.total).toBeLessThan(b.total);
    expect(pingPong!.dry).toBeLessThan(b.dry);
    expect(pingPong!.unusedAtReset).toBeLessThan(b.unusedAtReset);
  }, 300_000);
});
