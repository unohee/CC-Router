import { describe, it, expect } from "vitest";
import {
  parseRetryAfterSeconds, isBare429, bare429CooldownSeconds, resetBare429Streak,
  BARE_429_BASE_SECONDS, BARE_429_MAX_SECONDS, BARE_429_STREAK_WINDOW_MS,
} from "../proxy/model-cooldown.js";
import { format429Diagnostic } from "../proxy/logger.js";
import type { Account } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";

function makeAccount(): Account {
  return {
    id: "kyte",
    tokens: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, scopes: [] },
    healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0,
    consecutiveErrors: 0, rateLimits: { ...DEFAULT_RATE_LIMITS },
    enabled: true, sessionLimitPercent: 100, weeklyLimitPercent: 100,
  };
}

/** A bare 429 that lands after the previous cooldown has already ended. */
function refusedAgainAfterRelease(a: Account, now: number): number {
  const seconds = bare429CooldownSeconds(a, now);
  a.coolingUntil = now + seconds * 1000;
  return seconds;
}

describe("parseRetryAfterSeconds", () => {
  it("returns null whenever upstream stated no usable wait", () => {
    for (const raw of [undefined, "", "   ", "abc", "0", "-5"]) {
      expect(parseRetryAfterSeconds(raw)).toBeNull();
    }
  });

  it("rounds a stated wait up, and reads an HTTP date", () => {
    expect(parseRetryAfterSeconds("30")).toBe(30);
    expect(parseRetryAfterSeconds("30.2")).toBe(31);
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(parseRetryAfterSeconds("Thu, 15 Oct 2026 12:01:30 GMT", now)).toBe(90);
    expect(parseRetryAfterSeconds("Thu, 15 Oct 2026 11:00:00 GMT", now)).toBeNull();
  });
});

describe("isBare429", () => {
  const allowed = { status: "allowed", claim: "" };

  it("treats a refusal with no stated reason as bare, with or without unified headers", () => {
    expect(isBare429(null, allowed, "claude-sonnet-4-6")).toBe(true);
    expect(isBare429(null, null, "claude-sonnet-4-6")).toBe(true);
  });

  it("does not call a refusal bare when upstream stated how long to wait", () => {
    expect(isBare429(30, allowed, "claude-sonnet-4-6")).toBe(false);
  });

  it("does not call a refusal bare when a limiting window is named, even without Retry-After", () => {
    expect(isBare429(null, { status: "allowed", claim: "five_hour" }, "claude-sonnet-4-6")).toBe(false);
    expect(isBare429(null, { status: "allowed", claim: "seven_day" }, "claude-sonnet-4-6")).toBe(false);
  });

  it("does not call a refusal bare when the account itself reports rate_limited", () => {
    expect(isBare429(null, { status: "rate_limited", claim: "" }, "claude-sonnet-4-6")).toBe(false);
  });

  it("does not call a model-scoped claim bare", () => {
    expect(isBare429(null, { status: "allowed", claim: "seven_day_opus" }, "claude-opus-5-5")).toBe(false);
  });
});

describe("bare429CooldownSeconds", () => {
  it("climbs 8, 16, 32, then holds at the 60s ceiling", () => {
    const a = makeAccount();
    let now = 1_000_000;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(refusedAgainAfterRelease(a, now));
      now = a.coolingUntil! + 1_000; // released, then refused again
    }
    expect(seen).toEqual([8, 16, 32, 60, 60, 60]);
    expect(BARE_429_BASE_SECONDS).toBe(8);
    expect(BARE_429_MAX_SECONDS).toBe(60);
  });

  it("does not climb for a sibling that meets the same refusal while the account is cooling", () => {
    const a = makeAccount();
    const now = 1_000_000;
    expect(refusedAgainAfterRelease(a, now)).toBe(8);
    // Three more in-flight requests answered inside the cooldown the first one set.
    expect(bare429CooldownSeconds(a, now + 5)).toBe(8);
    expect(bare429CooldownSeconds(a, now + 10)).toBe(8);
    expect(bare429CooldownSeconds(a, now + 15)).toBe(8);
    expect(a.bare429Streak).toBe(1);
  });

  it("starts over once the last bare 429 is older than the streak window", () => {
    const a = makeAccount();
    let now = 1_000_000;
    refusedAgainAfterRelease(a, now);
    now = a.coolingUntil! + 1_000;
    expect(refusedAgainAfterRelease(a, now)).toBe(16);
    now = a.coolingUntil! + BARE_429_STREAK_WINDOW_MS + 1;
    expect(refusedAgainAfterRelease(a, now)).toBe(8);
  });

  it("starts over after a served request", () => {
    const a = makeAccount();
    let now = 1_000_000;
    refusedAgainAfterRelease(a, now);
    now = a.coolingUntil! + 1_000;
    expect(refusedAgainAfterRelease(a, now)).toBe(16);
    resetBare429Streak(a);
    now = a.coolingUntil! + 1_000;
    expect(refusedAgainAfterRelease(a, now)).toBe(8);
  });

  it("counts a first bare 429 that arrives during an unrelated cooldown", () => {
    const a = makeAccount();
    const now = 1_000_000;
    a.coolingUntil = now + 30_000; // e.g. a 529 cooldown
    expect(bare429CooldownSeconds(a, now + 1)).toBe(8);
    expect(a.bare429Streak).toBe(1);
  });

  it("keeps each account's streak to itself", () => {
    const a = makeAccount();
    const b = makeAccount();
    let now = 1_000_000;
    refusedAgainAfterRelease(a, now);
    now = a.coolingUntil! + 1_000;
    expect(refusedAgainAfterRelease(a, now)).toBe(16);
    expect(refusedAgainAfterRelease(b, now)).toBe(8);
  });
});

describe("format429Diagnostic", () => {
  const base = {
    accountId: "kyte", bare: true, cooldownSeconds: 8, streak: 1, retryAfter: undefined,
    limitStatus: "allowed", claim: "", userAgent: "claude-cli/2.1.0 (external, cli)",
    sessionId: "0123456789abcdef", model: "claude-opus-5-5",
  };

  it("names the client, the raw Retry-After, and where the refusal sits in the schedule", () => {
    expect(format429Diagnostic(base)).toBe(
      '429 bare#1 cooldown=8s retry-after=absent limit=allowed claim=none '
      + 'model=claude-opus-5-5 session=01234567 ua="claude-cli/2.1.0 (external, cli)"',
    );
  });

  it("marks a refusal upstream explained as stated and keeps the header it sent", () => {
    const line = format429Diagnostic({
      ...base, bare: false, streak: 0, cooldownSeconds: 3600, retryAfter: "3600", limitStatus: "rate_limited", claim: "five_hour",
    });
    expect(line).toContain("429 stated cooldown=3600s retry-after=\"3600\" limit=rate_limited claim=five_hour");
  });

  it("says so when the client sent no user-agent or session", () => {
    const line = format429Diagnostic({ ...base, userAgent: undefined, sessionId: undefined, model: undefined });
    expect(line).toContain("model=- session=none ua=none");
  });

  it("keeps a hostile user-agent to one printable, bounded token", () => {
    const line = format429Diagnostic({ ...base, userAgent: "evil\n[12:00:00] [ERROR] forged\u0007" + "x".repeat(500) });
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u0007");
    expect(line.length).toBeLessThan(400);
  });
});
