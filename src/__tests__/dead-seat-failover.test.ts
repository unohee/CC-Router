import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { TokenPool, NoAvailableAccountError } from "../proxy/token-pool.js";
import { ACCOUNT_USER_DEFAULTS, DEFAULT_RATE_LIMITS, type Account } from "../proxy/types.js";
import { waitForListening, waitFor } from "./helpers/router-process.js";

// A seat whose refresh token the server refused (invalid_grant) is dead in a few
// hours at most. While another seat can serve it takes no work and its sessions
// move; it is used only as a last resort, while its access token still works,
// instead of refusing the client. No client ever sees the seat's 401.

const HOUR = 3_600_000;

function account(id: string, over: Partial<Account> = {}): Account {
  return {
    id,
    tokens: { accessToken: id, refreshToken: id, expiresAt: Date.now() + 8 * HOUR, scopes: [] },
    healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0,
    consecutiveErrors: 0, rateLimits: { ...DEFAULT_RATE_LIMITS }, ...ACCOUNT_USER_DEFAULTS, ...over,
  };
}

describe("the pool and a seat that needs a new login", () => {
  it("never hands it out while another seat can serve", () => {
    const pool = new TokenPool([account("dead", { authState: "needs-relogin" }), account("live")]);
    for (let i = 0; i < 6; i++) expect(pool.getNext().id).toBe("live");
    expect(pool.canServe("dead")).toBe(false);
    expect(pool.hasAvailableAccount()).toBe(true);
  });

  it("lets its pinned sessions go: no retention, and nothing to wait for", () => {
    const pool = new TokenPool([account("dead", { authState: "needs-relogin" }), account("live")]);
    expect(pool.canRetain("dead")).toBe(false);
    expect(pool.blockState("dead")).toEqual({ kind: "indefinite" });
    expect(pool.canRetain("live")).toBe(true);
  });

  it("uses it as a last resort while its access token works, rather than refuse", () => {
    const cooled = account("live", { coolingUntil: Date.now() + HOUR });
    const pool = new TokenPool([account("dead", { authState: "needs-relogin" }), cooled]);
    expect(pool.canServeLastResort("dead")).toBe(true);
    expect(pool.getNext().id).toBe("dead");
    expect(pool.secondsUntilAvailable()).toBe(0);
  });

  it("prefers the dying seat with the most time left", () => {
    const pool = new TokenPool([
      account("soon", { authState: "needs-relogin", tokens: { accessToken: "s", refreshToken: "s", expiresAt: Date.now() + HOUR, scopes: [] } }),
      account("later", { authState: "needs-relogin", tokens: { accessToken: "l", refreshToken: "l", expiresAt: Date.now() + 3 * HOUR, scopes: [] } }),
      account("live", { coolingUntil: Date.now() + HOUR }),
    ]);
    expect(pool.getNext().id).toBe("later");
  });

  it("never uses it once its access token has run out", () => {
    const pool = new TokenPool([
      account("dead", { authState: "needs-relogin", tokens: { accessToken: "d", refreshToken: "d", expiresAt: Date.now() - 1000, scopes: [] } }),
      account("live", { coolingUntil: Date.now() + HOUR }),
    ]);
    expect(pool.canServeLastResort("dead")).toBe(false);
    expect(() => pool.getNext()).toThrow(NoAvailableAccountError);
  });
});

// ─── Through a real router ──────────────────────────────────────────────────

interface Seen { account: string; session: string }
interface Behaviour { status: number; headers?: Record<string, string>; body: unknown }

const OK = (id: string): Behaviour => ({
  status: 200, headers: { "anthropic-ratelimit-unified-status": "allowed" },
  body: { id, type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } },
});
const REVOKED: Behaviour = { status: 401, body: { type: "error", error: { type: "authentication_error", message: "OAuth token has been revoked" } } };
const WEEKLY_429: Behaviour = {
  status: 429,
  headers: {
    "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "seven_day",
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 2 * 86_400), "retry-after": "7200",
  },
  body: { type: "error", error: { type: "rate_limit_error", message: "weekly" } },
};

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

