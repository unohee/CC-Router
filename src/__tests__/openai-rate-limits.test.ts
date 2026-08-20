import { describe, expect, it } from "vitest";
import { extractCodexRateLimits } from "../providers/openai/rate-limits.js";

/** Captured verbatim from a Codex response, 2026-08-20. */
const LIVE_HEADERS: Record<string, string> = {
  "x-codex-plan-type": "pro",
  "x-codex-active-limit": "premium",
  "x-codex-primary-used-percent": "1",
  "x-codex-primary-window-minutes": "10080",
  "x-codex-primary-reset-after-seconds": "594064",
  "x-codex-primary-reset-at": "1787804441",
  "x-codex-secondary-used-percent": "0",
  "x-codex-secondary-window-minutes": "0",
  "x-codex-secondary-reset-at": "",
  "x-codex-bengalfox-primary-used-percent": "0",
  "x-codex-bengalfox-primary-window-minutes": "300",
  "x-codex-bengalfox-primary-reset-after-seconds": "18000",
  "x-codex-bengalfox-secondary-used-percent": "0",
  "x-codex-bengalfox-secondary-window-minutes": "10080",
};

const lookup = (h: Record<string, string>) => (name: string) => h[name] ?? "";

describe("extractCodexRateLimits", () => {
  it("assigns windows by their reported size, not by series position", () => {
    const limits = extractCodexRateLimits(lookup(LIVE_HEADERS))!;

    // The 5-hour reading comes from the bengalfox series (300 min); the plain
    // series' *primary* is a 7-day window despite the same header position.
    expect(limits.fiveHourUtil).toBe(0);
    expect(limits.sevenDayUtil).toBeCloseTo(0.01);
    expect(limits.status).toBe("allowed");
    expect(limits.plan).toBe("pro");
    expect(limits.claim).toBe("seven_day");
  });

  it("prefers the absolute reset timestamp and derives one when only a delta is sent", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const limits = extractCodexRateLimits(lookup(LIVE_HEADERS))!;

    expect(limits.sevenDayReset).toBe(1787804441);           // reset-at wins
    expect(limits.fiveHourReset).toBeGreaterThanOrEqual(nowSec + 18000 - 2);
    expect(limits.fiveHourReset).toBeLessThanOrEqual(nowSec + 18000 + 2);
  });

  it("keeps the binding reading when two series report the same window", () => {
    const limits = extractCodexRateLimits(lookup({
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-used-percent": "12",
      "x-codex-bengalfox-primary-window-minutes": "300",
      "x-codex-bengalfox-primary-used-percent": "84",
    }))!;

    expect(limits.fiveHourUtil).toBeCloseTo(0.84);
  });

  it("reports exhaustion once a window reaches its cap", () => {
    const limits = extractCodexRateLimits(lookup({
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-used-percent": "100",
    }))!;

    expect(limits.status).toBe("rate_limited");
  });

  it("ignores slots the series does not use", () => {
    // secondary-window-minutes = 0 means "no such window", not "a zero-length one".
    const limits = extractCodexRateLimits(lookup({
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-used-percent": "5",
      "x-codex-secondary-window-minutes": "0",
      "x-codex-secondary-used-percent": "99",
    }))!;

    expect(limits.fiveHourUtil).toBeCloseTo(0.05);
    expect(limits.sevenDayUtil).toBe(0);
  });

  it("returns null when a response carries no quota headers at all", () => {
    expect(extractCodexRateLimits(() => "")).toBeNull();
    // Plan alone is not a quota reading.
    expect(extractCodexRateLimits(lookup({ "x-codex-plan-type": "pro" }))).toBeNull();
  });
});
