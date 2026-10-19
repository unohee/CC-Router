import { expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { computeSeverity } from "../proxy/severity.js";

// `/cc-router/health` carries the verdict both status surfaces draw. It has to be
// right on the wire, from a real router, not only in the pure module: the 429
// count reads the stats buffer, and the pool-exhausted rejection only reaches
// that buffer through the request handler.

const BARE_429 = {
  status: 429,
  headers: { "anthropic-ratelimit-unified-status": "allowed" },
  body: { type: "error", error: { type: "rate_limit_error", message: "Error" } },
};
const OK = {
  status: 200,
  headers: { "anthropic-ratelimit-unified-status": "allowed" },
  body: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } },
};

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

const OK_WEEKLY = {
  ...OK,
  headers: {
    ...OK.headers,
    "anthropic-ratelimit-unified-7d-utilization": "0.88",
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 2 * 86_400),
  },
};

interface Health {
  status: string;
  accounts: { id: string; weeklyWindow?: string; healthy: boolean; coolingUntil?: number; modelCooldowns?: Record<string, number>; expiresInMs: number; enabled?: boolean; rateLimits?: unknown }[];
  recentLogs: { ts: number; accountId: string; type: string; statusCode?: number; details?: string }[];
  severity?: {
    pool: string; reasons: string[]; recent429s: number;
    accounts: { id: string; rung: string; state: string; until?: number }[];
    thresholds: { watch: number; problem: number };
  };
}

async function withRouter(
  script: typeof OK[],
  run: (ctx: { send: () => Promise<Response>; health: () => Promise<Health> }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-severity-test-"));
  const queue = [...script];
  const upstream: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const reply = queue.shift() ?? OK;
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as { port: number }).port;

  const port = await freePort();
  writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
    id: "fixture", accessToken: "fixture", refreshToken: "fixture",
    expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }]));
  writeFileSync(join(dir, "config.json"), JSON.stringify({}));

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${upstreamPort}'});`], {
    env: {
      ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
      ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"),
      SESSIONS_PATH: join(dir, "sessions.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", b => { logs += b; });
  child.stderr.on("data", b => { logs += b; });
  const base = `http://127.0.0.1:${port}`;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (logs.includes("Listening:")) { clearInterval(timer); clearTimeout(timeout); resolve(); }
        else if (child.exitCode !== null) { clearInterval(timer); clearTimeout(timeout); reject(new Error(logs)); }
      }, 25);
      const timeout = setTimeout(() => { clearInterval(timer); reject(new Error(logs || "startup timeout")); }, 8000);
    });
    await run({
      send: () => fetch(`${base}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      }),
      health: async () => (await fetch(`${base}/cc-router/health`, { signal: AbortSignal.timeout(3000) })).json() as Promise<Health>,
    });
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>(r => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

it("reports a quiet pool as ok, with the cut-offs the surfaces colour by", async () => {
  await withRouter([], async ({ health }) => {
    const h = await health();
    expect(h.severity).toMatchObject({
      pool: "ok", reasons: [], recent429s: 0, thresholds: { watch: 0.8, problem: 0.95 },
    });
    expect(h.severity?.accounts).toEqual([{ id: "fixture", rung: "ok", state: "ok" }]);
  });
});

it("turns into a problem the moment an account is cooling, and says which and for how long", async () => {
  await withRouter([BARE_429], async ({ send, health }) => {
    expect((await send()).status).toBe(429);
    const h = await health();
    expect(h.severity?.pool).toBe("problem");
    expect(h.severity?.accounts[0]).toMatchObject({ id: "fixture", rung: "problem", state: "cooling" });
    expect(h.severity?.reasons[0]).toMatch(/^fixture cooling \d+[sm]/);
  });
});

it("counts the rejection the router raises when no account is left, which the activity list used to omit", async () => {
  await withRouter([BARE_429], async ({ send, health }) => {
    expect((await send()).status).toBe(429);       // upstream refused; the account now cools
    expect((await send()).status).toBe(429);       // nothing left to serve it
    const h = await health();
    const poolRows = h.recentLogs.filter(l => l.accountId === "pool");
    expect(poolRows).toHaveLength(1);
    expect(poolRows[0]).toMatchObject({ type: "error", statusCode: 429 });
    expect(poolRows[0].details).toMatch(/no account available/);
    expect(h.severity?.recent429s).toBe(2);
  });
});

it("agrees with the pure module when given the same health data", async () => {
  await withRouter([BARE_429], async ({ send, health }) => {
    await send();
    const h = await health();
    const again = computeSeverity(h.accounts, h.recentLogs, Date.now());
    expect(h.severity?.pool).toBe(again.pool);
    expect(h.severity?.accounts.map(a => [a.id, a.rung, a.state])).toEqual(again.accounts.map(a => [a.id, a.rung, a.state]));
  });
});

it("says an account has no weekly window only after enough responses never named one", async () => {
  await withRouter([], async ({ send, health }) => {
    expect((await health()).accounts[0].weeklyWindow).toBe("unknown");
    for (let i = 0; i < 19; i++) expect((await send()).status).toBe(200);
    expect((await health()).accounts[0].weeklyWindow).toBe("unknown");    // 19 readings: not yet
    await send();
    expect((await health()).accounts[0].weeklyWindow).toBe("not-reported"); // the 20th
  });
});

it("knows an account has a weekly window the moment one response names it, and keeps knowing", async () => {
  await withRouter([OK_WEEKLY], async ({ send, health }) => {
    await send();
    const first = await health();
    expect(first.accounts[0].weeklyWindow).toBe("seen");
    expect((first.accounts[0].rateLimits as { sevenDayUtil: number }).sevenDayUtil).toBe(0.88);
    // The next response carries no 7-day figure and replaces the reading whole,
    // yet the account is still one that has a weekly window.
    await send();
    const second = await health();
    expect((second.accounts[0].rateLimits as { sevenDayUtil: number }).sevenDayUtil).toBe(0);
    expect(second.accounts[0].weeklyWindow).toBe("seen");
  });
});
