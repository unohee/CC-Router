import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario2, ThrottleSpec } from "./balance/scenarios-2.js";
import type { DemandSpec, SeatSpec } from "./balance/scenarios.js";
import { simulate } from "./balance/sim.js";
import { measureWeeklySize } from "../proxy/seat-size.js";
import type { QuotaReading } from "../proxy/quota-history.js";

// scripts/balance-capture.mjs builds a simulator scenario from the router's
// recorded views. It is plain JS with no type declarations, so it is loaded
// through a non-literal dynamic import and typed here by hand.

const SCRIPT = fileURLToPath(new URL("../../scripts/balance-capture.mjs", import.meta.url));
const FIX = fileURLToPath(new URL("./fixtures/balance-capture/", import.meta.url));
const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 19, 10);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface SeatDetail { samples: number; errorBand: number | null; capSource: string; fiveCapSource: string }
interface Capture {
  measureWindow(readings: Json[], window: "sevenDay" | "fiveHour", nowMs: number): { tokens: number | null; samples: number; spanHours: number; errorBand: number | null };
  fitSeats(quota: Json, startMs: number, routing?: Json): { seats: SeatSpec[]; details: Record<string, SeatDetail>; notes: string[] };
  fitDemand(series: Json, usage: Json, health?: Json, opts?: { window: string }): { demand: DemandSpec; requestsPerDay: number; days: number; notes: string[] };
  fitThrottle(config: Json, health?: Json): { throttle: ThrottleSpec | undefined; notes: string[] };
  buildScenario(input: Json): { scenario: Scenario2 & { notes: string[]; capturedAt: string; source: Json }; details: Record<string, SeatDetail> };
}

let cap: Capture;
const fixture = (name: string): Json => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const quota = (): Json => fixture("quota-history.json");
const series = (): Json => fixture("usage-series-7d.json");
const usage = (): Json => fixture("usage-history.json");
const config = (): Json => fixture("config.json");
const health = (): Json => fixture("health.json");

beforeAll(async () => {
  const url: string = new URL("../../scripts/balance-capture.mjs", import.meta.url).href;
  cap = (await import(url)) as Capture;
});

