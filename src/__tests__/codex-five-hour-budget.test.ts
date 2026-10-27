import { describe, expect, it } from "vitest";
import { canServeOpenAI, createOpenAIAccountPicker } from "../providers/openai/account-pool.js";
import {
  fiveHourWithinBudget,
  resolveCodexFiveHourBudget,
} from "../providers/openai/five-hour-budget.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { AccountRateLimits } from "../proxy/types.js";

const base: OpenAISubscriptionAccount = {
  id: "codex", provider: "openai_subscription",
  accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000,
  enabled: true,
};

const limits = (fiveHourUtil: number): AccountRateLimits => ({
  status: "allowed", fiveHourUtil, fiveHourReset: 0, sevenDayUtil: 0.1, sevenDayReset: 0,
  claim: "five_hour", plan: "plus", requestsLimit: 0, lastUpdated: Date.now(),
});

const budget80 = { fiveHourUtil: 0.8 };

describe("resolveCodexFiveHourBudget", () => {
  it("is off unless enabled; enabled without a figure defaults to 80%", () => {
    expect(resolveCodexFiveHourBudget(undefined)).toBeNull();
    expect(resolveCodexFiveHourBudget({ enabled: false, fiveHourPercent: 70 })).toBeNull();
    expect(resolveCodexFiveHourBudget({ enabled: true })?.fiveHourUtil).toBe(0.8);
    expect(resolveCodexFiveHourBudget({ enabled: true, fiveHourPercent: 70 })?.fiveHourUtil).toBe(0.7);
  });

  it("bounds the figure to 0-100% so a bad value can never mean free", () => {
    expect(resolveCodexFiveHourBudget({ enabled: true, fiveHourPercent: 140 })?.fiveHourUtil).toBe(1);
    expect(resolveCodexFiveHourBudget({ enabled: true, fiveHourPercent: -5 })?.fiveHourUtil).toBe(0);
  });
});

describe("fiveHourWithinBudget", () => {
  it("passes without a reading, and follows the 5h window otherwise", () => {
    expect(fiveHourWithinBudget(undefined, budget80)).toBe(true);
    expect(fiveHourWithinBudget(limits(0.79), budget80)).toBe(true);
    expect(fiveHourWithinBudget(limits(0.8), budget80)).toBe(false);
    expect(fiveHourWithinBudget(limits(1), budget80)).toBe(false);
  });
});

describe("canServeOpenAI with a five-hour budget", () => {
  it("refuses once the window reaches the cap, whatever Codex would still allow", () => {
    expect(canServeOpenAI({ ...base, rateLimits: limits(0.85) }, budget80)).toBe(false);
    expect(canServeOpenAI({ ...base, rateLimits: limits(0.5) }, budget80)).toBe(true);
  });

  it("without a budget the plan's own threshold applies", () => {
    expect(canServeOpenAI({ ...base, rateLimits: { ...limits(1), status: "rate_limited" } })).toBe(false);
    expect(canServeOpenAI({ ...base, rateLimits: limits(0.99) })).toBe(true);
  });

  it("the picker applies the budget too, so a capped account is never handed out", () => {
    const accounts = [
      { ...base, id: "capped", rateLimits: limits(0.9) },
      { ...base, id: "room" },
    ];
    const pick = createOpenAIAccountPicker(accounts, budget80);
    expect(pick()?.id).toBe("room");
    expect(createOpenAIAccountPicker(accounts.slice(0, 1), budget80)()).toBeNull();
  });
});
