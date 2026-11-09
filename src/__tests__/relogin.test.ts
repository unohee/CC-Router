import { describe, expect, it, vi } from "vitest";
import { reloginSeat, type ReloginDeps } from "../cli/relogin.js";
import { DEFAULT_RATE_LIMITS, ACCOUNT_USER_DEFAULTS, type Account, type OAuthTokens } from "../proxy/types.js";
import type { RouterProbe } from "../cli/live-router.js";

// Replacing a seat swaps a credential that carries real traffic, so the checks
// before the swap matter more than the swap: right account, router answering,
// nothing changed on any refusal.

const tokens: OAuthTokens = { accessToken: "sk-ant-oat01-new", refreshToken: "sk-ant-ort01-new", expiresAt: 2_000_000_000_000, scopes: ["user:inference"] };
const make = (id: string, t: OAuthTokens): Account => ({
  id, tokens: t, healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0,
  consecutiveErrors: 0, rateLimits: { ...DEFAULT_RATE_LIMITS }, ...ACCOUNT_USER_DEFAULTS,
});
const live: RouterProbe = { state: "live", router: { baseUrl: "http://r", headers: {} } };

function deps(over: Partial<ReloginDeps> = {}): ReloginDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    probe: async () => live,
    knownIds: async () => ["lyra", "heewon", "vega"],
    obtainTokens: async () => tokens,
    fetchProfile: async () => ({ email: "heewon.oh@intrect.io", organization: "Intrect", tier: "default_claude_max_5x" }),
    describe: p => `${p.email} · ${p.organization}`,
    replaceLive: async (_p, a) => { calls.push(`live:${a.id}`); return { ok: true }; },
    replaceInFile: id => { calls.push(`file:${id}`); },
    cleanup: () => { calls.push("cleanup"); },
    log: () => {},
    ...over,
  };
}

describe("reloginSeat", () => {
  it("replaces the seat in the running router and cleans up", async () => {
    const d = deps();
    const r = await reloginSeat({ id: "heewon", yes: true }, d, make);
    expect(r).toEqual({ ok: true, id: "heewon", identity: "heewon.oh@intrect.io · Intrect", via: "router" });
    expect(d.calls).toEqual(["live:heewon", "cleanup"]);
  });

  it("writes the file only when no router is running", async () => {
    const d = deps({ probe: async () => ({ state: "stopped" }) });
    const r = await reloginSeat({ id: "heewon", yes: true }, d, make);
    expect(r).toMatchObject({ ok: true, via: "file" });
    expect(d.calls).toEqual(["file:heewon", "cleanup"]);
  });

  it("changes nothing when a router holds the pid but does not answer", async () => {
    const obtain = vi.fn();
    const d = deps({ probe: async () => ({ state: "unreachable", reason: "silent" }), obtainTokens: obtain });
    const r = await reloginSeat({ id: "heewon", yes: true }, d, make);
    expect(r.ok).toBe(false);
    expect(obtain).not.toHaveBeenCalled(); // not even a login is started
    expect(d.calls).toEqual([]);
  });

  it("refuses an unknown seat before logging in", async () => {
    const obtain = vi.fn();
    const r = await reloginSeat({ id: "nobody", yes: true }, deps({ obtainTokens: obtain }), make);
    expect(r).toMatchObject({ ok: false });
    expect(obtain).not.toHaveBeenCalled();
  });

  it("aborts when the logged-in email is not the expected seat", async () => {
    const d = deps();
    const r = await reloginSeat({ id: "vega", expect: "vega@", yes: true }, d, make);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.reason).toContain("does not match");
    expect(d.calls).toEqual([]);
  });

  it("accepts a matching expectation regardless of case", async () => {
    const r = await reloginSeat({ id: "heewon", expect: "HEEWON.OH@", yes: true }, deps(), make);
    expect(r.ok).toBe(true);
  });

  it("without a terminal and without --yes, shows who it is and stops", async () => {
    const d = deps();
    const r = await reloginSeat({ id: "heewon" }, d, make);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("heewon.oh@intrect.io");
    expect(r.ok === false && r.reason).toContain("--yes");
    expect(d.calls).toEqual([]);
  });

  it("asks a person when it can, and respects no", async () => {
    const d = deps({ confirm: async () => false });
    const r = await reloginSeat({ id: "heewon" }, d, make);
    expect(r).toMatchObject({ ok: false });
    expect(d.calls).toEqual([]);
  });

  it("leaves everything alone when the new token is refused by the profile endpoint", async () => {
    const d = deps({ fetchProfile: async () => null });
    const r = await reloginSeat({ id: "heewon", yes: true }, d, make);
    expect(r).toMatchObject({ ok: false });
    expect(d.calls).toEqual([]);
  });

  it("does not clean up when the router rejects the replacement", async () => {
    const d = deps({ replaceLive: async () => ({ ok: false, status: 500, message: "disk full" }) });
    const r = await reloginSeat({ id: "heewon", yes: true }, d, make);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.reason).toContain("disk full");
    expect(d.calls).toEqual([]); // the cleanup hook (it deletes the Keychain login) must not run
  });
});

import { withoutAccountLogin } from "../utils/keychain-login.js";

describe("withoutAccountLogin", () => {
  it("keeps MCP logins that share the Keychain item with the account login", () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: "a" }, mcpOAuth: { "linear|1": { t: 1 } } });
    const r = withoutAccountLogin(raw);
    expect(r.action).toBe("rewrite");
    expect(r.action === "rewrite" && JSON.parse(r.json)).toEqual({ mcpOAuth: { "linear|1": { t: 1 } } });
  });

  it("deletes the item only when nothing else is stored in it", () => {
    expect(withoutAccountLogin(JSON.stringify({ claudeAiOauth: {} })).action).toBe("delete");
  });

  it("leaves an item with no account login, or an unreadable one, alone", () => {
    expect(withoutAccountLogin(JSON.stringify({ mcpOAuth: {} })).action).toBe("keep");
    expect(withoutAccountLogin("not json").action).toBe("keep");
    expect(withoutAccountLogin("[]").action).toBe("keep");
  });
});
