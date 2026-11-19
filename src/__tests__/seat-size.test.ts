import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_SEAT_SIZE_OPTIONS, measureWeeklySize, seatSizes } from "../proxy/seat-size.js";
import { parseCapacityWeights } from "../config/manager.js";
import type { QuotaReading } from "../proxy/quota-history.js";

// Seat size: how much quota a seat's week holds against a typical seat, so
// placement can compare what seats have left as amounts. Measured from quota
// history first, then a configured weight, then "typical".

const NOW = Date.UTC(2026, 10, 19, 12, 0);
const H = 3_600_000;
const RESET = NOW / 1000 + 4 * 86_400;

/** Hourly readings of one seat: weekly util and cumulative spend at each hour, oldest first. */
function rows(id: string, points: Array<[util: number, spent: number | null]>, resetAt = RESET, endAt = NOW): QuotaReading[] {
  return points.map(([util, spent], i) => {
    const t = endAt - (points.length - 1 - i) * H;
    return {
      hour: t, accountId: id, sampledAt: t,
      fiveHour: { util: 0, resetAt: 0 },
      sevenDay: { util, resetAt },
      spentAt: spent,
    };
  });
}

/** `n` hours of a seat spending `perPoint` tokens per weekly point, one point an hour. */
function climbing(id: string, from: number, n: number, perPoint: number): QuotaReading[] {
  return rows(id, Array.from({ length: n + 1 }, (_, i) => [Math.round((from + 0.01 * i) * 100) / 100, i * perPoint]));
}

describe("measureWeeklySize", () => {
  it("is tokens billed over the weekly utilization they moved, per full week", () => {
    const m = measureWeeklySize(climbing("kyte", 0.09, 8, 9_200_000), NOW);
    expect(m.samples).toBe(8);
    expect(m.tokensPerWeek).toBeCloseTo(920_000_000, -3);
  });

  it("is null until enough pairs have moved enough", () => {
    expect(measureWeeklySize(climbing("a", 0.1, 2, 4_500_000), NOW)).toMatchObject({ tokensPerWeek: null, samples: 2, errorBand: null });
    // Ten pairs but only 0.05 moved: the 0.01 header rounding could be a fifth of it.
    const slow = rows("a", Array.from({ length: 11 }, (_, i) => [Math.round((0.1 + 0.005 * i) * 1000) / 1000, i * 1_000_000]));
    expect(measureWeeklySize(slow, NOW)).toMatchObject({ tokensPerWeek: null, samples: 10, errorBand: null });
    expect(DEFAULT_SEAT_SIZE_OPTIONS.minMoved).toBeGreaterThanOrEqual(0.08);
  });

  it("leaves out pairs across a reset, a lost spend counter, readings from before spend was kept, and old readings", () => {
    const good = climbing("a", 0.2, 10, 4_500_000);
    const base = measureWeeklySize(good, NOW);
    expect(base.tokensPerWeek).toBeCloseTo(450_000_000, -3);
    const plus = (extra: QuotaReading[]) => measureWeeklySize([...extra, ...good], NOW);
    // Each extra group ends with a spend above the good run's first (0), so the
    // pair joining them reads as a lost counter and only the rule under test decides.
    // A pair whose resets differ spans a reset: the drop and the spend are not one window.
    const acrossReset = rows("a", [[0.02, 5e9], [0.9, 6e9]], RESET, NOW - 20 * H);
    acrossReset[0].sevenDay.resetAt = RESET - 7 * 86_400;
    expect(plus(acrossReset)).toEqual(base);
    // Spend going backwards: the counter was lost in a restart.
    expect(plus(rows("a", [[0.1, 6e9], [0.15, 5e9]], RESET, NOW - 20 * H))).toEqual(base);
    // Readings from before spend was kept.
    expect(plus(rows("a", [[0.1, null], [0.15, null]], RESET, NOW - 20 * H))).toEqual(base);
    // Older than 14 days.
    const old = climbing("a", 0.05, 10, 99_000_000).map(r => ({ ...r, sampledAt: r.sampledAt - 20 * 86_400_000 }));
    expect(plus(old)).toEqual(base);
  });
});

