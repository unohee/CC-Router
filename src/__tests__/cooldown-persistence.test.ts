import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { MAX_READING_AGE_MS, restoreAccountState, snapshotAccountState, type AccountStateFile } from "../config/account-state.js";
import { DEFAULT_RATE_LIMITS, type Account } from "../proxy/types.js";
import { waitForListening } from "./helpers/router-process.js";

// Cooldowns and the last rate-limit reading survive a restart (atomic, 0600,
// beside accounts.json) unless they have expired, so a restarted router routes
// around an exhausted account instead of hitting it to find out.

const NOW = Date.UTC(2026, 10, 5, 12, 0);
const SEC = Math.floor(NOW / 1000);

function account(id: string, over: Partial<Account> = {}): Account {
  return {
    id, tokens: { accessToken: id, refreshToken: id, expiresAt: NOW + 86_400_000, scopes: [] },
    healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0,
    consecutiveErrors: 0, rateLimits: { ...DEFAULT_RATE_LIMITS }, enabled: true,
    sessionLimitPercent: 100, weeklyLimitPercent: 100, ...over,
  };
}

describe("snapshot", () => {
  it("keeps live cooldowns and readings, and nothing for an account with neither", () => {
    const a = account("alpha", {
      coolingUntil: NOW + 60_000,
      modelCooldowns: { opus: NOW + 30_000, sonnet: NOW - 1 },
      rateLimits: { ...DEFAULT_RATE_LIMITS, status: "rate_limited", sevenDayUtil: 1, sevenDayReset: SEC + 86_400, claim: "seven_day", lastUpdated: NOW - 1000 },
      sevenDayWindowSeen: true,
    });
    const b = account("beta", { coolingUntil: NOW - 5 });
    const s = snapshotAccountState([a, b], NOW);
    expect(s.version).toBe(1);
    expect(Object.keys(s.accounts)).toEqual(["alpha"]);
    expect(s.accounts["alpha"]).toEqual({
      coolingUntil: NOW + 60_000,
      modelCooldowns: { opus: NOW + 30_000 },
      rateLimits: a.rateLimits,
      sevenDayWindowSeen: true,
    });
  });
});

describe("restore", () => {
  const file = (accounts: Record<string, unknown>): AccountStateFile => ({ version: 1, savedAt: NOW - 60_000, accounts: accounts as AccountStateFile["accounts"] });

  it("brings back what is still live and drops what has expired", () => {
    const alpha = account("alpha"), beta = account("beta"), gamma = account("gamma");
    const r = restoreAccountState([alpha, beta, gamma], file({
      alpha: {
        coolingUntil: NOW + 120_000,
        modelCooldowns: { opus: NOW + 30_000, haiku: NOW - 10 },
        rateLimits: { status: "rate_limited", fiveHourUtil: 0.4, fiveHourReset: SEC - 60, sevenDayUtil: 1, sevenDayReset: SEC + 86_400, claim: "seven_day", plan: "Max 5x", requestsLimit: 50, lastUpdated: NOW - 60_000 },
        sevenDayWindowSeen: true,
      },
      beta: { coolingUntil: NOW - 1, rateLimits: { ...DEFAULT_RATE_LIMITS, fiveHourUtil: 0.9, fiveHourReset: SEC + 600, lastUpdated: NOW - MAX_READING_AGE_MS - 1 } },
      gamma: {
        // Limited on the 5-hour window, which has since rolled over.
        rateLimits: { status: "rate_limited", fiveHourUtil: 1, fiveHourReset: SEC - 1, sevenDayUtil: 0.3, sevenDayReset: SEC + 3600, claim: "five_hour", lastUpdated: NOW - 3_600_000 },
      },
      removed: { coolingUntil: NOW + 999_999 },
    }), NOW);

    expect(alpha.coolingUntil).toBe(NOW + 120_000);
    expect(alpha.modelCooldowns).toEqual({ opus: NOW + 30_000 });
    expect(alpha.rateLimits).toMatchObject({ status: "rate_limited", sevenDayUtil: 1, claim: "seven_day", fiveHourUtil: 0, fiveHourReset: 0, plan: "Max 5x" });
    expect(alpha.sevenDayWindowSeen).toBe(true);

    expect(beta.coolingUntil).toBeUndefined();
    expect(beta.rateLimits).toEqual(DEFAULT_RATE_LIMITS);

    expect(gamma.rateLimits).toMatchObject({ status: "allowed", fiveHourUtil: 0, fiveHourReset: 0, sevenDayUtil: 0.3 });

    expect(r).toEqual({ cooling: ["alpha"], readings: ["alpha", "gamma"] });
  });

  it("ignores a file that is not an account-state file, and malformed fields", () => {
    const a = account("alpha");
    expect(restoreAccountState([a], null, NOW)).toEqual({ cooling: [], readings: [] });
    expect(restoreAccountState([a], { version: 2, accounts: {} }, NOW)).toEqual({ cooling: [], readings: [] });
    restoreAccountState([a], file({
      alpha: { coolingUntil: "soon", modelCooldowns: { opus: "x" }, rateLimits: { lastUpdated: NOW + 10_000 } },
    }), NOW);
    expect(a.coolingUntil).toBeUndefined();
    expect(a.modelCooldowns).toBeUndefined();
    expect(a.rateLimits).toEqual(DEFAULT_RATE_LIMITS);
  });

  it("does not take an inherited key for an account named like Object.prototype members", () => {
    const a = account("constructor");
    expect(restoreAccountState([a], file({}), NOW)).toEqual({ cooling: [], readings: [] });
  });
});