async function freePort(): Promise<number> {
  const s = createServer();
  const port = await listen(s);
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

interface HealthAccount { id: string; healthy: boolean; auth: { state: string } }

async function withRouter(
  accounts: { id: string; expiresAt: number }[],
  behave: (account: string, n: number) => Behaviour,
  run: (ctx: {
    send: (session: string) => Promise<Response>;
    seen: Seen[];
    oauthCalls: () => number;
    health: () => Promise<{ accounts: HealthAccount[] }>;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-dead-seat-"));
  const seen: Seen[] = [];
  const counts = new Map<string, number>();
  const anthropic = createServer((req: IncomingMessage, res: ServerResponse) => {
    const id = String(req.headers["authorization"] ?? "").replace(/^Bearer /, "");
    req.resume();
    req.on("end", () => {
      seen.push({ account: id, session: String(req.headers["x-claude-code-session-id"] ?? "") });
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      const b = behave(id, n);
      res.writeHead(b.status, { "content-type": "application/json", ...b.headers });
      res.end(JSON.stringify(b.body));
    });
  });
  const anthropicPort = await listen(anthropic);
  // Every refresh is refused the way the live router saw it on 2026-11-09.
  let oauth = 0;
  const oauthServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      oauth++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }));
    });
  });
  const oauthPort = await listen(oauthServer);

  writeFileSync(join(dir, "accounts.json"), JSON.stringify(accounts.map(a => ({
    id: a.id, accessToken: a.id, refreshToken: a.id, expiresAt: a.expiresAt, scopes: [], enabled: true,
  }))));
  writeFileSync(join(dir, "config.json"), JSON.stringify({}));
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${anthropicPort}'});`], {
    env: {
      ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
      ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"),
      SESSIONS_PATH: join(dir, "sessions.json"),
      CC_ROUTER_OAUTH_TOKEN_URL: `http://127.0.0.1:${oauthPort}/v1/oauth/token`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", b => { logs += b; });
  child.stderr.on("data", b => { logs += b; });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForListening(child, () => logs);
    await run({
      send: (session) => fetch(`${base}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/json", "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/2.1.317 (external, cli)", "x-claude-code-session-id": session,
        },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
      }),
      seen,
      oauthCalls: () => oauth,
      health: async () => (await fetch(`${base}/cc-router/health`, { signal: AbortSignal.timeout(3000) })).json() as Promise<{ accounts: HealthAccount[] }>,
    });
  } catch (err) {
    throw new Error(`${(err as Error).message}\n--- router output ---\n${logs.slice(-4000)}`);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 3000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>(r => anthropic.close(() => r()));
    await new Promise<void>(r => oauthServer.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const auth = async (health: () => Promise<{ accounts: HealthAccount[] }>, id: string) =>
  (await health()).accounts.find(a => a.id === id)?.auth.state;

describe("a dead seat through a real router", () => {
  it("a revoked access token is answered by another seat, then the seat leaves rotation", async () => {
    // Far from expiry, so only the upstream 401 reveals the dead seat.
    const far = Date.now() + 8 * HOUR;
    await withRouter([{ id: "dead", expiresAt: far }, { id: "live", expiresAt: far }],
      (id, n) => (id === "dead" ? REVOKED : OK(`${id}-${n}`)),
      async ({ send, seen, health }) => {
        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) statuses.push((await send(`s${i}`)).status);
        expect(statuses).toEqual([200, 200, 200, 200]);
        // Some session landed on the dead seat first and was answered by live.
        const hit = seen.find(s => s.account === "dead");
        expect(hit).toBeDefined();
        expect(seen.filter(s => s.session === hit!.session).map(s => s.account)).toEqual(["dead", "live"]);

        await waitFor(async () => (await auth(health, "dead")) === "needs-relogin", "the dead seat to be marked");
        // From now on nothing goes to it: neither its old session nor new ones.
        const before = seen.length;
        for (const session of [hit!.session, "n1", "n2", "n3", "n4"]) expect((await send(session)).status).toBe(200);
        expect(seen.slice(before).map(s => s.account)).toEqual(["live", "live", "live", "live", "live"]);
      });
  });

  it("an expired token whose refresh is refused never reaches the wire, and no client sees a 401", async () => {
    await withRouter([{ id: "dead", expiresAt: Date.now() - 60_000 }, { id: "live", expiresAt: Date.now() + 8 * HOUR }],
      (id, n) => OK(`${id}-${n}`),
      async ({ send, seen, health, oauthCalls }) => {
        await waitFor(async () => (await auth(health, "dead")) === "needs-relogin", "the startup refresh to fail");
        for (let i = 0; i < 6; i++) expect((await send(`e${i}`)).status).toBe(200);
        expect(seen.every(s => s.account === "live")).toBe(true);
        const h = await health();
        expect(h.accounts.find(a => a.id === "dead")).toMatchObject({ healthy: false, auth: { state: "needs-relogin" } });
        // invalid_grant is final: the refresh token is not asked about again.
        const calls = oauthCalls();
        await send("e-last");
        expect(oauthCalls()).toBe(calls);
      });
  });

  it("when the only other seat is out of quota, the dying seat answers instead of a 429", async () => {
    // Inside the lead window: the startup refresh finds the refresh token dead
    // while the access token still has two hours.
    await withRouter([{ id: "dead", expiresAt: Date.now() + 2 * HOUR }, { id: "live", expiresAt: Date.now() + 8 * HOUR }],
      (id, n) => (id === "live" ? WEEKLY_429 : OK(`${id}-${n}`)),
      async ({ send, seen, health }) => {
        await waitFor(async () => (await auth(health, "dead")) === "needs-relogin", "the lead-window refresh to fail");
        // live refuses (weekly window); failover falls back to the dying seat.
        expect((await send("q1")).status).toBe(200);
        expect(seen.map(s => s.account)).toEqual(["live", "dead"]);
        // live is now cooling: the dying seat is picked directly.
        expect((await send("q2")).status).toBe(200);
        expect(seen.slice(2).map(s => s.account)).toEqual(["dead"]);
      });
  });
});