describe("fitSeats", () => {
  it("pairs readings exactly as seat-size.ts measureWeeklySize does", () => {
    for (const a of quota().accounts) {
      const readings: QuotaReading[] = a.readings.map((r: Json) => ({ ...r, accountId: a.id }));
      const ts = measureWeeklySize(readings, START);
      const js = cap.measureWindow(a.readings, "sevenDay", START);
      expect({ tokens: js.tokens, samples: js.samples, spanHours: js.spanHours, errorBand: js.errorBand })
        .toEqual({ tokens: ts.tokensPerWeek, samples: ts.samples, spanHours: ts.spanHours, errorBand: ts.errorBand });
    }
  });

  it("measures alpha's week from its paired readings, with the error band", () => {
    const { seats, details } = cap.fitSeats(quota(), START);
    const alpha = seats.find(s => s.id === "alpha")!;
    // 9 pairs, 9e6 tokens each, 0.02 each: 81e6 / 0.18.
    expect(alpha.weeklyCap / 1e6).toBeCloseTo(450, 3);
    expect(details["alpha"].samples).toBe(9);
    expect(details["alpha"].errorBand).toBeCloseTo(0.01 / 0.18, 6);
    expect(details["alpha"].capSource).toBe("measured");
    expect(cap.fitSeats(quota(), START).notes.some(n => n.startsWith("alpha: weekly cap") && n.includes("error band +/-5.6%"))).toBe(true);
    expect(alpha.weeklyUtil).toBe(0.48);
    expect(alpha.weeklyResetH).toBe(50);
    // The 5-hour window moved 0.9 over the same 81e6.
    expect(alpha.fiveHourCap / 1e6).toBeCloseTo(90, 3);
    expect(alpha.fiveHourUtil).toBe(0.9);
    expect(alpha.fiveHourResetMin).toBe(120);
  });

  it("gives unmeasured beta the median measured cap and no 5-hour window, with notes", () => {
    const { seats, details, notes } = cap.fitSeats(quota(), START);
    const beta = seats.find(s => s.id === "beta")!;
    expect(beta.weeklyCap).toBe(seats.find(s => s.id === "alpha")!.weeklyCap);
    expect(details["beta"].capSource).toBe("median");
    expect(beta.fiveHourCap).toBe(0);
    expect(beta.fiveHourUtil).toBeUndefined();
    expect(beta.fiveHourResetMin).toBeUndefined();
    expect(beta.weeklyResetH).toBe(100.5);
    expect(notes.some(n => n.startsWith("beta: weekly cap unmeasured") && n.includes("median"))).toBe(true);
    expect(notes.some(n => n.startsWith("beta: never reported a 5-hour window"))).toBe(true);
  });

  it("scales the median by capacityWeight, and assumes 15% for a seat that once reported a 5-hour window", () => {
    const q = quota();
    q.accounts[1].readings[0].fiveHour.resetAt = START / 1000 - 4 * 3600;
    const { seats, details, notes } = cap.fitSeats(q, START, { balance: { capacityWeight: { beta: 2 } } });
    const alpha = seats.find(s => s.id === "alpha")!, beta = seats.find(s => s.id === "beta")!;
    expect(beta.weeklyCap).toBe(Math.round(2 * alpha.weeklyCap));
    expect(details["beta"].capSource).toBe("weight");
    expect(beta.fiveHourCap).toBe(Math.round(0.15 * beta.weeklyCap));
    expect(notes.some(n => n.includes("ASSUMED 15%"))).toBe(true);
  });

  it("clamps a 5-hour reset more than a window past the start hour to 300 min", () => {
    const q = quota();
    q.accounts[0].readings[9].fiveHour.resetAt = START / 1000 + 310 * 60;
    const { seats, notes } = cap.fitSeats(q, START);
    expect(seats.find(s => s.id === "alpha")!.fiveHourResetMin).toBe(300);
    expect(notes.some(n => n.includes("clamped to 300"))).toBe(true);
  });

  it("models a seat whose weekly reset is 0 or past as a fresh week", () => {
    for (const resetAt of [0, START / 1000 - 60]) {
      const q = quota();
      q.accounts[0].readings[9].sevenDay.resetAt = resetAt;
      const { seats, notes } = cap.fitSeats(q, START);
      const alpha = seats.find(s => s.id === "alpha")!;
      expect(alpha.weeklyUtil).toBe(0);
      expect(alpha.weeklyResetH).toBe(168);
      expect(notes.some(n => n.startsWith("alpha:") && n.includes("fresh week"))).toBe(true);
    }
  });

  it("uses the newest reading at or before the start and skips an account with none", () => {
    const { seats, notes } = cap.fitSeats(quota(), START - 2 * HOUR);
    expect(seats.map(s => s.id)).toEqual(["alpha"]);
    expect(seats[0].weeklyUtil).toBe(0.44);
    expect(seats[0].weeklyResetH).toBe(52);
    expect(notes.some(n => n.startsWith("beta:") && n.includes("skipped"))).toBe(true);
  });

  it("falls back to 450e6 when no seat is measured", () => {
    const q = quota();
    q.accounts = [q.accounts[1]];
    expect(cap.fitSeats(q, START).seats[0].weeklyCap).toBe(450e6);
  });
});

/** The fixtures' per-request figures were set against the 7-day window; the default is the last day. */
const W7 = { window: "7d" } as const;

