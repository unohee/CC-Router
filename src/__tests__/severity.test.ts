import { describe, expect, it } from "vitest";
import {
  BURST_COUNT,
  BURST_WINDOW_MS,
  PROBLEM_AT,
  WATCH_AT,
  computeSeverity,
  countRecent429s,
  describeSeverity,
  formatRemaining,
  severityOfUtil,
  windowReading,
} from "../proxy/severity.js";
import type { SeverityAccountInput } from "../proxy/severity.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

/** A window with a real reading: measured, a figure, and a reset still ahead. */
const limits = (five: number, seven = 0.1, over: Record<string, unknown> = {}) => ({
  status: "allowed",
  fiveHourUtil: five,
  fiveHourReset: Math.floor((NOW + 2 * 60 * MIN) / 1000),
  sevenDayUtil: seven,
  sevenDayReset: Math.floor((NOW + 3 * 24 * 60 * MIN) / 1000),
  lastUpdated: NOW - 1000,
  ...over,
});

const acct = (id: string, over: Partial<SeverityAccountInput> = {}): SeverityAccountInput => ({
  id, enabled: true, healthy: true, expiresInMs: 3_600_000, rateLimits: limits(0.2), ...over,
});

const err429 = (agoMs: number) => ({ ts: NOW - agoMs, type: "error", statusCode: 429 });

describe("account rungs", () => {
  it("calls a quiet, measured account ok", () => {
    const s = computeSeverity([acct("lyra")], [], NOW);
    expect(s.accounts[0]).toEqual({ id: "lyra", rung: "ok", state: "ok" });
    expect(s.pool).toBe("ok");
    expect(s.reasons).toEqual([]);
  });

  it("does not treat an account the operator switched off as a problem", () => {
    const s = computeSeverity([acct("a"), acct("b", { enabled: false, healthy: false })], [], NOW);
    expect(s.accounts[1]).toMatchObject({ rung: "off", state: "off" });
    expect(s.pool).toBe("ok");
  });

  it("puts off ahead of every other state, so a disabled account never reads as broken", () => {
    const s = computeSeverity([acct("a", {
      enabled: false, healthy: false, expiresInMs: -1, coolingUntil: NOW + MIN,
      rateLimits: limits(0.99, 0.99, { status: "rate_limited" }),
    }), acct("b")], [], NOW);
    expect(s.accounts[0].state).toBe("off");
  });

  it("flags an expired token", () => {
    const s = computeSeverity([acct("a", { expiresInMs: 0 })], [], NOW);
    expect(s.accounts[0]).toMatchObject({ rung: "problem", state: "expired" });
    expect(s.reasons).toEqual(["a token expired"]);
  });

  it("does not guess when the expiry is missing", () => {
    const s = computeSeverity([acct("a", { expiresInMs: undefined })], [], NOW);
    expect(s.accounts[0].state).toBe("ok");
  });

  it("is a problem while the whole account is cooling, with the time left", () => {
    const s = computeSeverity([acct("rigel", { coolingUntil: NOW + 4 * MIN })], [], NOW);
    expect(s.accounts[0]).toMatchObject({ rung: "problem", state: "cooling", until: NOW + 4 * MIN, scope: "" });
    expect(s.reasons).toEqual(["rigel cooling 4m"]);
  });

  it("is a problem while one model family is cooling, and names it", () => {
    const s = computeSeverity([acct("rigel", { modelCooldowns: { opus: NOW + 10 * MIN, sonnet: NOW + 2 * MIN } })], [], NOW);
    expect(s.accounts[0]).toMatchObject({ rung: "problem", state: "cooling", scope: "opus, sonnet", until: NOW + 10 * MIN });
    expect(s.reasons).toEqual(["rigel opus, sonnet cooling 10m"]);
  });

  it("ignores a cooldown that has already ended", () => {
    const s = computeSeverity([acct("a", { coolingUntil: NOW - 1, modelCooldowns: { opus: NOW - 1000 } })], [], NOW);
    expect(s.accounts[0].state).toBe("ok");
  });

  it("is a problem when the upstream says rate_limited, or the account is unhealthy", () => {
    const limited = computeSeverity([acct("a", { rateLimits: limits(0.5, 0.5, { status: "rate_limited" }) })], [], NOW);
    expect(limited.accounts[0]).toMatchObject({ rung: "problem", state: "limited" });
    const sick = computeSeverity([acct("b", { healthy: false })], [], NOW);
    expect(sick.accounts[0]).toMatchObject({ rung: "problem", state: "unhealthy" });
  });

  it("puts cooling ahead of rate_limited and rate_limited ahead of unhealthy", () => {
    const both = acct("a", { coolingUntil: NOW + MIN, healthy: false, rateLimits: limits(0.5, 0.5, { status: "rate_limited" }) });
    expect(computeSeverity([both], [], NOW).accounts[0].state).toBe("cooling");
    const lim = acct("b", { healthy: false, rateLimits: limits(0.5, 0.5, { status: "rate_limited" }) });
    expect(computeSeverity([lim], [], NOW).accounts[0].state).toBe("limited");
  });
});

