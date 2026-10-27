import { describe, expect, it } from "vitest";
import { HOUR_MS, DAY_MS, type UsageBucket } from "../proxy/usage-history.js";
import { createUsageSeriesProvider, parseSeriesRange, summarizeSeries } from "../proxy/usage-series.js";

const NOW = Date.parse("2026-10-26T12:30:00Z");
const HOUR = Math.floor(NOW / HOUR_MS) * HOUR_MS;

function bucket(hoursAgo: number, model: string, over: Partial<UsageBucket> = {}): UsageBucket {
  return {
    hour: HOUR - hoursAgo * HOUR_MS, provider: "anthropic", model,
    input: 10, output: 100, cacheRead: 1000, cacheCreation: 0, requests: 2, ...over,
  };
}
const source = (buckets: UsageBucket[], since: number | null = NOW - 40 * DAY_MS) => ({ buckets: () => buckets, since });

describe("summarizeSeries", () => {
  it("draws the last 24 hours as 24 hourly steps ending with the current hour", () => {
    const s = summarizeSeries(source([bucket(0, "opus"), bucket(23, "opus"), bucket(24, "opus")]), { now: NOW, range: "24h", tz: "UTC" });
    expect(s.step).toBe("hour");
    expect(s.points).toHaveLength(24);
    expect(s.points[23].start).toBe(HOUR);
    expect(s.points[0].start).toBe(HOUR - 23 * HOUR_MS);
    // The 24-hour-old bucket is outside.
    expect(s.totals.requests).toBe(4);
    expect(s.points[23].requests).toEqual([2]);
  });

  it("draws 7 days by the hour and 30 days by the viewer's calendar day", () => {
    const src = source([bucket(0, "opus")]);
    expect(summarizeSeries(src, { now: NOW, range: "7d", tz: "UTC" }).points).toHaveLength(168);
    const days = summarizeSeries(src, { now: NOW, range: "30d", tz: "Asia/Seoul" });
    expect(days.step).toBe("day");
    expect(days.points).toHaveLength(30);
    expect(days.points[29].date).toBe("2026-10-26");
  });

  it("puts an hour on the local day its midpoint falls on", () => {
    // 15:00Z is 00:00 the next day in Seoul.
    const late = { ...bucket(0, "opus"), hour: Date.parse("2026-10-25T15:00:00Z") };
    const days = summarizeSeries(source([late]), { now: NOW, range: "30d", tz: "Asia/Seoul" });
    const hit = days.points.find(p => p.requests[0] > 0)!;
    expect(hit.date).toBe("2026-10-26");
  });

  it("names every model by 30-day tokens and keeps that order on every range", () => {
    const models = Array.from({ length: 12 }, (_, i) => `m${i}`);
    // m0 is the biggest over 30 days but was idle today.
    const buckets = models.map((m, i) => bucket(i === 0 ? 48 : 1, m, { cacheRead: (100 - i) * 1000 }));
    const day = summarizeSeries(source(buckets), { now: NOW, range: "24h", tz: "UTC" });
    const month = summarizeSeries(source(buckets), { now: NOW, range: "30d", tz: "UTC" });
    expect(day.series.map(s => s.model)).toEqual(month.series.map(s => s.model));
    expect(day.series).toHaveLength(12);
    expect(day.series[0].model).toBe("m0");
    expect(day.series.map(s => s.model)).toEqual(models);
    expect(day.series.every(s => !s.other)).toBe(true);
    const last = day.points[22];
    expect(last.requests.slice(1)).toEqual(Array(11).fill(2));
  });

  it("marks steps before recording began as unrecorded, not zero", () => {
    const s = summarizeSeries(source([], HOUR - 2 * HOUR_MS), { now: NOW, range: "24h", tz: "UTC" });
    expect(s.points.filter(p => p.recorded)).toHaveLength(3);
    expect(summarizeSeries(source([], null), { now: NOW, range: "24h", tz: "UTC" }).points.every(p => !p.recorded)).toBe(true);
  });

  it("reports the cache ratio for Claude rows only, and null with nothing to divide", () => {
    const s = summarizeSeries(source([
      bucket(0, "opus", { input: 100, cacheRead: 900, cacheCreation: 0 }),
      bucket(0, "gpt", { provider: "openai", input: 5000, cacheRead: 0 }),
    ]), { now: NOW, range: "24h", tz: "UTC" });
    expect(s.totals.cacheHitRatio).toBeCloseTo(0.9);
    expect(summarizeSeries(source([]), { now: NOW, range: "24h", tz: "UTC" }).totals.cacheHitRatio).toBeNull();
  });

  it("takes an unknown range as 24h", () => {
    expect(parseSeriesRange("1y")).toBe("24h");
    expect(parseSeriesRange(["7d"])).toBe("24h");
    expect(parseSeriesRange("30d")).toBe("30d");
  });

  it("memoises per range and zone, so the open route cannot be made to recompute at will", () => {
    let calls = 0;
    const src = { buckets: () => { calls++; return []; }, since: null };
    let t = NOW;
    const get = createUsageSeriesProvider(src, { now: () => t });
    get("24h", "UTC"); get("24h", "UTC"); get("7d", "UTC");
    expect(calls).toBe(2);
    t += 5000;
    get("24h", "UTC");
    expect(calls).toBe(3);
  });
});
