import { afterEach, describe, expect, it, vi } from "vitest";
import { codexUsageIsStale, parseCodexUsage, probeCodexUsage, startCodexUsageLoop } from "../providers/openai/usage-probe.js";
import { canServeOpenAI } from "../providers/openai/account-pool.js";
import { createHealthAccountViews } from "../proxy/server.js";
import { computeSeverity } from "../proxy/severity.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

/** The `rate_limit` part of a live wham/usage body, 2026-10-29 (Pro plan, weekly window only). */
const LIVE_BODY = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 25, limit_window_seconds: 604800, reset_after_seconds: 516468, reset_at: 1793774343 },
    secondary_window: null,
  },
};

function staleExhaustedAccount(): OpenAISubscriptionAccount {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: "codex-fallback",
    provider: "openai_subscription",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    enabled: true,
    // What the router held: the weekly window at 100%, four days still on its
    // reset clock, read 28 hours ago — after which OpenAI reset it early.
    rateLimits: {
      status: "rate_limited",
      fiveHourUtil: 0, fiveHourReset: 0,
      sevenDayUtil: 1, sevenDayReset: nowSec + 342_000,
      claim: "seven_day", plan: "pro", requestsLimit: 0,
      lastUpdated: Date.now() - 28 * 3_600_000,
    },
  };
}

const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => { vi.useRealTimers(); });

describe("parseCodexUsage", () => {
  it("reads a weekly-only window from the live body", () => {
    const limits = parseCodexUsage(LIVE_BODY)!;
    expect(limits.status).toBe("allowed");
    expect(limits.sevenDayUtil).toBeCloseTo(0.25);
    expect(limits.sevenDayReset).toBe(1793774343);
    expect(limits.fiveHourUtil).toBe(0);
    expect(limits.fiveHourReset).toBe(0);
    expect(limits.claim).toBe("seven_day");
    expect(limits.plan).toBe("pro");
  });

  it("assigns a five-hour window by size and derives its reset from the delta", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const limits = parseCodexUsage({
      plan_type: "plus",
      rate_limit: {
        allowed: true, limit_reached: false,
        primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_after_seconds: 600 },
        secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: nowSec + 86400 },
      },
    })!;
    expect(limits.fiveHourUtil).toBeCloseTo(0.4);
    expect(Math.abs(limits.fiveHourReset - (nowSec + 600))).toBeLessThanOrEqual(2);
    expect(limits.sevenDayUtil).toBeCloseTo(0.1);
    expect(limits.claim).toBe("five_hour");
  });

  it("trusts the upstream verdict when it says the limit is reached below 100%", () => {
    const limits = parseCodexUsage({
      ...LIVE_BODY,
      rate_limit: { ...LIVE_BODY.rate_limit, allowed: false, limit_reached: true },
    })!;
    expect(limits.status).toBe("rate_limited");
  });

  it("returns null for a body without quota", () => {
    expect(parseCodexUsage({ plan_type: "pro" })).toBeNull();
    expect(parseCodexUsage(null)).toBeNull();
    expect(parseCodexUsage({ rate_limit: { allowed: true, primary_window: null, secondary_window: null } })).toBeNull();
  });
});

describe("probeCodexUsage", () => {
  it("clears a stale exhausted reading so the dashboard and picker see the reset", async () => {
    const account = staleExhaustedAccount();
    expect(canServeOpenAI(account)).toBe(false);
    expect(computeSeverity(createHealthAccountViews([], [account]), [], Date.now()).accounts[0].state).toBe("limited");

    const fetchImpl = vi.fn(async () => okResponse(LIVE_BODY));
    expect(await probeCodexUsage(account, fetchImpl as unknown as typeof fetch)).toBe(true);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer access");
    expect(account.rateLimits?.status).toBe("allowed");
    expect(account.rateLimits?.sevenDayUtil).toBeCloseTo(0.25);
    expect(canServeOpenAI(account)).toBe(true);

    const view = createHealthAccountViews([], [account])[0];
    expect(view.healthy).toBe(true);
    expect(computeSeverity([view], [], Date.now()).accounts[0].state).not.toBe("limited");
  });

  it("keeps the old reading when the probe fails", async () => {
    for (const fetchImpl of [
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
      vi.fn(async () => { throw new Error("ECONNRESET"); }),
      vi.fn(async () => new Response("not json", { status: 200 })),
    ]) {
      const account = staleExhaustedAccount();
      const before = { ...account.rateLimits! };
      expect(await probeCodexUsage(account, fetchImpl as unknown as typeof fetch)).toBe(false);
      expect(account.rateLimits).toEqual(before);
    }
  });
});

describe("startCodexUsageLoop", () => {
  it("probes stale enabled accounts and skips fresh, disabled or expired ones", async () => {
    vi.useFakeTimers();
    const stale = staleExhaustedAccount();
    const fresh = { ...staleExhaustedAccount(), id: "fresh" };
    fresh.rateLimits = { ...fresh.rateLimits!, lastUpdated: Date.now() };
    const disabled = { ...staleExhaustedAccount(), id: "off", enabled: false };
    const expired = { ...staleExhaustedAccount(), id: "expired", expiresAt: Date.now() - 1 };
    expect(codexUsageIsStale(fresh)).toBe(false);

    const fetchImpl = vi.fn(async () => okResponse(LIVE_BODY));
    const stop = startCodexUsageLoop([stale, fresh, disabled, expired], fetchImpl as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stale.rateLimits?.status).toBe("allowed");

    // A reading just taken is not re-probed until it ages past the interval.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);   // stale again, and `fresh` has aged out too
    stop();
  });
});
