import { afterEach, describe, expect, it, vi } from "vitest";
import { needsOpenAIRefresh, prepareOpenAIAccountForRequest, refreshOpenAISubscriptionToken, startOpenAIRefreshLoop } from "../providers/openai/token-refresher.js";

describe("OpenAI subscription token refresher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes expiring OpenAI subscription tokens and stores rotated refresh token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);

    const account = {
      id: "openai-victor",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };

    expect(needsOpenAIRefresh(account)).toBe(true);
    const ok = await refreshOpenAISubscriptionToken(account);

    expect(ok).toBe(true);
    expect(account.accessToken).toBe("new-access");
    expect(account.refreshToken).toBe("new-refresh");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({ method: "POST" }),
    );
    const sent = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(Object.fromEntries(sent)).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
    });
  });

  const jwt = (exp: unknown) => `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
  const makeAccount = () => ({
    id: "expiry-fallback", provider: "openai_subscription" as const,
    accessToken: "old-access", refreshToken: "old-refresh",
    expiresAt: Date.now() + 60_000, enabled: true,
  });

  it.each([undefined, 0, -1, "3600"])("uses JWT expiry when expires_in is not positive numeric (%s)", async expiresIn => {
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const accessToken = jwt(exp);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true,
      json: async () => ({ access_token: accessToken, refresh_token: "rotated", expires_in: expiresIn }),
    } as Response);
    const account = makeAccount();
    const save = vi.fn();
    expect(await prepareOpenAIAccountForRequest(account, [account], save)).toBe(true);
    expect(account).toMatchObject({ accessToken, refreshToken: "rotated", expiresAt: exp * 1000 });
    expect(save).toHaveBeenCalledWith([account]);
  });

  it("prefers a positive expires_in and preserves a refresh token omitted by upstream", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true,
      json: async () => ({ access_token: jwt(Math.floor(now / 1000) + 86400), expires_in: 3600 }),
    } as Response);
    const account = makeAccount();
    expect(await refreshOpenAISubscriptionToken(account)).toBe(true);
    expect(account.expiresAt).toBe(now + 3600000);
    expect(account.refreshToken).toBe("old-refresh");
  });

  it.each([
    null,
    { access_token: "", refresh_token: "rotated", expires_in: 3600 },
    { access_token: "new", refresh_token: "", expires_in: 3600 },
    { access_token: "new", refresh_token: 42, expires_in: 3600 },
    { access_token: "not-a-jwt", refresh_token: "rotated" },
    { access_token: jwt("3600"), refresh_token: "rotated" },
    { access_token: jwt(1), refresh_token: "rotated" },
    { access_token: "new", refresh_token: "rotated", expires_in: Number.MAX_VALUE },
  ])("rejects malformed refresh replacements without mutating or persisting (%j)", async data => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => data } as Response);
    const account = makeAccount();
    const before = { ...account };
    const save = vi.fn();
    expect(await prepareOpenAIAccountForRequest(account, [account], save)).toBe(false);
    expect(account).toEqual(before);
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON without mutating the account", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));
    const account = makeAccount();
    const before = { ...account };
    expect(await refreshOpenAISubscriptionToken(account)).toBe(false);
    expect(account).toEqual(before);
  });

  it("refreshes and persists an expiring account before request forwarding", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);

    const accounts = [
      {
        id: "openai-victor",
        provider: "openai_subscription" as const,
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      },
    ];
    const save = vi.fn();

    const ok = await prepareOpenAIAccountForRequest(accounts[0], accounts, save);

    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledWith(accounts);
    expect(accounts[0].accessToken).toBe("new-access");
  });

  it("does not persist when the account is still fresh", async () => {
    const account = {
      id: "openai-victor",
      provider: "openai_subscription" as const,
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      enabled: true,
    };
    const save = vi.fn();

    const ok = await prepareOpenAIAccountForRequest(account, [account], save);

    expect(ok).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("starts a background refresh loop and returns a stopper", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);
    const account = {
      id: "openai-victor",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const save = vi.fn();

    const stop = startOpenAIRefreshLoop([account], save);
    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(save).toHaveBeenCalled();
    expect(account.accessToken).toBe("new-access");
    vi.useRealTimers();
  });
});
