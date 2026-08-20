import { describe, expect, it } from "vitest";
import { createHealthAccountViews, createOperationalStatus, pinnedAnthropicAccount } from "../proxy/server.js";
import type { Account } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";
import { TokenPool } from "../proxy/token-pool.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

function makeAnthropicAccount(): Account {
  return {
    id: "max-account-1",
    tokens: {
      accessToken: "ant-access",
      refreshToken: "ant-refresh",
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    },
    healthy: true,
    busy: false,
    requestCount: 2,
    errorCount: 0,
    lastUsed: 123,
    lastRefresh: 456,
    consecutiveErrors: 0,
    rateLimits: {
      status: "allowed",
      fiveHourUtil: 0.1,
      fiveHourReset: 0,
      sevenDayUtil: 0.2,
      sevenDayReset: 0,
      claim: "",
      plan: "Max 5x",
      requestsLimit: 500,
      lastUpdated: 789,
    },
    enabled: true,
    sessionLimitPercent: 80,
    weeklyLimitPercent: 90,
  };
}

describe("createHealthAccountViews", () => {
  it("combines Anthropic pool stats with OpenAI subscription account status", () => {
    const openAIAccount: OpenAISubscriptionAccount = {
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: Date.now() + 120_000,
      enabled: true,
    };

    const views = createHealthAccountViews([makeAnthropicAccount()], [openAIAccount]);

    expect(views.map(view => [view.id, view.provider])).toEqual([
      ["max-account-1", "anthropic_subscription"],
      ["openai-primary", "openai_subscription"],
    ]);
    expect(views[1]).toMatchObject({
      healthy: true,
      busy: false,
      requestCount: 0,
      errorCount: 0,
      enabled: true,
    });
    expect(views[1].rateLimits).toBeUndefined();
  });

  it("does not count disabled Anthropic accounts as healthy", () => {
    const disabled = { ...makeAnthropicAccount(), enabled: false };

    const views = createHealthAccountViews([disabled], []);

    expect(views[0]).toMatchObject({
      enabled: false,
      healthy: false,
    });
  });
});

describe("createOperationalStatus", () => {
  it("summarizes proxy capabilities without exposing secrets", () => {
    const anthropicAccount = makeAnthropicAccount();
    const openAIAccount: OpenAISubscriptionAccount = {
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: Date.now() + 120_000,
      enabled: true,
    };

    const status = createOperationalStatus({
      mode: "standalone",
      target: "https://api.anthropic.com",
      authRequired: true,
      accounts: createHealthAccountViews([anthropicAccount], [openAIAccount]),
      modelRouting: {
        anthropicDefaultModel: "claude-sonnet-4-6",
        openAIDefaultModel: "gpt-5-codex",
        anthropicAliases: { sonnet: "claude-sonnet-4-6" },
        openAIAliases: { codex: "gpt-5-codex" },
      },
    });

    expect(status).toEqual({
      mode: "standalone",
      target: "https://api.anthropic.com",
      auth: { required: true },
      providers: {
        anthropic: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
        openai: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
      },
      endpoints: {
        health: "/cc-router/health",
        accounts: "/cc-router/accounts",
        messages: "/v1/messages",
        responses: "/v1/responses",
        models: "/v1/models",
      },
      routing: {
        anthropicDefaultModel: "claude-sonnet-4-6",
        openAIDefaultModel: "gpt-5-codex",
        anthropicAliases: ["sonnet"],
        openAIAliases: ["codex"],
      },
      capabilities: {
        anthropicMessages: true,
        openAIResponses: true,
        crossProviderMessages: true,
        dynamicModels: true,
        accountManagement: true,
      },
    });

    expect(JSON.stringify(status)).not.toContain("openai-access");
    expect(JSON.stringify(status)).not.toContain("ant-access");
  });
});

describe("pinnedAnthropicAccount", () => {
  function poolWith(overrides: Partial<Account> = {}): TokenPool {
    return new TokenPool([{
      id: "pinned",
      provider: "anthropic_subscription",
      healthy: true,
      busy: false,
      enabled: true,
      requestCount: 0,
      errorCount: 0,
      lastUsed: 0,
      lastRefresh: 0,
      tokens: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
      rateLimits: { ...DEFAULT_RATE_LIMITS },
      ...overrides,
    } as Account]);
  }

  it("keeps the pin while the account is merely mid-request", () => {
    // The session router already held this pin through canRetain. Re-testing it
    // with the placement predicate here would drop it on any concurrent
    // request and rewrite the conversation into another account's cache.
    const account = pinnedAnthropicAccount(poolWith({ busy: true }), {
      provider: "anthropic", accountId: "pinned",
    });

    expect(account?.id).toBe("pinned");
  });

  it("gives up the pin when upstream put the account on cooldown", () => {
    const account = pinnedAnthropicAccount(
      poolWith({ busy: true, coolingUntil: Date.now() + 60_000 }),
      { provider: "anthropic", accountId: "pinned" },
    );

    expect(account).toBeUndefined();
  });

  it("gives up the pin when the account is rate limited or unhealthy", () => {
    const limited = pinnedAnthropicAccount(
      poolWith({
        rateLimits: {
          ...DEFAULT_RATE_LIMITS,
          status: "rate_limited",
          fiveHourReset: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
      { provider: "anthropic", accountId: "pinned" },
    );
    expect(limited).toBeUndefined();

    const unhealthy = pinnedAnthropicAccount(poolWith({ healthy: false }), {
      provider: "anthropic", accountId: "pinned",
    });
    expect(unhealthy).toBeUndefined();
  });

  it("ignores an OpenAI pin and an absent pin", () => {
    const pool = poolWith();

    expect(pinnedAnthropicAccount(pool, { provider: "openai", accountId: "codex" })).toBeUndefined();
    expect(pinnedAnthropicAccount(pool, undefined)).toBeUndefined();
    expect(pinnedAnthropicAccount(pool, { provider: "anthropic", accountId: "gone" })).toBeUndefined();
  });
});