describe("fitDemand", () => {
  it("takes the rate and token sizes from the last day by default, and the profile from the whole series", () => {
    const d1 = cap.fitDemand(series(), usage(), health());
    const d7 = cap.fitDemand(series(), usage(), health(), W7);
    // The fixture's 1d window has the same tokens as its 7d one over 1000 requests instead of 7000.
    expect(d1.requestsPerDay).toBe(1000);
    expect(d7.requestsPerDay).toBe(1000);
    expect(d1.demand.freshInput).toBe(7 * d7.demand.freshInput);
    expect(d1.demand.profile).toEqual(d7.demand.profile);
    expect(d1.notes.some(n => /from usage-history 1d/.test(n))).toBe(true);
  });

  it("measures the no-session share from health's recent log when it has at least 20 entries, else assumes 0.08", () => {
    const h = health() as { recentLogs?: unknown[] };
    const withLogs = { ...h, recentLogs: [...Array.from({ length: 45 }, () => ({ statusCode: 200, sessionId: "s" })), ...Array.from({ length: 5 }, () => ({ statusCode: 200 }))] };
    const d = cap.fitDemand(series(), usage(), withLogs, W7);
    expect(d.demand.noSessionShare).toBe(0.1);
    expect(d.notes.some(n => /5 of 50 recent/.test(n))).toBe(true);
    const few = { ...h, recentLogs: [{ statusCode: 200 }] };
    expect(cap.fitDemand(series(), usage(), few, W7).demand.noSessionShare).toBe(0.08);
  });

  it("folds requests by UTC hour into a profile peaking at 1", () => {
    const { demand, requestsPerDay, days } = cap.fitDemand(series(), usage(), health(), W7);
    expect(demand.profile).toHaveLength(24);
    expect(demand.profile[14]).toBe(1);
    expect(demand.profile[3]).toBe(0.05);
    expect(demand.profile[10]).toBe(0.4);
    expect(days).toBe(7);
    expect(requestsPerDay).toBe(1000);
  });

  it("takes per-request tokens from the usage totals", () => {
    const { demand } = cap.fitDemand(series(), usage(), health(), W7);
    expect(demand.freshInput).toBe(1000);
    expect(demand.output).toBe(500);
    expect(demand.prefix).toEqual({ start: 30_000, perRequest: 2_000, max: 350_000 });
    expect(demand.noSessionCost).toBe(Math.round(1.25 * 1000 + 5 * 500));
    expect(demand.sessionMinutes).toEqual([30, 240]);
    expect(demand.noSessionShare).toBe(0.08);
  });

  it("uses health's placed sessions when they are above the floor", () => {
    const { demand, notes } = cap.fitDemand(series(), usage(), health(), W7);
    // floor = ceil(1000 x 0.92 / (135 x 0.6)) = 12 < 30.
    expect(demand.sessionsPerDay).toBe(30);
    expect(demand.requestChance).toBeCloseTo((1000 * 0.92) / (30 * 135), 3);
    expect(notes.some(n => n.includes("from health balance.placements.lastDay.placed"))).toBe(true);
  });

  it("falls back to requests / 40 without health", () => {
    const { demand, notes } = cap.fitDemand(series(), usage(), undefined, W7);
    expect(demand.sessionsPerDay).toBe(25);
    expect(notes.some(n => n.includes("ASSUMED requestsPerDay / 40"))).toBe(true);
  });

  it("raises too few placed sessions to the floor that keeps requestChance at or under 0.6", () => {
    const h = health();
    h.balance.placements.lastDay.placed = 2;
    const { demand, notes } = cap.fitDemand(series(), usage(), h, W7);
    expect(demand.sessionsPerDay).toBe(12);
    expect(demand.requestChance).toBeLessThanOrEqual(0.6);
    expect(demand.requestChance).toBeCloseTo((1000 * 0.92) / (12 * 135), 3);
    expect(notes.some(n => n.includes("is the floor") && n.includes("(2) was lower"))).toBe(true);
  });

  it("clamps requestChance at 0.05 from below", () => {
    const h = health();
    h.balance.placements.lastDay.placed = 10_000;
    expect(cap.fitDemand(series(), usage(), h, W7).demand.requestChance).toBe(0.05);
  });
});

describe("fitThrottle", () => {
  it("maps config.throttle and takes service time from the p50", () => {
    expect(cap.fitThrottle(config(), health()).throttle).toEqual({
      perAccountMaxInFlight: 3, startUtil: 0.7, hardUtil: 0.9, serviceSeconds: 4.8, maxWaitSeconds: 15,
    });
  });

  it("defaults a missing maxWaitMs to 20 s and the service time to 12 s, with notes", () => {
    const c = config();
    delete c.throttle.maxWaitMs;
    const { throttle, notes } = cap.fitThrottle(c);
    expect(throttle?.maxWaitSeconds).toBe(20);
    expect(throttle?.serviceSeconds).toBe(12);
    expect(notes.some(n => n.includes("no maxWaitMs"))).toBe(true);
  });

  it("omits the throttle when the config has none", () => {
    const c = config();
    delete c.throttle;
    expect(cap.fitThrottle(c).throttle).toBeUndefined();
  });
});

