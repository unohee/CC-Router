import { expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

// The 429 branch lives inside the proxy's response hook, so it can only be
// exercised by a real request going through a real server. Nothing here touches
// a real account: the upstream is a scripted fake and the token is a fixture.

type Reply = { status: number; headers?: Record<string, string>; body: unknown };

const BARE_429: Reply = {
  status: 429,
  headers: { "anthropic-ratelimit-unified-status": "allowed" },
  body: { type: "error", error: { type: "rate_limit_error", message: "Error" } },
};
const OK: Reply = {
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

/** Runs the real router in front of a fake upstream that answers from `script`, in order. */
async function withRouter(script: Reply[], run: (ctx: {
  send: (headers?: Record<string, string>) => Promise<Response>;
  coolingForSeconds: () => Promise<number>;
  /** The activity-log lines the dashboard shows, newest first. */
  activity: () => Promise<string[]>;
  logs: () => string;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-429-test-"));
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
      send: (headers = {}) => fetch(`${base}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      }),
      coolingForSeconds: async () => {
        const health = await (await fetch(`${base}/cc-router/health`, { signal: AbortSignal.timeout(3000) })).json() as
          { accounts: { id: string; coolingUntil?: number }[] };
        const until = health.accounts.find(a => a.id === "fixture")?.coolingUntil ?? 0;
        return Math.max(0, Math.round((until - Date.now()) / 1000));
      },
      activity: async () => {
        const health = await (await fetch(`${base}/cc-router/health`, { signal: AbortSignal.timeout(3000) })).json() as
          { recentLogs: { details?: string }[] };
        return health.recentLogs.map(l => l.details ?? "");
      },
      logs: () => logs,
    });
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>(r => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

it.concurrent("cools an unexplained 429 for 8s, not a minute, and logs who asked and what upstream said", async () => {
  await withRouter([BARE_429], async ({ send, coolingForSeconds, activity, logs }) => {
    const res = await send({ "user-agent": "omp-test-client/0.3", "x-claude-code-session-id": "abcdef0123456789" });
    expect(res.status).toBe(429); // still forwarded: the client decides whether to retry

    const cooling = await coolingForSeconds();
    expect(cooling).toBeGreaterThanOrEqual(6);
    expect(cooling).toBeLessThanOrEqual(8);

    await sleep(200); // the body line is written on the response's `end`
    const out = logs();
    expect(out).toContain('429 bare#1 cooldown=8s retry-after=absent limit=allowed claim=none');
    expect(out).toContain('session=abcdef01 ua="omp-test-client/0.3"');
    expect(out).toContain("upstream said: Error");
    expect(out).not.toContain("authorization");

    // The activity log keeps the cooldown the router chose next to what upstream
    // said; it used to be replaced by the body alone.
    expect(await activity()).toContain("rate limited — cooldown 8s — upstream said: Error");
    // A bare 429 says nothing about the account: it is relayed untouched and
    // the client keeps its own backoff.
    expect(res.headers.get("retry-after")).toBeNull();
    expect(res.headers.get("x-should-retry")).toBeNull();
    expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed");
  });
}, 20_000);

it.concurrent("keeps the Retry-After upstream stated", async () => {
  await withRouter([{ ...BARE_429, headers: { ...BARE_429.headers, "retry-after": "30" } }], async ({ send, coolingForSeconds, logs }) => {
    expect((await send()).status).toBe(429);
    const cooling = await coolingForSeconds();
    expect(cooling).toBeGreaterThanOrEqual(28);
    expect(cooling).toBeLessThanOrEqual(30);
    expect(logs()).toContain('429 stated cooldown=30s retry-after="30"');
  });
}, 20_000);

it.concurrent("keeps the flat minute when upstream names the window that is limiting", async () => {
  await withRouter([{
    ...BARE_429,
    headers: { "anthropic-ratelimit-unified-status": "rate_limited", "anthropic-ratelimit-unified-representative-claim": "five_hour" },
  }], async ({ send, coolingForSeconds, logs }) => {
    expect((await send()).status).toBe(429);
    const cooling = await coolingForSeconds();
    expect(cooling).toBeGreaterThanOrEqual(58);
    expect(logs()).toContain("429 stated cooldown=60s");
  });
}, 20_000);

it.concurrent("escalates the next unexplained 429 once the account is let back in", async () => {
  await withRouter([BARE_429, BARE_429], async ({ send, coolingForSeconds }) => {
    expect((await send()).status).toBe(429);
    expect(await coolingForSeconds()).toBeLessThanOrEqual(8);
    await sleep(8_600); // released
    expect((await send()).status).toBe(429);
    const cooling = await coolingForSeconds();
    expect(cooling).toBeGreaterThan(8);
    expect(cooling).toBeLessThanOrEqual(16);
  });
}, 30_000);

it.concurrent("starts the schedule over once a request has been served", async () => {
  await withRouter([BARE_429, OK, BARE_429], async ({ send, coolingForSeconds }) => {
    expect((await send()).status).toBe(429);
    await sleep(8_600); // released
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    // Without the reset this would be the second step, 16s.
    expect(await coolingForSeconds()).toBeLessThanOrEqual(8);
  });
}, 30_000);
