import { describe, expect, it } from "vitest";
import { accountProviderTag, paddedProviderTag, PROVIDER_TAG_WIDTH } from "../ui/account-view.js";

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