describe("malformed input", () => {
  it("throws with a clear message", () => {
    expect(() => cap.fitSeats({ accounts: "x" }, START)).toThrow(/quota history/);
    const q = quota();
    q.accounts[0].readings[0].sevenDay.util = "high";
    expect(() => cap.fitSeats(q, START)).toThrow(/malformed reading for alpha/);
    const s = series();
    for (const p of s.points) p.requests = p.requests.map(() => 0);
    expect(() => cap.fitDemand(s, usage())).toThrow(/all zero/);
    expect(() => cap.fitDemand({ ...series(), step: "day" }, usage())).toThrow(/hourly/);
    const u = usage();
    u.windows["7d"].requests = 0;
    expect(() => cap.fitDemand(series(), u, undefined, W7)).toThrow(/no requests/);
    expect(() => cap.fitDemand(series(), usage(), undefined, { window: "2d" })).toThrow(/window/);
    expect(() => cap.fitDemand(series(), {})).toThrow(/usage history/);
    expect(() => cap.fitThrottle({ throttle: 4 })).toThrow(/throttle/);
  });
});

describe("buildScenario", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterAll(() => { vi.useRealTimers(); });

  it("starts at the latest common hour and yields a scenario the simulator runs", () => {
    const { scenario } = cap.buildScenario({ quota: quota(), series: series(), usage: usage(), config: config(), health: health() });
    expect(scenario.capturedAt).toBe(new Date(START).toISOString());
    expect(scenario.source).toEqual({ quotaGeneratedAt: new Date(START + 1_800_000).toISOString(), usageRange: "7d" });
    expect(scenario.routing).toEqual(config().routing);
    expect(scenario.historyAvailable).toBe(true);
    expect(scenario.notes.length).toBeGreaterThan(5);
    const r = simulate(scenario, { setClock: ms => vi.setSystemTime(ms) });
    for (const v of Object.values(r.metrics)) expect(Number.isFinite(v)).toBe(true);
  });

  it("rotates the profile so simulated hour 0 is the start hour's demand (the simulator's clock starts at 00:00)", () => {
    const flat = cap.fitDemand(series(), usage(), health(), W7).demand.profile;
    // START is 10:00Z: simulated hour 0 carries UTC hour 10's demand.
    const at10 = cap.buildScenario({ quota: quota(), series: series(), usage: usage(), config: config(), health: health(), startMs: START }).scenario;
    expect(at10.demand.profile).toEqual(flat.map((_: number, h: number) => flat[(h + 10) % 24]));
    expect(at10.notes.some(n => /rotated by 10 h/.test(n))).toBe(true);
    // A midnight start needs no rotation. The fixture's readings begin at 01:00Z, so build it from a shifted copy.
    const shifted = JSON.parse(JSON.stringify(quota())) as { accounts: Array<{ readings: Array<{ hour: number; sampledAt: number }> }> };
    for (const a of shifted.accounts) for (const r of a.readings) { r.hour -= 10 * HOUR; r.sampledAt -= 10 * HOUR; }
    const at0 = cap.buildScenario({ quota: shifted, series: series(), usage: usage(), config: config(), health: health(), startMs: START - 10 * HOUR }).scenario;
    expect(at0.demand.profile).toEqual(flat);
    expect(at0.notes.some(n => /rotated/.test(n))).toBe(false);
  });
});

describe("the CLI", () => {
  it("writes a parseable scenario with notes, and exits non-zero on bad input", () => {
    const out = join(mkdtempSync(join(tmpdir(), "balance-capture-")), "scenario.json");
    const args = ["--quota", "quota-history.json", "--series", "usage-series-7d.json", "--usage", "usage-history.json", "--config", "config.json"]
      .map((a, i) => (i % 2 ? join(FIX, a) : a));
    const ok = spawnSync(process.execPath, [SCRIPT, ...args, "--health", join(FIX, "health.json"), "--out", out], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/alpha: .*measured/);
    expect(ok.stdout).toMatch(/demand: /);
    const sc = JSON.parse(readFileSync(out, "utf8"));
    expect(Array.isArray(sc.notes) && sc.notes.length > 0).toBe(true);
    expect(sc.seats).toHaveLength(2);

    const bad = spawnSync(process.execPath, [SCRIPT, ...args.slice(0, 2), "--series", join(FIX, "config.json"), ...args.slice(4), "--out", out], { encoding: "utf8" });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/balance-capture: usage series/);
  });
});