// ─── Through a real router, against a fake upstream ─────────────────────────

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

interface Router { base: string; child: ChildProcess; logs: () => string; stop: () => Promise<void> }

async function startRouter(dir: string, upstreamPort: number): Promise<Router> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
    ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"),
    SESSIONS_PATH: join(dir, "sessions.json"),
  };
  // Left unset on purpose: the default must land beside accounts.json.
  delete env["ACCOUNT_STATE_PATH"];
  delete env["QUOTA_HISTORY_PATH"];
  delete env["USAGE_PATH"];
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${upstreamPort}'});`], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout!.on("data", b => { logs += b; });
  child.stderr!.on("data", b => { logs += b; });
  await waitForListening(child, () => logs);
  return {
    base: `http://127.0.0.1:${port}`, child, logs: () => logs,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 4000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

/** A fake upstream where `exhausted` answers with a weekly-limit 429 and every other account with 200. */
async function upstream(exhausted: string): Promise<{ server: Server; port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const id = String(req.headers["authorization"] ?? "").replace(/^Bearer /, "");
    req.resume();
    req.on("end", () => {
      seen.push(id);
      if (id === exhausted) {
        res.writeHead(429, {
          "content-type": "application/json", "retry-after": "7200",
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "seven_day",
          "anthropic-ratelimit-unified-7d-utilization": "1",
          "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 2 * 86_400),
        });
        res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "weekly limit" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" });
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: (server.address() as { port: number }).port, seen };
}

function writeAccounts(dir: string, ids: string[]): void {
  writeFileSync(join(dir, "accounts.json"), JSON.stringify(ids.map(id => ({
    id, accessToken: id, refreshToken: id, expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }))));
  writeFileSync(join(dir, "config.json"), "{}");
}

const send = (base: string) => fetch(`${base}/v1/messages`, {
  method: "POST", signal: AbortSignal.timeout(8000),
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.317 (external, cli)" },
  body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
});

describe("cooldowns across a restart, through a real router", () => {
  it("does not send a restarted router's traffic to the account it saw exhausted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-cooldown-"));
    const up = await upstream("alpha");
    writeAccounts(dir, ["alpha", "beta"]);
    let r = await startRouter(dir, up.port);
    try {
      // Send until alpha has been tried once (failover then serves it from beta).
      for (let i = 0; i < 4 && !up.seen.includes("alpha"); i++) await (await send(r.base)).text();
      expect(up.seen).toContain("alpha");
      await r.stop();

      const path = join(dir, "account-state.json");
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(existsSync(`${path}.tmp`)).toBe(false);
      const saved = JSON.parse(readFileSync(path, "utf-8")) as AccountStateFile;
      expect(saved.accounts["alpha"].coolingUntil).toBeGreaterThan(Date.now() + 3_600_000);
      expect(saved.accounts["alpha"].rateLimits).toMatchObject({ claim: "seven_day", sevenDayUtil: 1 });

      up.seen.length = 0;
      r = await startRouter(dir, up.port);
      expect(r.logs()).toMatch(/account state restored: .*still cooling: alpha/);
      for (let i = 0; i < 6; i++) expect((await send(r.base)).status).toBe(200);
      expect(up.seen.length).toBeGreaterThanOrEqual(6);
      expect(up.seen).not.toContain("alpha");
      const health = await (await fetch(`${r.base}/cc-router/health`, { signal: AbortSignal.timeout(5000) })).json() as
        { accounts: Array<{ id: string; coolingUntil?: number }> };
      expect(health.accounts.find(a => a.id === "alpha")!.coolingUntil).toBeGreaterThan(Date.now());
    } finally {
      await r.stop();
      await new Promise<void>(res => up.server.close(() => res()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it("uses an account again once its saved cooldown has expired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-cooldown-expired-"));
    const up = await upstream("nobody");
    writeAccounts(dir, ["alpha"]);
    const past = Date.now() - 1000;
    writeFileSync(join(dir, "account-state.json"), JSON.stringify({
      version: 1, savedAt: past - 60_000,
      accounts: { alpha: { coolingUntil: past, rateLimits: { ...DEFAULT_RATE_LIMITS, status: "rate_limited", claim: "five_hour", fiveHourUtil: 1, fiveHourReset: Math.floor(past / 1000), lastUpdated: past - 60_000 } } },
    }));
    const r = await startRouter(dir, up.port);
    try {
      expect((await send(r.base)).status).toBe(200);
      expect(up.seen).toEqual(["alpha"]);
    } finally {
      await r.stop();
      await new Promise<void>(res => up.server.close(() => res()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps an unreadable state file aside and starts fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-cooldown-corrupt-"));
    const up = await upstream("nobody");
    writeAccounts(dir, ["alpha"]);
    writeFileSync(join(dir, "account-state.json"), "{nope");
    const r = await startRouter(dir, up.port);
    try {
      expect(readFileSync(join(dir, "account-state.json.corrupt"), "utf-8")).toBe("{nope");
      expect((await send(r.base)).status).toBe(200);
    } finally {
      await r.stop();
      await new Promise<void>(res => up.server.close(() => res()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
