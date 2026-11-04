import { describe, expect, it } from "vitest";
import { NO_PACE, WEEK_SEC, weeklyPace } from "../proxy/weekly-pace.js";
import { SessionRouter, type SessionTarget, type TargetMetrics } from "../proxy/session-router.js";

const NOW = Date.UTC(2026, 10, 4, 0, 0, 0);
const nowSec = NOW / 1000;
const DAY = 24 * 60 * 60;
/** Reset time for a window `daysLeft` days from closing. */
const resetIn = (daysLeft: number) => nowSec + daysLeft * DAY;

describe("weeklyPace", () => {
  it("allows the elapsed share plus slack", () => {
    // 3.5 days elapsed of 7 → 50% + 10% slack.
    const p = weeklyPace(0.5, resetIn(3.5), NOW, 0.1);
    expect(p.target).toBeCloseTo(0.6, 9);
    expect(p.ahead).toBeCloseTo(-0.1, 9);
  });

  it("is ahead when spend outruns the week", () => {
    expect(weeklyPace(0.44, resetIn(5), NOW, 0.1).ahead).toBeCloseTo(0.44 - (2 / 7 + 0.1), 9);
  });

  it("clamps at the start and end of the window", () => {
    expect(weeklyPace(0, nowSec + WEEK_SEC * 2, NOW, 0.1).target).toBeCloseTo(0.1, 9);
    expect(weeklyPace(0.99, nowSec + 1, NOW, 0.1).target).toBe(1);
  });

  it("is neutral with no window or a stale one", () => {
    expect(weeklyPace(0.9, 0, NOW)).toEqual(NO_PACE);
    expect(weeklyPace(0.9, undefined, NOW)).toEqual(NO_PACE);
    expect(weeklyPace(0.9, nowSec - 60, NOW)).toEqual(NO_PACE);
  });
});

const T = (id: string): SessionTarget => ({ provider: "anthropic", accountId: id });

/** Today's readings (2026-11-04 00:51 KST), close enough for ordering. */
function poolMetrics(over: Record<string, { util: number; daysLeft: number }>) {
  return (t: SessionTarget): TargetMetrics => {
    const w = over[t.accountId];
    return { util: 0.1, resetAtSec: nowSec + 3600, weekly: w ? { util: w.util, resetAtSec: resetIn(w.daysLeft) } : undefined };
  };
}

describe("SessionRouter with weekly pacing", () => {
  const readings = {
    lyra: { util: 0.35, daysLeft: 2.67 },
    rigel: { util: 0.34, daysLeft: 2.25 },
    vega: { util: 0.44, daysLeft: 5.67 },
    heewon: { util: 0.13, daysLeft: 5.13 },
  };
  const all = ["lyra", "rigel", "vega", "heewon"].map(T);

  it("never places a new session on a seat ahead of pace while one is on pace", () => {
    const r = new SessionRouter({ now: () => NOW, weeklyPace: { slack: 0.1, migrateAhead: 0.15 } });
    const utilOf = poolMetrics(readings);
    const picked = new Set<string>();
    for (let i = 0; i < 20; i++) picked.add(r.resolve(`s${i}`, all, () => true, utilOf)!.accountId);
    expect(picked.has("vega")).toBe(false);
    expect(picked.has("heewon")).toBe(true);
  });

  it("is off by default: the ahead seat still takes sessions", () => {
    const r = new SessionRouter({ now: () => NOW });
    const utilOf = poolMetrics(readings);
    const picked = new Set<string>();
    for (let i = 0; i < 20; i++) picked.add(r.resolve(`s${i}`, all, () => true, utilOf)!.accountId);
    expect(picked.has("vega")).toBe(true);
  });

  it("keeps serving when every seat is ahead, choosing the least ahead", () => {
    const r = new SessionRouter({ now: () => NOW, weeklyPace: { slack: 0.1, migrateAhead: 0.15 } });
    const utilOf = poolMetrics({ a: { util: 0.9, daysLeft: 5 }, b: { util: 0.6, daysLeft: 5 } });
    expect(r.resolve("s", [T("a"), T("b")], () => true, utilOf)?.accountId).toBe("b");
  });

  it("moves a pin only past migrateAhead, and only to an on-pace seat", () => {
    let m: Record<string, { util: number; daysLeft: number }> = {
      a: { util: 0.2, daysLeft: 6 }, b: { util: 0.05, daysLeft: 6 },
    };
    const moves: string[] = [];
    const r = new SessionRouter({
      now: () => NOW, weeklyPace: { slack: 0.1, migrateAhead: 0.15 },
      onReassign: ({ to, reason }) => moves.push(`${to.accountId}:${reason}`),
    });
    const targets = [T("a"), T("b")];
    // Pin to a: make b unusable for the first placement.
    expect(r.resolve("s", targets, t => t.accountId === "a", poolMetrics(m))?.accountId).toBe("a");
    // a is ahead (0.2 vs 1/7+0.1≈0.243 → on pace): stays.
    expect(r.resolve("s", targets, () => true, poolMetrics(m))?.accountId).toBe("a");
    // a slightly ahead (+0.05): still stays.
    m = { ...m, a: { util: 0.29, daysLeft: 6 } };
    expect(r.resolve("s", targets, () => true, poolMetrics(m))?.accountId).toBe("a");
    // Past migrateAhead, but b is ahead too: stays.
    m = { a: { util: 0.5, daysLeft: 6 }, b: { util: 0.4, daysLeft: 6 } };
    expect(r.resolve("s", targets, () => true, poolMetrics(m))?.accountId).toBe("a");
    // b back on pace: moves.
    m = { a: { util: 0.5, daysLeft: 6 }, b: { util: 0.05, daysLeft: 6 } };
    expect(r.resolve("s", targets, () => true, poolMetrics(m))?.accountId).toBe("b");
    expect(moves).toEqual(["b:weekly-pace"]);
  });
});