describe("quota thresholds", () => {
  it("uses 80 % to watch and 95 % for a problem, inclusive of the boundary", () => {
    expect([WATCH_AT, PROBLEM_AT]).toEqual([0.8, 0.95]);
    expect(severityOfUtil(0.799)).toBe("ok");
    expect(severityOfUtil(0.8)).toBe("watch");
    expect(severityOfUtil(0.949)).toBe("watch");
    expect(severityOfUtil(0.95)).toBe("problem");
    expect(severityOfUtil(1.2)).toBe("problem");
  });

  it("reads the hotter of the two windows, and says which", () => {
    const hot = computeSeverity([acct("a", { rateLimits: limits(0.3, 0.84) })], [], NOW).accounts[0];
    expect(hot).toMatchObject({ rung: "watch", state: "hot", window: "7d", util: 0.84 });
    const near = computeSeverity([acct("b", { rateLimits: limits(0.96, 0.1) })], [], NOW).accounts[0];
    expect(near).toMatchObject({ rung: "problem", state: "near", window: "5h" });
  });

  it("words the reasons by how full the window is", () => {
    expect(computeSeverity([acct("a", { rateLimits: limits(0.84) })], [], NOW).reasons).toEqual(["a 5h 84%"]);
    expect(computeSeverity([acct("a", { rateLimits: limits(0.96) })], [], NOW).reasons).toEqual(["a 5h 96%"]);
    expect(computeSeverity([acct("a", { rateLimits: limits(1) })], [], NOW).reasons).toEqual(["a 5h at limit"]);
  });

  it("never thresholds a figure that is not a reading", () => {
    // Never measured: the figure is stale or invented, whatever it says.
    expect(computeSeverity([acct("a", { rateLimits: limits(0.99, 0.99, { lastUpdated: 0 }) })], [], NOW).accounts[0].state).toBe("ok");
    // The window already reset after the last response.
    const past = limits(0.99, 0.1, { fiveHourReset: Math.floor((NOW - MIN) / 1000) });
    expect(computeSeverity([acct("b", { rateLimits: past })], [], NOW).accounts[0].state).toBe("ok");
    // No figure and no reset time: reported nothing, which is not zero use and not a hot window.
    const none = limits(0, 0, { fiveHourReset: 0, sevenDayReset: 0 });
    expect(computeSeverity([acct("c", { rateLimits: none })], [], NOW).accounts[0].state).toBe("ok");
    expect(computeSeverity([acct("d", { rateLimits: undefined })], [], NOW).accounts[0].state).toBe("ok");
  });

  it("still counts a hot window whose reset time is merely unknown", () => {
    const s = computeSeverity([acct("a", { rateLimits: limits(0.9, 0, { fiveHourReset: 0, sevenDayReset: 0 }) })], [], NOW);
    expect(s.accounts[0]).toMatchObject({ rung: "watch", state: "hot", window: "5h" });
  });

  it("explains why a window has no reading", () => {
    expect(windowReading(undefined, "fiveHour", NOW)).toEqual({ ok: false, note: "not measured yet" });
    expect(windowReading(limits(0, 0, { fiveHourReset: 0 }), "fiveHour", NOW)).toEqual({ ok: false, note: "no reading" });
    expect(windowReading(limits(0.5, 0, { fiveHourReset: Math.floor((NOW - 1000) / 1000) }), "fiveHour", NOW))
      .toEqual({ ok: false, note: "reset since last reading" });
    expect(windowReading(limits(0.5), "fiveHour", NOW)).toMatchObject({ ok: true, util: 0.5 });
  });
});

