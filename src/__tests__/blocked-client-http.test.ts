import { expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { waitForListening } from "./helpers/router-process.js";

// A blocked client must be turned away before the router picks an account, so the
// proof is on the far side: the fake upstream counts what actually reaches it and
// the router's own health shows whether an account was touched. Nothing here uses
// a real account — the upstream is a fake and the token is a fixture.

const OK_BODY = {
  id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 1, output_tokens: 1 },
};

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

interface Ctx {
  send: (userAgent: string | undefined, headers?: Record<string, string>) => Promise<Response>;
  get: (path: string, headers?: Record<string, string>) => Promise<Response>;
  upstreamHits: () => number;
  account: () => Promise<{ requestCount: number; coolingUntil?: number }>;
  activity: () => Promise<string[]>;
  logs: () => string;
}

async function withRouter(config: Record<string, unknown>, run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-block-test-"));
  let hits = 0;
  const upstream: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      hits++;
      res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" });
      res.end(JSON.stringify(OK_BODY));
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
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));

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
  const health = async () => (await (await fetch(`${base}/cc-router/health`, { signal: AbortSignal.timeout(3000) })).json()) as
    { accounts: { id: string; requestCount: number; coolingUntil?: number }[]; recentLogs: { details?: string }[] };

  try {
    await waitForListening(child, () => logs);
    await run({
      send: (userAgent, headers = {}) => fetch(`${base}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(5000),
        headers: {
          "content-type": "application/json", "anthropic-version": "2023-06-01",
          ...(userAgent === undefined ? {} : { "user-agent": userAgent }), ...headers,
        },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      }),
      get: (path, headers = {}) => fetch(base + path, { signal: AbortSignal.timeout(3000), headers }),
      upstreamHits: () => hits,
      account: async () => (await health()).accounts.find(a => a.id === "fixture")!,
      activity: async () => (await health()).recentLogs.map(l => l.details ?? ""),
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

it.concurrent("turns a blocked client away with a 403 that says why, touching no account and no upstream", async () => {
  await withRouter({ blockedUserAgents: ["omp/"] }, async ({ send, upstreamHits, account, logs }) => {
    const res = await send("omp/18.9.1");
    expect(res.status).toBe(403);
    const body = await res.json() as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("permission_error");
    expect(body.error.message).toContain('blockedUserAgents: "omp/"');

    expect(upstreamHits()).toBe(0);
    const acct = await account();
    expect(acct.requestCount).toBe(0);
    expect(acct.coolingUntil ?? 0).toBeLessThanOrEqual(Date.now());
    expect(logs()).toContain('[BLOCKED] omp/: refused a request from "omp/18.9.1"');
  });
});

it.concurrent("lets Claude Code and other clients through untouched", async () => {
  await withRouter({ blockedUserAgents: ["omp/"] }, async ({ send, upstreamHits, logs }) => {
    expect((await send("claude-cli/2.1.300 (external, cli)")).status).toBe(200);
    expect((await send("node")).status).toBe(200);
    expect((await send(undefined)).status).toBe(200);
    expect(upstreamHits()).toBe(3);
    expect(logs()).not.toContain("[BLOCKED]");
  });
});

it.concurrent("does nothing unless configured", async () => {
  await withRouter({}, async ({ send, upstreamHits }) => {
    expect((await send("omp/18.9.1")).status).toBe(200);
    expect(upstreamHits()).toBe(1);
  });
});

it.concurrent("logs a retry storm once instead of once per attempt", async () => {
  await withRouter({ blockedUserAgents: ["omp/"] }, async ({ send, activity, logs }) => {
    for (let i = 0; i < 6; i++) expect((await send("omp/18.9.1")).status).toBe(403);
    expect(logs().match(/\[BLOCKED\]/g)?.length).toBe(1);
    expect((await activity()).filter(d => d.startsWith("blocked client omp/")).length).toBe(1);
  });
});

it.concurrent("asks for the secret before it reveals what is blocked", async () => {
  await withRouter({ blockedUserAgents: ["omp/"], proxySecret: "s3cret-for-the-test" }, async ({ send, upstreamHits }) => {
    expect((await send("omp/18.9.1")).status).toBe(401);
    const authed = await send("omp/18.9.1", { authorization: "Bearer s3cret-for-the-test" });
    expect(authed.status).toBe(403);
    expect(upstreamHits()).toBe(0);
  });
});

it.concurrent("keeps health reachable for a blocked client, so monitoring that shares its user-agent still works", async () => {
  await withRouter({ blockedUserAgents: ["omp/"] }, async ({ get }) => {
    expect((await get("/cc-router/health", { "user-agent": "omp/18.9.1" })).status).toBe(200);
  });
});

it.concurrent("ignores an unusable config value instead of blocking everything", async () => {
  await withRouter({ blockedUserAgents: ["", "   ", 5] }, async ({ send, upstreamHits }) => {
    expect((await send("claude-cli/2.1.300")).status).toBe(200);
    expect(upstreamHits()).toBe(1);
  });
});
