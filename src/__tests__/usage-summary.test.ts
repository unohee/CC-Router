import { describe, it, expect } from "vitest";
import type { UsageBucket } from "../proxy/usage-history.js";
import {
  summarizeUsage, resolveTimeZone, createUsageSummaryProvider, DISPLAY_DAYS,
  type DayCell, type UsageSummary, type UsageSource,
} from "../proxy/usage-summary.js";

const NOW = Date.parse("2026-10-16T12:30:00Z");
const EARLY = Date.parse("2026-01-01T00:00:00Z");

function bucket(hourIso: string, over: Partial<UsageBucket> = {}): UsageBucket {
  return { hour: Date.parse(hourIso), provider: "anthropic", model: "m", input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0, ...over };
}
const src = (buckets: UsageBucket[], since: number | null = EARLY): UsageSource => ({ buckets: () => buckets, since });
const dayCell = (s: UsageSummary, date: string): DayCell => {
  const c = s.cells.find(x => !("pad" in x) && x.date === date);
  if (!c || "pad" in c) throw new Error(`no cell for ${date}`);
  return c;
};
const allDays = (s: UsageSummary): DayCell[] => s.cells.filter((c): c is DayCell => !("pad" in c));

/** One 1-token bucket for every hour from `from` to `to`, inclusive. */
function hourly(from: string, to: string): UsageBucket[] {
  const out: UsageBucket[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 3_600_000) out.push(bucket(new Date(t).toISOString(), { input: 1 }));
  return out;
}

describe("resolveTimeZone", () => {
  it("uses UTC, without calling it a fallback, when none was asked for", () => {
    expect(resolveTimeZone(undefined)).toEqual({ tz: "UTC", fallback: false });
    expect(resolveTimeZone("")).toEqual({ tz: "UTC", fallback: false });
  });

  it("accepts a real zone and hands back its canonical name", () => {
    expect(resolveTimeZone("Asia/Seoul")).toEqual({ tz: "Asia/Seoul", fallback: false });
    expect(resolveTimeZone("America/Argentina/Buenos_Aires").fallback).toBe(false);
  });

  it("falls back to UTC, flagged, for anything that is not a zone — and never echoes the input", () => {
    for (const bad of ["Mars/Phobos", "../etc/passwd", "<script>alert(1)</script>", "x".repeat(65), ["Asia/Seoul"], 5, {}, "Asia/Seoul\n"]) {
      expect(resolveTimeZone(bad)).toEqual({ tz: "UTC", fallback: true });
    }
  });
});

describe("rolling windows", () => {
  it("count a bucket when more than half of it is inside, and not before", () => {
    const s = summarizeUsage(src([
      bucket("2026-10-15T11:00:00Z", { input: 1 }),   // ends 12:00, before the 12:30 edge
      bucket("2026-10-15T12:00:00Z", { input: 10 }),  // exactly half inside: not counted
      bucket("2026-10-15T13:00:00Z", { input: 100 }), // inside
      bucket("2026-10-16T12:00:00Z", { input: 1000 }),// the current hour
      bucket("2026-10-16T13:00:00Z", { input: 9999 }),// in the future: never counted
    ]), { now: NOW });
    expect(s.windows["1d"].total).toBe(1100);
    expect(s.windows["7d"].total).toBe(1111);
  });

  it("count the bucket the window edge falls in when most of it is inside, and drop it when most is outside", () => {
    const bucketYesterday = [bucket("2026-10-15T12:00:00Z", { input: 1 })]; // spans 12:00-13:00
    // Window opens at 12:10: 50 of the bucket's 60 minutes are inside.
    expect(summarizeUsage(src(bucketYesterday), { now: Date.parse("2026-10-16T12:10:00Z") }).windows["1d"].total).toBe(1);
    // Window opens at 12:50: only 10 are.
    expect(summarizeUsage(src(bucketYesterday), { now: Date.parse("2026-10-16T12:50:00Z") }).windows["1d"].total).toBe(0);
  });

  it("add the four token kinds into total and sum every provider", () => {
    const s = summarizeUsage(src([
      bucket("2026-10-16T12:00:00Z", { input: 1, output: 2, cacheRead: 4, cacheCreation: 8, requests: 3 }),
      bucket("2026-10-16T12:00:00Z", { provider: "openai", model: "gpt", input: 16, output: 32, requests: 2 }),
    ]), { now: NOW });
    expect(s.windows["1d"]).toMatchObject({ total: 63, input: 17, output: 34, cacheRead: 4, cacheCreation: 8, requests: 5 });
  });

  it("report a window as partial until recording covers all of it", () => {
    const base = [bucket("2026-10-16T12:00:00Z", { input: 1 })];
    const since = (iso: string | null) => summarizeUsage(src(base, iso === null ? null : Date.parse(iso)), { now: NOW }).windows;
    // Recording began 7.5 days before `now`: it covers the 1d and 7d windows, not 14d or 30d.
    const w = since("2026-10-09T00:00:00Z");
    expect([w["1d"].partial, w["7d"].partial, w["14d"].partial, w["30d"].partial]).toEqual([false, false, true, true]);
    // 6.5 days: not enough for a full 7d window.
    expect(since("2026-10-10T00:00:00Z")["7d"].partial).toBe(true);
    expect(since(null)["1d"].partial).toBe(true);
    expect(since("2026-01-01T00:00:00Z")["30d"].partial).toBe(false);
  });
});

