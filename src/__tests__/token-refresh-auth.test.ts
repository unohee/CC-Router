import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyRefreshFailure,
  refreshAccountToken,
  refreshAfterRejection,
  runRefreshPass,
  shouldRefreshNow,
} from "../proxy/token-refresher.js";
import { ACCOUNT_USER_DEFAULTS, DEFAULT_RATE_LIMITS, type Account } from "../proxy/types.js";

// A refresh token that the server refuses (invalid_grant) cannot be retried into
// working: the seat needs a new login. Anything else may pass. The loop refreshes
// well before expiry so a dead refresh token is found hours ahead, not minutes.

const MIN = 60_000;
const LEAD = 240 * MIN;
const NOW = Date.UTC(2026, 10, 9, 12, 0);

function account(id: string, expiresIn: number, over: Partial<Account> = {}): Account {
  return {
    id,
    tokens: { accessToken: `sk-ant-oat01-${id}`, refreshToken: `sk-ant-ort01-${id}`, expiresAt: NOW + expiresIn, scopes: ["user:inference"] },
    healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0,
    consecutiveErrors: 0, rateLimits: { ...DEFAULT_RATE_LIMITS }, ...ACCOUNT_USER_DEFAULTS, ...over,
  };
}

const dead = { ok: false, status: 400, text: async () => JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }) } as Response;
const good = {
  ok: true,
  json: async () => ({ access_token: "sk-ant-oat01-NEW", refresh_token: "sk-ant-ort01-NEW", expires_in: 28_800, scope: "user:inference", token_type: "Bearer" }),
} as Response;

describe("classifyRefreshFailure", () => {
  it("calls only invalid_grant permanent", () => {
    expect(classifyRefreshFailure(400, JSON.stringify({ error: "invalid_grant" })).permanent).toBe(true);
    expect(classifyRefreshFailure(400, "invalid_grant").permanent).toBe(true);
    expect(classifyRefreshFailure(400, JSON.stringify({ error: "invalid_request" })).permanent).toBe(false);
    expect(classifyRefreshFailure(401, "Unauthorized").permanent).toBe(false);
    expect(classifyRefreshFailure(429, "slow down").permanent).toBe(false);
    expect(classifyRefreshFailure(503, "").permanent).toBe(false);
  });

  it("carries the server's own description", () => {
    expect(classifyRefreshFailure(400, JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" })).message)
      .toBe("HTTP 400 — Refresh token expired");
  });
});

describe("shouldRefreshNow", () => {
  it("waits until the lead window opens", () => {
    expect(shouldRefreshNow(account("a", LEAD + MIN), NOW, LEAD)).toBe(false);
    expect(shouldRefreshNow(account("a", LEAD - MIN), NOW, LEAD)).toBe(true);
  });

  it("leaves a refused refresh token alone", () => {
    expect(shouldRefreshNow(account("a", 5 * MIN, { authState: "needs-relogin" }), NOW, LEAD)).toBe(false);
  });

  it("backs off after a transient failure while far from expiry, but not in the last ten minutes", () => {
    const early = account("a", 3 * 60 * MIN, { authState: "refresh-failing", nextRefreshAt: NOW + 20 * MIN });
    expect(shouldRefreshNow(early, NOW, LEAD)).toBe(false);
    expect(shouldRefreshNow(early, NOW + 21 * MIN, LEAD)).toBe(true);
    const late = account("b", 5 * MIN, { authState: "refresh-failing", nextRefreshAt: NOW + 20 * MIN });
    expect(shouldRefreshNow(late, NOW, LEAD)).toBe(true);
  });
});

describe("refresh failures", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("a refused refresh token is asked about once, then never again", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const a = account("heewon", 3 * 60 * MIN);
      vi.mocked(fetch).mockResolvedValue(dead);
      expect(await refreshAccountToken(a)).toBe(false);
      expect(a.authState).toBe("needs-relogin");
      expect(a.lastRefreshError).toContain("Refresh token expired");
      expect(a.healthy).toBe(true); // still serves for three hours
      expect(await refreshAccountToken(a)).toBe(false);
      expect(await refreshAccountToken(a)).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the account and the command to run", async () => {
    vi.mocked(fetch).mockResolvedValue(dead);
    await refreshAccountToken(account("vega", 60 * MIN));
    const lines = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(lines).toContain("cc-router accounts relogin vega");
  });

  it("a network error is transient: retried later, and the seat keeps serving", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const a = account("lyra", 3 * 60 * MIN);
      vi.mocked(fetch).mockRejectedValueOnce(new Error("ETIMEDOUT"));
      await refreshAccountToken(a);
      expect(a.authState).toBe("refresh-failing");
      expect(a.healthy).toBe(true);
      expect(a.nextRefreshAt).toBe(NOW + 5 * MIN);
      vi.mocked(fetch).mockRejectedValueOnce(new Error("ETIMEDOUT"));
      await refreshAccountToken(a);
      expect(a.nextRefreshAt).toBe(NOW + 10 * MIN);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a success after failures clears the state", async () => {
    const a = account("rigel", 3 * 60 * MIN, { authState: "refresh-failing", lastRefreshError: "x", nextRefreshAt: 1, consecutiveErrors: 2 });
    vi.mocked(fetch).mockResolvedValueOnce(good);
    expect(await refreshAccountToken(a)).toBe(true);
    expect(a.authState).toBe("ok");
    expect(a.lastRefreshError).toBeUndefined();
    expect(a.nextRefreshAt).toBeUndefined();
    expect(a.consecutiveErrors).toBe(0);
  });
});