describe("seatSizes", () => {
  const live = [
    ...climbing("kyte", 0.09, 8, 9_200_000),
    ...climbing("rigel", 0.90, 8, 4_600_000),
    ...climbing("lyra", 0.86, 8, 4_400_000),
    ...climbing("heewon", 0.54, 10, 4_500_000),
    ...climbing("vega", 0.31, 12, 4_550_000),
  ];

  it("measures each seat against the median measured seat", () => {
    const s = seatSizes(["kyte", "rigel", "lyra", "heewon", "vega"], live, NOW);
    expect(s.get("kyte")).toMatchObject({ source: "measured", samples: 8 });
    expect(s.get("kyte")!.relative).toBeCloseTo(9_200_000 / 4_550_000, 2);
    // The Team seats differ by a couple of percent: within the measurement's
    // error they are all typical, so they do not reorder each other.
    for (const id of ["rigel", "lyra", "heewon", "vega"]) expect(s.get(id)!.relative).toBe(1);
  });

  it("falls back to capacityWeight for a seat it cannot measure, then to typical", () => {
    const s = seatSizes(["kyte", "rigel", "new", "other"], live, NOW, { new: 3, other: "x", kyte: 9 });
    expect(s.get("new")).toMatchObject({ relative: 3, source: "weight" });
    expect(s.get("other")).toMatchObject({ relative: 1, source: "equal" });
    // A measured seat ignores its weight.
    expect(s.get("kyte")!.source).toBe("measured");
  });

  it("with nothing measured, weights stand alone against 1", () => {
    const s = seatSizes(["a", "b"], [], NOW, { a: 2 });
    expect(s.get("a")).toEqual({ relative: 2, source: "weight", tokensPerWeek: null, samples: 0, spanHours: 0, errorBand: null, moved: 0 });
    expect(s.get("b")).toEqual({ relative: 1, source: "equal", tokensPerWeek: null, samples: 0, spanHours: 0, errorBand: null, moved: 0 });
  });

  it("ignores weights that are out of range or inherited", () => {
    const s = seatSizes(["a", "b", "c", "constructor"], [], NOW, { a: 0, b: -2, c: 1e9 } as Record<string, unknown>);
    for (const id of ["a", "b", "c", "constructor"]) expect(s.get(id)!.source).toBe("equal");
  });
});

describe("routing.balance.capacityWeight", () => {
  it("is read from the routing block", () => {
    expect(parseCapacityWeights(undefined)).toBeUndefined();
    expect(parseCapacityWeights({ balance: {} })).toBeUndefined();
    expect(parseCapacityWeights({ balance: { capacityWeight: { kyte: 2 } } })).toEqual({ kyte: 2 });
    expect(parseCapacityWeights({ balance: { capacityWeight: [1, 2] as never } })).toBeUndefined();
  });

  it("reaches placement through the server's seat sizes", () => {
    const src = readFileSync(fileURLToPath(new URL("../proxy/server.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/seatSizes\(pool\.getAll\(\)\.map\(a => a\.id\), quotaHistory\.readings\(\), now, getCapacityWeights\(\)\)/);
    expect(src).toMatch(/sizeOf: id => currentSeatSizes\(\)\.get\(id\)\?\.relative \?\? 1/);
  });
});

describe("the measurement's history span and error band", () => {
  it("report how much history the pairs cover and how far off the estimate can be", () => {
    // Readings an hour apart, utilization climbing a point a reading: 12 pairs over 12 hours, moved 0.12.
    const readings = climbing("a", 0.03, 12, 1_000_000);
    const m = measureWeeklySize(readings, NOW);
    expect(m.samples).toBe(12);
    expect(m.spanHours).toBeCloseTo(12, 6);
    // 0.01 of rounding over 0.12 moved: within about 8%.
    expect(m.errorBand).toBeCloseTo(0.01 / 0.12, 6);
    expect(m.tokensPerWeek).not.toBeNull();
    const s = seatSizes(["a"], readings, NOW);
    expect(s.get("a")).toMatchObject({ source: "measured", spanHours: m.spanHours, errorBand: m.errorBand });
  });
});