describe("calendar days", () => {
  it("builds the displayed run of dates ending today", () => {
    const s = summarizeUsage(src([]), { now: NOW });
    const days = allDays(s);
    expect(days).toHaveLength(DISPLAY_DAYS);
    expect(days[0].date).toBe("2026-07-19");
    expect(days[days.length - 1].date).toBe("2026-10-16");
  });

  it("ends on the viewer's today, not the server's", () => {
    const late = Date.parse("2026-10-16T20:00:00Z"); // 05:00 on the 17th in Seoul
    expect(allDays(summarizeUsage(src([]), { now: late, tz: "Asia/Seoul" })).at(-1)!.date).toBe("2026-10-17");
    expect(allDays(summarizeUsage(src([]), { now: late, tz: "UTC" })).at(-1)!.date).toBe("2026-10-16");
  });

  it("pads the front so the first date sits on its weekday (Sunday first)", () => {
    // Weekdays worked out by hand: 2026-10-13 is a Tuesday, 10-18 a Sunday, 10-17 a Saturday.
    for (const [now, days, wantPad] of [["2026-10-16T12:00:00Z", 4, 2], ["2026-10-18T12:00:00Z", 1, 0], ["2026-10-17T12:00:00Z", 1, 6]] as const) {
      const s = summarizeUsage(src([]), { now: Date.parse(now), days });
      const firstReal = s.cells.findIndex(c => !("pad" in c));
      const first = s.cells[firstReal] as DayCell;
      expect(firstReal).toBe(wantPad);
      expect(new Date(`${first.date}T00:00:00Z`).getUTCDay()).toBe(wantPad);
      expect(s.cells.slice(0, firstReal).every(c => "pad" in c)).toBe(true);
    }
  });

  it("leaves a bucket from the future out of today's cell, as it is left out of the windows", () => {
    // A restored file can hold hours the clock has not reached yet; record() clamps them, restore() does not.
    const s = summarizeUsage(src([
      bucket("2026-10-16T12:00:00Z", { input: 1 }),
      bucket("2026-10-16T14:00:00Z", { input: 9 }),
    ]), { now: NOW, tz: "UTC" });
    expect(dayCell(s, "2026-10-16").total).toBe(1);
    expect(s.windows["1d"].total).toBe(1);
  });

  it("puts an hour on the day it falls in for the viewer", () => {
    const b = [
      bucket("2026-10-15T14:00:00Z", { input: 1 }), // 23:00 in Seoul on the 15th
      bucket("2026-10-15T15:00:00Z", { input: 10 }),// 00:00 in Seoul on the 16th
    ];
    const seoul = summarizeUsage(src(b), { now: NOW, tz: "Asia/Seoul" });
    expect([dayCell(seoul, "2026-10-15").total, dayCell(seoul, "2026-10-16").total]).toEqual([1, 10]);
    const utc = summarizeUsage(src(b), { now: NOW, tz: "UTC" });
    expect([dayCell(utc, "2026-10-15").total, dayCell(utc, "2026-10-16").total]).toEqual([11, 0]);
  });

  it("attributes by midpoint, so an hour straddling local midnight in a half-hour zone lands on the later day", () => {
    const b = [
      bucket("2026-10-15T17:00:00Z", { input: 1 }),  // 22:30-23:30 in Kolkata
      bucket("2026-10-15T18:00:00Z", { input: 10 }), // 23:30-00:30: midpoint is midnight
    ];
    const kolkata = summarizeUsage(src(b), { now: NOW, tz: "Asia/Kolkata" });
    expect([dayCell(kolkata, "2026-10-15").total, dayCell(kolkata, "2026-10-16").total]).toEqual([1, 10]);
    const b2 = [bucket("2026-10-15T17:00:00Z", { input: 1 }), bucket("2026-10-15T18:00:00Z", { input: 10 })];
    const kathmandu = summarizeUsage(src(b2), { now: NOW, tz: "Asia/Kathmandu" }); // +5:45
    expect([dayCell(kathmandu, "2026-10-15").total, dayCell(kathmandu, "2026-10-16").total]).toEqual([1, 10]);
  });

  it("gives a 25-hour day all 25 of its hours when clocks go back", () => {
    const b = hourly("2026-11-01T04:00:00Z", "2026-11-02T04:00:00Z");
    const s = summarizeUsage(src(b), { now: Date.parse("2026-11-02T12:00:00Z"), tz: "America/New_York" });
    expect(b).toHaveLength(25);
    expect(dayCell(s, "2026-11-01").total).toBe(25);
    expect(dayCell(s, "2026-10-31").total).toBe(0);
    expect(dayCell(s, "2026-11-02").total).toBe(0);
  });

  it("gives a 23-hour day its 23 hours when clocks go forward", () => {
    const b = hourly("2026-03-08T05:00:00Z", "2026-03-09T03:00:00Z");
    const s = summarizeUsage(src(b), { now: Date.parse("2026-03-09T12:00:00Z"), tz: "America/New_York" });
    expect(b).toHaveLength(23);
    expect(dayCell(s, "2026-03-08").total).toBe(23);
    expect(dayCell(s, "2026-03-09").total).toBe(0);
  });

  it("handles the European change as well", () => {
    const b = hourly("2026-10-24T23:00:00Z", "2026-10-25T23:00:00Z");
    const s = summarizeUsage(src(b), { now: Date.parse("2026-10-26T12:00:00Z"), tz: "Europe/London" });
    expect(dayCell(s, "2026-10-25").total).toBe(25);
    expect(allDays(s).filter(c => c.date !== "2026-10-25").every(c => c.total === 0)).toBe(true);
  });

  it("never loses or invents a token: every bucket in range lands on exactly one day", () => {
    const b = hourly("2026-09-01T00:00:00Z", "2026-10-16T12:00:00Z").map((x, i) => ({ ...x, input: (i % 7) + 1, output: i % 3, cacheRead: i % 5 }));
    const want = b.reduce((n, x) => n + x.input + x.output + x.cacheRead, 0);
    for (const tz of ["UTC", "Asia/Seoul", "Asia/Kolkata", "Asia/Kathmandu", "America/New_York", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      const s = summarizeUsage(src(b), { now: NOW, tz });
      expect(allDays(s).reduce((n, c) => n + c.total, 0), tz).toBe(want);
    }
  });
});

describe("no data versus zero", () => {
  const used = [bucket("2026-10-12T10:00:00Z", { input: 5 })];

  it("marks days before recording began as null, and recorded-but-idle days as 0", () => {
    const s = summarizeUsage(src(used, Date.parse("2026-10-10T08:00:00Z")), { now: NOW });
    expect(dayCell(s, "2026-10-09").level).toBeNull();
    expect(dayCell(s, "2026-10-10").level).toBe(0);
    expect(dayCell(s, "2026-10-11").level).toBe(0);
    expect(dayCell(s, "2026-10-12").level).toBe(1);
    expect(s.details.recordedDays).toBe(7);
  });

  it("is all null before anything has ever been recorded", () => {
    const s = summarizeUsage(src([], null), { now: NOW });
    expect(allDays(s).every(c => c.level === null)).toBe(true);
    expect(s.details.recordedDays).toBe(0);
  });

  it("judges 'recording began' by the viewer's date, not UTC's", () => {
    const since = Date.parse("2026-10-10T16:00:00Z"); // already the 11th in Seoul
    const s = summarizeUsage(src(used, since), { now: NOW, tz: "Asia/Seoul" });
    expect(dayCell(s, "2026-10-10").level).toBeNull();
    expect(dayCell(s, "2026-10-11").level).toBe(0);
  });
});

describe("heat levels", () => {
  const dayTotals = (totals: number[]) => totals.map((n, i) => bucket(`2026-10-${String(10 + i).padStart(2, "0")}T10:00:00Z`, { input: n }));
  const levels = (totals: number[]) => {
    const s = summarizeUsage(src(dayTotals(totals)), { now: NOW });
    return totals.map((_, i) => dayCell(s, `2026-10-${String(10 + i).padStart(2, "0")}`).level);
  };

  it("splits used days into quartiles", () => {
    expect(levels([10, 20, 30, 40])).toEqual([1, 2, 3, 4]);
  });

  it("is not flattened by one enormous day", () => {
    expect(levels([1, 1, 1, 1000])).toEqual([1, 1, 1, 4]);
  });

  it("gives a lone used day the first level, and idle days 0", () => {
    expect(levels([7])).toEqual([1]);
    const s = summarizeUsage(src(dayTotals([7])), { now: NOW });
    expect(dayCell(s, "2026-10-11").level).toBe(0);
  });

  it("gives equal days the same level", () => {
    expect(new Set(levels([5, 5, 5, 5])).size).toBe(1);
  });
});

describe("models", () => {
  const rows = [
    bucket("2026-10-16T10:00:00Z", { model: "big", input: 700, requests: 7 }),
    bucket("2026-10-16T10:00:00Z", { model: "mid", input: 200, requests: 2 }),
    bucket("2026-10-16T10:00:00Z", { model: "small", input: 60, requests: 1 }),
    bucket("2026-10-16T10:00:00Z", { model: "tiny", input: 40, requests: 1 }),
  ];

  it("ranks by tokens with a share of the whole, and rolls the rest into others", () => {
    const m = summarizeUsage(src(rows), { now: NOW, modelLimit: 2 }).models;
    expect(m.rows.map(r => [r.model, r.total, r.share])).toEqual([["big", 700, 0.7], ["mid", 200, 0.2]]);
    expect(m.others).toEqual({ count: 2, total: 100, share: 0.1 });
    expect(m.windowDays).toBe(30);
  });

  it("has no others when everything fits", () => {
    expect(summarizeUsage(src(rows), { now: NOW }).models.others).toBeNull();
  });

  it("keeps the same model name from two providers as two rows", () => {
    const m = summarizeUsage(src([
      bucket("2026-10-16T10:00:00Z", { model: "x", input: 2 }),
      bucket("2026-10-16T10:00:00Z", { provider: "openai", model: "x", input: 1 }),
    ]), { now: NOW }).models;
    expect(m.rows.map(r => [r.provider, r.model])).toEqual([["anthropic", "x"], ["openai", "x"]]);
  });

  it("orders ties by name so the list does not shuffle between refreshes", () => {
    const m = summarizeUsage(src([bucket("2026-10-16T10:00:00Z", { model: "b", input: 1 }), bucket("2026-10-16T10:00:00Z", { model: "a", input: 1 })]), { now: NOW }).models;
    expect(m.rows.map(r => r.model)).toEqual(["a", "b"]);
  });

  it("only looks at the rolling 30 days", () => {
    const m = summarizeUsage(src([bucket("2026-09-01T10:00:00Z", { model: "old", input: 5 })]), { now: NOW }).models;
    expect(m.rows).toEqual([]);
  });
});

describe("details", () => {
  it("computes the cache hit ratio from Anthropic rows only", () => {
    const anthropic = bucket("2026-10-16T10:00:00Z", { input: 100, cacheRead: 800, cacheCreation: 100 });
    const openai = bucket("2026-10-16T10:00:00Z", { provider: "openai", model: "gpt", input: 50_000, output: 10 });
    expect(summarizeUsage(src([anthropic]), { now: NOW }).details.cacheHitRatio).toBeCloseTo(0.8);
    expect(summarizeUsage(src([anthropic, openai]), { now: NOW }).details.cacheHitRatio).toBeCloseTo(0.8);
  });

  it("has no ratio when there is nothing to divide by, instead of a made-up 0%", () => {
    expect(summarizeUsage(src([]), { now: NOW }).details.cacheHitRatio).toBeNull();
    const onlyOpenAI = bucket("2026-10-16T10:00:00Z", { provider: "openai", model: "g", input: 9 });
    expect(summarizeUsage(src([onlyOpenAI]), { now: NOW }).details.cacheHitRatio).toBeNull();
  });

  it("averages tokens per request, and has no average without requests", () => {
    const d = summarizeUsage(src([bucket("2026-10-16T10:00:00Z", { input: 90, output: 10, requests: 4 })]), { now: NOW }).details;
    expect(d.avgTokensPerRequest).toBe(25);
    expect(summarizeUsage(src([bucket("2026-10-16T10:00:00Z", { input: 9 })]), { now: NOW }).details.avgTokensPerRequest).toBeNull();
  });

  it("finds the busiest day and counts active ones", () => {
    const d = summarizeUsage(src([
      bucket("2026-10-10T10:00:00Z", { input: 5 }),
      bucket("2026-10-12T10:00:00Z", { input: 50 }),
      bucket("2026-10-12T11:00:00Z", { input: 50 }),
    ]), { now: NOW }).details;
    expect(d.busiest).toEqual({ date: "2026-10-12", total: 100 });
    expect(d.activeDays).toBe(2);
  });

  it("has no busiest day on an empty history", () => {
    expect(summarizeUsage(src([]), { now: NOW }).details.busiest).toBeNull();
  });
});

describe("an empty history", () => {
  it("is a coherent summary, not an error", () => {
    const s = summarizeUsage(src([], null), { now: NOW });
    expect(s.since).toBeNull();
    expect(s.windows["30d"]).toMatchObject({ total: 0, requests: 0, partial: true });
    expect(s.models).toMatchObject({ rows: [], others: null });
    expect(allDays(s)).toHaveLength(DISPLAY_DAYS);
  });
});

describe("createUsageSummaryProvider", () => {
  function counted(buckets: UsageBucket[] = []) {
    let calls = 0;
    const source: UsageSource = { buckets: () => { calls++; return buckets; }, since: EARLY };
    return { source, calls: () => calls };
  }

  it("serves the same answer inside the window without recomputing", () => {
    const { source, calls } = counted();
    const clock = { t: NOW };
    const get = createUsageSummaryProvider(source, { ttlMs: 10_000, now: () => clock.t });
    const a = get("Asia/Seoul");
    clock.t += 9_999;
    expect(get("Asia/Seoul")).toBe(a);
    expect(calls()).toBe(1);
    clock.t += 2;
    expect(get("Asia/Seoul")).not.toBe(a);
    expect(calls()).toBe(2);
  });

  it("keeps zones apart, and treats an unusable zone as its own flagged UTC answer", () => {
    const get = createUsageSummaryProvider(counted().source, { now: () => NOW });
    expect(get("Asia/Seoul").tz).toBe("Asia/Seoul");
    expect(get("Nope/Nope")).toMatchObject({ tz: "UTC", tzFallback: true });
    expect(get(undefined)).toMatchObject({ tz: "UTC", tzFallback: false });
  });

  it("caps how many zones it remembers, so the zone name cannot grow it", () => {
    const { source, calls } = counted();
    const get = createUsageSummaryProvider(source, { maxKeys: 3, now: () => NOW });
    for (const z of ["Asia/Seoul", "Asia/Tokyo", "Europe/Paris", "America/Chicago"]) get(z);
    expect(calls()).toBe(4);
    get("Asia/Seoul"); // evicted by the fourth
    expect(calls()).toBe(5);
    get("America/Chicago"); // still held
    expect(calls()).toBe(5);
  });

  it("returns the canonical zone name for an alias", () => {
    const get = createUsageSummaryProvider(counted().source, { now: () => NOW });
    expect(get("Asia/Calcutta").tz).toBe(resolveTimeZone("Asia/Calcutta").tz);
  });
});
