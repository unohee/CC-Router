import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import { spawnSync } from "child_process";

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
  ENDPOINT_PATH: `${MOCK_DIR}/router.json`,
  PROXY_PORT: 3456,
  LITELLM_PORT: 4000,
  LITELLM_URL: undefined,
}));

import { probeRouter, addAccountToRouter, removeAccountFromRouter, replaceAccountInRouter } from "../cli/live-router.js";
import { setAsideUnloadedAnthropicAccounts } from "../config/manager.js";
import type { Account } from "../proxy/types.js";

const PID_FILE = `${MOCK_DIR}/cc-router.pid`;
const ACCOUNTS_FILE = `${MOCK_DIR}/accounts.json`;
const ENDPOINT_FILE = `${MOCK_DIR}/router.json`;

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
    // Spawn and reap a child rather than picking a high number: Linux allows
    // pid_max in the millions, so any constant can name a live process there.
    const child = spawnSync(process.execPath, ["-e", ""]);
    fs.writeFileSync(PID_FILE, String(child.pid));

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

describe("probeRouter with a recorded endpoint", () => {
  const record = (host: string, pid = process.pid) =>
    fs.writeFileSync(ENDPOINT_FILE, JSON.stringify({ host, port: 3456, pid }));

  it("looks where the router says it listens, not on localhost", async () => {
    // A router bound to HOST=<tailscale ip> does not answer on localhost; probing
    // there would call it stopped and let `accounts add` write a file it overwrites.
    record("100.79.169.99");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    const probe = await probeRouter(3456);

    expect(probe.state).toBe("live");
    if (probe.state === "live") expect(probe.router.baseUrl).toBe("http://100.79.169.99:3456");
    expect(fetchMock.mock.calls[0]![0]).toBe("http://100.79.169.99:3456/cc-router/health");
  });

  it("reaches a bind-all router through loopback", async () => {
    record("0.0.0.0");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    const probe = await probeRouter(3456);

    if (probe.state === "live") expect(probe.router.baseUrl).toBe("http://127.0.0.1:3456");
    else throw new Error(`expected live, got ${probe.state}`);
  });

  it("ignores a record whose process is gone", async () => {
    const child = spawnSync(process.execPath, ["-e", ""]);
    record("100.79.169.99", child.pid!);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    expect((await probeRouter(3456)).state).toBe("stopped");
  });

  it("refuses to guess when the recorded router is alive but silent", async () => {
    record("100.79.169.99");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket hang up"));

    const probe = await probeRouter(3456);

    expect(probe.state).toBe("unreachable");
    if (probe.state === "unreachable") expect(probe.reason).toContain("100.79.169.99:3456");
  });
});

describe("router account edits", () => {
  it("replaces a seat in place with PUT", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ account: { id: "heewon" } }), { status: 200 }));

    const result = await replaceAccountInRouter(
      { baseUrl: "http://router.local", headers: { authorization: "Bearer s" } },
      account("heewon"),
    );

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://router.local/cc-router/accounts/heewon");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ accessToken: "sk-ant-oat01-heewon", refreshToken: "sk-ant-ort01-heewon" });
  });

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