describe("five-hour pacing", () => {
  const HOUR = 3600;
  const cfg = { slack: 0.1, migrateAhead: 0.15, fiveHour: true, fiveHourSlack: 0.2 };
  /** `hoursLeft` hours before the 5-hour window closes. */
  const five = (util: number, hoursLeft: number) => ({ util, resetAtSec: nowSec + hoursLeft * HOUR });
  const week = { util: 0.1, resetAtSec: nowSec + 6 * DAY };
  const metrics = (over: Record<string, ReturnType<typeof five>>) => (t: SessionTarget): TargetMetrics =>
    ({ util: over[t.accountId]!.util, resetAtSec: over[t.accountId]!.resetAtSec, weekly: week, fiveHour: over[t.accountId] });

  it("measures the 5-hour window against five hours, not a week", () => {
    const p = weeklyPace(0.5, nowSec + 2.5 * HOUR, NOW, 0.2, 5 * HOUR);
    expect(p.target).toBeCloseTo(0.7, 9);
  });

  it("sends new sessions to the seat with 5-hour room, not the one that is full", () => {
    const r = new SessionRouter({ now: () => NOW, weeklyPace: cfg });
    const utilOf = metrics({ lyra: five(0.35, 4.8), rigel: five(1.0, 3.8), vega: five(1.0, 3.5) });
    const picked = new Set<string>();
    for (let i = 0; i < 12; i++) picked.add(r.resolve(`s${i}`, [T("lyra"), T("rigel"), T("vega")], () => true, utilOf)!.accountId);
    expect([...picked]).toEqual(["lyra"]);
  });

  it("ignores the 5-hour window when fiveHour pacing is off", () => {
    const r = new SessionRouter({ now: () => NOW, weeklyPace: { ...cfg, fiveHour: false } });
    const utilOf = metrics({ a: five(1.0, 3.8), b: five(1.0, 3.5) });
    const picked = new Set<string>();
    for (let i = 0; i < 12; i++) picked.add(r.resolve(`s${i}`, [T("a"), T("b")], () => true, utilOf)!.accountId);
    expect(picked.size).toBe(2);
  });

  it("moves a pin whose 5-hour window is far ahead, unless that window resets within 15 minutes", () => {
    const moves: string[] = [];
    const r = new SessionRouter({ now: () => NOW, weeklyPace: cfg, onReassign: ({ to, reason }) => moves.push(`${to.accountId}:${reason}`) });
    const t = [T("a"), T("b")];
    r.resolve("s", t, x => x.accountId === "a", metrics({ a: five(0.1, 4), b: five(0.1, 4) }));
    // a nearly full with a fresh window; b has room: leave.
    expect(r.resolve("s", t, () => true, metrics({ a: five(0.9, 4.5), b: five(0.1, 4.5) }))?.accountId).toBe("b");
    expect(moves).toEqual(["b:weekly-pace"]);
    // Pinned on b; b is full but resets in 10 minutes: stay.
    const stay = r.resolve("s", t, () => true, metrics({ a: five(0.1, 4.5), b: five(0.95, 10 / 60) }));
    expect(stay?.accountId).toBe("b");
  });
});
