import { describe, expect, it } from "vitest";
import { canServeOpenAI, createOpenAIAccountPicker } from "../providers/openai/account-pool.js";

describe("createOpenAIAccountPicker", () => {
  it("returns enabled OpenAI accounts in round-robin order", () => {
    const pick = createOpenAIAccountPicker([
      {
        id: "disabled",
        provider: "openai_subscription",
        accessToken: "access-0",
        refreshToken: "refresh-0",
        expiresAt: 1,
        enabled: false,
      },
      {
        id: "one",
        provider: "openai_subscription",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: 1,
        enabled: true,
      },
      {
        id: "two",
        provider: "openai_subscription",
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: 1,
        enabled: true,
      },
    ]);

    expect(pick()?.id).toBe("one");
    expect(pick()?.id).toBe("two");
    expect(pick()?.id).toBe("one");
  });

  it("returns null when no OpenAI account is enabled", () => {
    const pick = createOpenAIAccountPicker([]);
    expect(pick()).toBeNull();
  });

  it("skips accounts whose quota is exhausted", () => {
    const accounts = [
      { id: "a", provider: "openai_subscription" as const, accessToken: "", refreshToken: "",
        expiresAt: Date.now() + 1000, enabled: true,
        rateLimits: { status: "rate_limited" as const, fiveHourUtil: 1, fiveHourReset: 0,
                      sevenDayUtil: 0, sevenDayReset: 0, claim: "five_hour", plan: "pro",
                      requestsLimit: 0, lastUpdated: Date.now() } },
      { id: "b", provider: "openai_subscription" as const, accessToken: "", refreshToken: "",
        expiresAt: Date.now() + 1000, enabled: true },
    ];
    const pick = createOpenAIAccountPicker(accounts);

    expect(pick()?.id).toBe("b");
    expect(pick()?.id).toBe("b");
  });

  it("returns null when every account is exhausted, letting the caller degrade", () => {
    const exhausted = {
      id: "a", provider: "openai_subscription" as const, accessToken: "", refreshToken: "",
      expiresAt: Date.now() + 1000, enabled: true,
      rateLimits: { status: "rate_limited" as const, fiveHourUtil: 1, fiveHourReset: 0,
                    sevenDayUtil: 0, sevenDayReset: 0, claim: "five_hour", plan: "pro",
                    requestsLimit: 0, lastUpdated: Date.now() },
    };

    expect(createOpenAIAccountPicker([exhausted])()).toBeNull();
  });

  it("retries an exhausted account once its reset time has passed", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const account = {
      id: "a", provider: "openai_subscription" as const, accessToken: "", refreshToken: "",
      expiresAt: Date.now() + 1000, enabled: true,
      rateLimits: { status: "rate_limited" as const, fiveHourUtil: 1, fiveHourReset: past,
                    sevenDayUtil: 0, sevenDayReset: 0, claim: "five_hour", plan: "pro",
                    requestsLimit: 0, lastUpdated: Date.now() },
    };

    // Otherwise the account could never recover: quota only refreshes from a
    // response, and a response only happens if the account is picked.
    expect(canServeOpenAI(account)).toBe(true);
  });

  it("keeps an exhausted account out until its reset time arrives", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const account = {
      id: "a", provider: "openai_subscription" as const, accessToken: "", refreshToken: "",
      expiresAt: Date.now() + 1000, enabled: true,
      rateLimits: { status: "rate_limited" as const, fiveHourUtil: 1, fiveHourReset: future,
                    sevenDayUtil: 0, sevenDayReset: 0, claim: "five_hour", plan: "pro",
                    requestsLimit: 0, lastUpdated: Date.now() },
    };

    expect(canServeOpenAI(account)).toBe(false);
  });

  it("retries after a fixed delay when the reading carried no reset time", () => {
    const base = {
      id: "a", provider: "openai_subscription" as const, accessToken: "", refreshToken: "",
      expiresAt: Date.now() + 1000, enabled: true,
    };
    const limits = { status: "rate_limited" as const, fiveHourUtil: 1, fiveHourReset: 0,
                     sevenDayUtil: 0, sevenDayReset: 0, claim: "five_hour", plan: "pro",
                     requestsLimit: 0, lastUpdated: Date.now() };

    expect(canServeOpenAI({ ...base, rateLimits: limits })).toBe(false);
    expect(canServeOpenAI({ ...base, rateLimits: { ...limits, lastUpdated: Date.now() - 6 * 60 * 1000 } })).toBe(true);
  });
});
