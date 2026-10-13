import { describe, expect, it } from "vitest";
import { accountProviderTag, paddedProviderTag, PROVIDER_TAG_WIDTH, accountCooldownSummary, formatDurationUntil } from "../ui/account-view.js";

describe("accountProviderTag", () => {
  it("names the provider and its plan for OpenAI accounts", () => {
    expect(accountProviderTag({
      provider: "openai_subscription",
      rateLimits: { plan: "pro" },
    })).toBe(" [OpenAI pro]");
  });

  it("names the provider alone before Codex has reported a plan", () => {
    // The plan arrives in response headers, so it is absent until the account
    // has served at least one request.
    expect(accountProviderTag({ provider: "openai_subscription" })).toBe(" [OpenAI]");
    expect(accountProviderTag({
      provider: "openai_subscription",
      rateLimits: { plan: "   " },
    })).toBe(" [OpenAI]");
  });

  it("shows the plan alone for Anthropic accounts, which are the unmarked default", () => {
    expect(accountProviderTag({
      provider: "anthropic_subscription",
      rateLimits: { plan: "Max 20x" },
    })).toBe(" [Max 20x]");
    expect(accountProviderTag({ provider: "anthropic_subscription" })).toBe("");
  });

  it("keeps every tag inside its column so later columns do not shift", () => {
    const cases: Parameters<typeof paddedProviderTag>[0][] = [
      { provider: "openai_subscription", rateLimits: { plan: "pro" } },
      { provider: "openai_subscription", rateLimits: { plan: "an-implausibly-long-plan-name" } },
      { provider: "anthropic_subscription", rateLimits: { plan: "Max 20x" } },
      { provider: "anthropic_subscription" },
    ];

    for (const account of cases) {
      expect(paddedProviderTag(account)).toHaveLength(PROVIDER_TAG_WIDTH);
    }
  });
});

describe("formatDurationUntil", () => {
  it("formats remaining time from an epoch-ms deadline", () => {
    const now = 1_700_000_000_000;
    expect(formatDurationUntil(now - 1_000, now)).toBe("now");
    expect(formatDurationUntil(now + 90_000, now)).toBe("1m");
    expect(formatDurationUntil(now + 3_600_000 + 120_000, now)).toBe("1h2m");
    expect(formatDurationUntil(now + 86_400_000 + 3_600_000, now)).toBe("1d1h");
  });
});

describe("accountCooldownSummary", () => {
  it("returns null when nothing is cooling", () => {
    expect(accountCooldownSummary({}, 1_000)).toBeNull();
    expect(accountCooldownSummary({ coolingUntil: 500, modelCooldowns: { fable: 500 } }, 1_000)).toBeNull();
  });

  it("shows account-wide and model-scoped deadlines the pool waits on", () => {
    const now = 1_000_000;
    expect(accountCooldownSummary({
      coolingUntil: now + 3_600_000,
      modelCooldowns: { fable: now + 86_400_000, opus: now - 1 },
    }, now)).toBe("cool ↻1h0m  fable ↻1d0h");
  });
});