describe("runRefreshPass", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("refreshes inside the lead window and skips the rest", async () => {
    const early = account("early", 3 * 60 * MIN);
    const far = account("far", 7 * 60 * MIN);
    vi.mocked(fetch).mockResolvedValue(good);
    // Never the real saveAccounts: it rewrites ~/.cc-router/accounts.json.
    const save = vi.fn();
    await runRefreshPass([early, far], LEAD, NOW, save);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(early.tokens.accessToken).toBe("sk-ant-oat01-NEW");
    expect(far.tokens.accessToken).toBe("sk-ant-oat01-far");
  });

  it("takes a refused seat out only once its access token has expired", async () => {
    const a = account("vega", 5 * MIN, { authState: "needs-relogin" });
    const save = vi.fn();
    await runRefreshPass([a], LEAD, NOW, save);
    expect(a.healthy).toBe(true);
    await runRefreshPass([a], LEAD, NOW + 6 * MIN, save);
    expect(save).not.toHaveBeenCalled();
    expect(a.healthy).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("refreshAfterRejection (upstream answered 401)", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("takes the seat out of rotation when the refresh fails, though expiresAt is hours away", async () => {
    // Upstream refused the token itself; expiresAt cannot be trusted over that.
    const a = account("heewon", 3 * 60 * MIN);
    vi.mocked(fetch).mockResolvedValue(dead);
    expect(await refreshAfterRejection(a, a.tokens.accessToken)).toBe(false);
    expect(a.healthy).toBe(false);
    expect(a.authState).toBe("needs-relogin");
  });

  it("does the same after a transient refresh failure, and the loop retries it on its next pass", async () => {
    const a = account("lyra", 3 * 60 * MIN);
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ETIMEDOUT"));
    await refreshAfterRejection(a, a.tokens.accessToken);
    expect(a.healthy).toBe(false);
    expect(a.authState).toBe("refresh-failing");
    expect(shouldRefreshNow(a, Date.now() + 1, LEAD)).toBe(true); // inside the last ten minutes: no backoff
    vi.mocked(fetch).mockResolvedValueOnce(good);
    expect(await refreshAccountToken(a)).toBe(true);
    expect(a.healthy).toBe(true);
  });

  it("restores everything when the refresh works", async () => {
    const a = account("rigel", 3 * 60 * MIN);
    vi.mocked(fetch).mockResolvedValueOnce(good);
    expect(await refreshAfterRejection(a, a.tokens.accessToken)).toBe(true);
    expect(a.healthy).toBe(true);
    expect(a.tokens.accessToken).toBe("sk-ant-oat01-NEW");
    expect(a.tokens.expiresAt).toBeGreaterThan(Date.now() + 7 * 60 * MIN);
  });

  it("ignores a 401 about a token a refresh has already replaced", async () => {
    // A slow request carried the old token; meanwhile the loop rotated it. Expiring
    // the fresh token would burn a rotation and could take a good seat out.
    const a = account("kyte", 7 * 60 * MIN);
    const stale = "sk-ant-oat01-stale";
    const before = a.tokens.expiresAt;
    expect(await refreshAfterRejection(a, stale)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(a.tokens.expiresAt).toBe(before);
    expect(a.healthy).toBe(true);
  });
});
