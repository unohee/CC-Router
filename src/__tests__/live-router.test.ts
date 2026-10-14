import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";

const MOCK_DIR = vi.hoisted(() => {
  const tmp = process.env["TMPDIR"] ?? "/tmp";
  return `${tmp}/cc-router-live-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
});

vi.mock("../config/paths.js", () => ({
  CONFIG_DIR: MOCK_DIR,
  ACCOUNTS_PATH: `${MOCK_DIR}/accounts.json`,
  CONFIG_PATH: `${MOCK_DIR}/config.json`,
  SESSIONS_PATH: `${MOCK_DIR}/sessions.json`,
  CLAUDE_SETTINGS_PATH: `${MOCK_DIR}/settings.json`,
  PID_PATH: `${MOCK_DIR}/cc-router.pid`,
  PROXY_PORT: 3456,
  LITELLM_PORT: 4000,
  LITELLM_URL: undefined,
}));

import { probeRouter, addAccountToRouter, removeAccountFromRouter } from "../cli/live-router.js";
import { setAsideUnloadedAnthropicAccounts } from "../config/manager.js";
import type { Account } from "../proxy/types.js";

const PID_FILE = `${MOCK_DIR}/cc-router.pid`;
const ACCOUNTS_FILE = `${MOCK_DIR}/accounts.json`;

beforeEach(() => {
  fs.mkdirSync(MOCK_DIR, { recursive: true });
  // No client block: probeRouter falls back to http://localhost:<port>.
  fs.writeFileSync(`${MOCK_DIR}/config.json`, JSON.stringify({}));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(MOCK_DIR, { recursive: true, force: true });
});

const account = (id: string): Account => ({
  id,
  tokens: {
    accessToken: `sk-ant-oat01-${id}`,
    refreshToken: `sk-ant-ort01-${id}`,
    expiresAt: 1999999999000,
    scopes: ["user:inference"],
  },
  healthy: true, busy: false, requestCount: 0, errorCount: 0,
  lastUsed: 0, lastRefresh: 0, consecutiveErrors: 0,
  rateLimits: {} as Account["rateLimits"],
  enabled: true, sessionLimitPercent: 100, weeklyLimitPercent: 100,
});

describe("probeRouter", () => {
  it("reports a live router when health answers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    const probe = await probeRouter(3456);

    expect(probe.state).toBe("live");
    if (probe.state === "live") {
      expect(probe.router.baseUrl).toBe("http://localhost:3456");
    }
  });

  it("reports stopped when health is refused and no pid file is held", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    expect((await probeRouter(3456)).state).toBe("stopped");
  });

  it("reports stopped when the pid file names a process that is gone", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    // A pid that cannot be running: kill(0) throws ESRCH.
    fs.writeFileSync(PID_FILE, "999999");

    expect((await probeRouter(3456)).state).toBe("stopped");
  });

  it("refuses to guess when a live process holds the pid file but health is silent", async () => {
    // This is the dangerous case: a router IS running and owns accounts.json,
    // so a file write would be silently reverted by its next save.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket hang up"));
    fs.writeFileSync(PID_FILE, String(process.pid));

    const probe = await probeRouter(3456);

    expect(probe.state).toBe("unreachable");
    if (probe.state === "unreachable") {
      expect(probe.reason).toContain(String(process.pid));
    }
  });
});

describe("router account edits", () => {
  it("posts the account to the running pool rather than writing the file", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ account: { id: "kyte" } }), { status: 201 }));

    const result = await addAccountToRouter(
      { baseUrl: "http://router.local", headers: { authorization: "Bearer s" } },
      account("kyte"),
    );

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://router.local/cc-router/accounts");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      id: "kyte",
      accessToken: "sk-ant-oat01-kyte",
      refreshToken: "sk-ant-ort01-kyte",
    });
    expect(fs.existsSync(ACCOUNTS_FILE)).toBe(false);
  });

  it("surfaces the server's own message when it refuses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: 'Account "kyte" already exists' }), { status: 409 }),
    );

    const result = await addAccountToRouter({ baseUrl: "http://r", headers: {} }, account("kyte"));

    expect(result).toEqual({ ok: false, status: 409, message: 'Account "kyte" already exists' });
  });

  it("deletes through the API so the pool forgets the account too", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await removeAccountFromRouter({ baseUrl: "http://r", headers: {} }, "old acct");

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://r/cc-router/accounts/old%20acct");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });
});

describe("setAsideUnloadedAnthropicAccounts", () => {
  const write = (records: unknown[]) =>
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(records, null, 2));

  it("copies aside a disk account the pool never loaded", () => {
    // Exactly the 2026-10-14 loss: `accounts add` wrote kyte to disk, the
    // running pool held four, and shutdown was about to overwrite the file.
    write([
      { id: "lyra", provider: "anthropic_subscription", accessToken: "a", refreshToken: "b", expiresAt: 1 },
      { id: "kyte", provider: "anthropic_subscription", accessToken: "c", refreshToken: "d", expiresAt: 2 },
    ]);

    const result = setAsideUnloadedAnthropicAccounts(["lyra"], ACCOUNTS_FILE);

    expect(result?.ids).toEqual(["kyte"]);
    const kept = JSON.parse(fs.readFileSync(result!.file, "utf-8")) as Array<{ id: string; refreshToken: string }>;
    expect(kept).toHaveLength(1);
    // The refresh token is the part that cannot be re-derived; it must survive.
    expect(kept[0]).toMatchObject({ id: "kyte", refreshToken: "d" });
    expect(fs.statSync(result!.file).mode & 0o777).toBe(0o600);
  });

  it("treats a record with no provider field as Anthropic", () => {
    write([{ id: "legacy", accessToken: "a", refreshToken: "b", expiresAt: 1 }]);

    expect(setAsideUnloadedAnthropicAccounts([], ACCOUNTS_FILE)?.ids).toEqual(["legacy"]);
  });

  it("ignores OpenAI records, which this save path already preserves", () => {
    write([{ id: "codex", provider: "openai_subscription", accessToken: "a", refreshToken: "b", expiresAt: 1 }]);

    expect(setAsideUnloadedAnthropicAccounts([], ACCOUNTS_FILE)).toBeNull();
  });

  it("writes nothing when the pool holds everything on disk", () => {
    write([{ id: "lyra", provider: "anthropic_subscription", accessToken: "a", refreshToken: "b", expiresAt: 1 }]);

    expect(setAsideUnloadedAnthropicAccounts(["lyra"], ACCOUNTS_FILE)).toBeNull();
    expect(fs.readdirSync(MOCK_DIR).filter(f => f.includes("unloaded"))).toEqual([]);
  });

  it("returns null when there is no accounts file yet", () => {
    expect(setAsideUnloadedAnthropicAccounts(["lyra"], `${MOCK_DIR}/missing.json`)).toBeNull();
  });
});