describe("429 bursts", () => {
  it("counts only upstream rejections inside the window", () => {
    const logs = [
      err429(10_000), err429(2 * MIN), err429(BURST_WINDOW_MS - 1),
      err429(BURST_WINDOW_MS + 1),                              // too old
      { ts: NOW - 1000, type: "route", statusCode: 429 },       // a hold the router chose, not a rejection
      { ts: NOW - 1000, type: "error", statusCode: 500 },       // a different failure
      { ts: NOW + MIN, type: "error", statusCode: 429 },        // from the future: a clock skew, not news
    ];
    expect(countRecent429s(logs, NOW)).toBe(3);
  });

  it("is a problem at the third, and not before, even when every account looks fine", () => {
    const two = computeSeverity([acct("a")], [err429(1000), err429(2000)], NOW);
    expect(two.pool).toBe("ok");
    expect(two.recent429s).toBe(2);
    const three = computeSeverity([acct("a")], [err429(1000), err429(2000), err429(3000)], NOW);
    expect(BURST_COUNT).toBe(3);
    expect(three.pool).toBe("problem");
    expect(three.reasons).toEqual(["429 ×3 in 5m"]);
  });
});

describe("the pool", () => {
  it("is watch when the worst thing is a hot window, problem when anything is", () => {
    const watch = computeSeverity([acct("a"), acct("b", { rateLimits: limits(0.85) })], [], NOW);
    expect(watch.pool).toBe("watch");
    const problem = computeSeverity([acct("a", { healthy: false }), acct("b", { rateLimits: limits(0.85) })], [], NOW);
    expect(problem.pool).toBe("problem");
  });

  it("lists problems first, then the 429 burst, then watches", () => {
    const s = computeSeverity(
      [acct("hot", { rateLimits: limits(0.85) }), acct("down", { healthy: false }), acct("cool", { coolingUntil: NOW + 2 * MIN })],
      [err429(1), err429(2), err429(3), err429(4)],
      NOW,
    );
    expect(s.reasons).toEqual(["down unhealthy", "cool cooling 2m", "429 ×4 in 5m", "hot 5h 85%"]);
  });

  it("is a problem with no accounts at all, and when every account is off", () => {
    expect(computeSeverity([], [], NOW)).toMatchObject({ pool: "problem", reasons: ["no accounts configured"] });
    expect(computeSeverity([acct("a", { enabled: false })], [], NOW))
      .toMatchObject({ pool: "problem", reasons: ["every account is off"] });
  });

  it("echoes its thresholds so a client colours with the same cut-offs", () => {
    expect(computeSeverity([acct("a")], [], NOW).thresholds).toEqual({ watch: 0.8, problem: 0.95 });
  });

  it("does not let one account's id become a property of the result", () => {
    const s = computeSeverity([acct("__proto__"), acct("constructor")], [], NOW);
    expect(Array.isArray(s.accounts)).toBe(true);
    expect(s.accounts.map(a => a.id)).toEqual(["__proto__", "constructor"]);
  });
});

describe("describeSeverity", () => {
  it("is quiet when healthy, and counts only accounts that are serving", () => {
    expect(describeSeverity(computeSeverity([acct("a"), acct("b")], [], NOW))).toBe("All 2 accounts healthy");
    expect(describeSeverity(computeSeverity([acct("a")], [], NOW))).toBe("All 1 account healthy");
    expect(describeSeverity(computeSeverity([acct("a"), acct("b", { enabled: false })], [], NOW)))
      .toBe("All 1 account healthy · 1 off");
  });

  it("leads with the verdict and then the reasons", () => {
    expect(describeSeverity(computeSeverity([acct("rigel", { coolingUntil: NOW + 4 * MIN }), acct("lyra", { rateLimits: limits(0.96) })], [], NOW)))
      .toBe("Problem — rigel cooling 4m · lyra 5h 96%");
    expect(describeSeverity(computeSeverity([acct("lyra", { rateLimits: limits(0.84) })], [], NOW)))
      .toBe("Watch — lyra 5h 84%");
  });
});

describe("formatRemaining", () => {
  it("reads like a deadline, down to seconds", () => {
    expect(formatRemaining(45_000)).toBe("45s");
    expect(formatRemaining(4 * MIN)).toBe("4m");
    expect(formatRemaining(156 * MIN)).toBe("2h36m");
    expect(formatRemaining(27 * 60 * MIN)).toBe("1d3h");
    expect(formatRemaining(-5)).toBe("0s");
  });
});
