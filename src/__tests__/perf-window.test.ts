import { describe, expect, it } from "vitest";
import { PerfWindow, PERF_WINDOW_MS } from "../proxy/perf-window.js";
import type { LogEntry } from "../proxy/stats.js";

const T0 = Date.parse("2026-10-26T12:00:00Z");

function req(over: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: T0, accountId: "lyra", model: "claude-opus-5-5", type: "route",
    method: "POST", path: "/messages", statusCode: 200, durationMs: 900, totalMs: 10_000, outputTokens: 500,
    ...over,
  };
}

describe("PerfWindow", () => {
  it("says nothing rather than zero before any request", () => {
    const w = new PerfWindow(PERF_WINDOW_MS, T0);
    const s = w.snapshot(T0 + 1000);
    expect(s.pool).toMatchObject({ requests: 0, errors: 0, errorRate: null, p50Ms: null, p95Ms: null, outputTokensPerSecond: null });
    expect(s.observedMs).toBe(1000);
  });

  it("keeps notices out: only request entries count", () => {
    const w = new PerfWindow(PERF_WINDOW_MS, T0);
    w.record({ ts: T0, accountId: "lyra", model: "-", type: "route", details: "repin" });
    w.record({ ts: T0, accountId: "lyra", model: "-", type: "refresh" });
    w.record(req());
    expect(w.snapshot(T0).pool.requests).toBe(1);
  });

  it("counts 4xx/5xx and mid-stream failures as errors, 429 apart, and a client hang-up as neither", () => {
    const w = new PerfWindow(PERF_WINDOW_MS, T0);
    w.record(req());
    w.record(req({ statusCode: 429, type: "error", totalMs: undefined }));
    w.record(req({ statusCode: 500, type: "error" }));
    w.record(req({ statusCode: 200, type: "error" })); // failed after the first byte
    // The routes log an abandoned response with how long it ran, as here.
    w.record(req({ statusCode: 200, clientClosed: true, totalMs: 1200 }));
    const p = w.snapshot(T0).pool;
    expect(p.requests).toBe(5);
    expect(p.errors).toBe(3);
    expect(p.rateLimited).toBe(1);
    expect(p.errorRate).toBeCloseTo(3 / 5);
    // Neither the failures nor the abandoned response are timed.
    expect(p.completed).toBe(1);
  });

  it("times completions by the finish, not by the first byte", () => {
    const w = new PerfWindow(PERF_WINDOW_MS, T0);
    for (let i = 1; i <= 20; i++) w.record(req({ durationMs: 500, totalMs: i * 1000 }));
    const p = w.snapshot(T0).pool;
    expect(p.p50Ms).toBe(10_000);
    expect(p.p95Ms).toBe(19_000);
  });

  it("reads output and the finish when the snapshot is taken, since a stream fills them in late", () => {
    const w = new PerfWindow(PERF_WINDOW_MS, T0);
    const e = req({ totalMs: undefined, outputTokens: undefined });
    w.record(e);
    expect(w.snapshot(T0).pool.completed).toBe(0);
    e.totalMs = 4000;
    e.outputTokens = 400;
    const p = w.snapshot(T0).pool;
    expect(p.completed).toBe(1);
    expect(p.outputTokensPerSecond).toBe(100);
  });

  it("splits by account and by model", () => {
    const w = new PerfWindow(PERF_WINDOW_MS, T0);
    w.record(req({ accountId: "lyra" }));
    w.record(req({ accountId: "vega", model: "claude-sonnet-5-5", statusCode: 529, type: "error" }));
    const s = w.snapshot(T0);
    expect(Object.keys(s.accounts).sort()).toEqual(["lyra", "vega"]);
    expect(s.accounts["vega"].errors).toBe(1);
    expect(s.models["claude-sonnet-5-5"].requests).toBe(1);
  });

  it("forgets what is older than the window", () => {
    const w = new PerfWindow(PERF_WINDOW_MS, T0);
    w.record(req({ ts: T0 }));
    w.record(req({ ts: T0 + 30 * 60_000 }));
    expect(w.snapshot(T0 + PERF_WINDOW_MS + 1).pool.requests).toBe(1);
    expect(w.snapshot(T0 + 2 * PERF_WINDOW_MS).observedMs).toBe(PERF_WINDOW_MS);
  });
});
