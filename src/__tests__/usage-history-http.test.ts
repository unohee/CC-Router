import { expect, it, describe } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

// What matters here is the far side of the proxy: tokens a fake upstream reports
// must show up in the history the router serves, exactly once per request, keep
// accumulating across a restart, and never expose anything but aggregates on an
// endpoint that is deliberately open. Nothing uses a real account — the upstream
// is a fake and the token is a fixture.

const SECRET = "s3cret-for-the-usage-test";
const SESSION = "sess-0123abcd-4567-89ef-0123-456789abcdef";

const JSON_REPLY = { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } };

function sse(input: number, cacheRead: number, cacheCreation: number, output: number): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
  return ev("message_start", { message: { id: "m", usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation, output_tokens: 1 } } })
    + ev("content_block_delta", { delta: { type: "text_delta", text: "ok" } })
    + ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } })
    + ev("message_stop", {});
}

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

type Upstream = "json" | "sse" | "sse-no-usage";
interface Fixture {
  dir: string;
  usagePath: string;
  /** What the fake upstream sends next; falls back to a JSON reply. */
  queue: Upstream[];
  upstream: Server;
  upstreamPort: number;
}

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-usage-test-"));
  const queue: Upstream[] = [];
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const kind = queue.shift() ?? "json";
      if (kind === "json") {
        res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" });
        res.end(JSON.stringify(JSON_REPLY));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-status": "allowed" });
        res.end(kind === "sse" ? sse(100, 800, 50, 42) : "event: ping\ndata: {\"type\":\"ping\"}\n\n");
      }
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
    id: "fixture", accessToken: "fixture", refreshToken: "fixture",
    expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }]));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ proxySecret: SECRET }));
  return { dir, usagePath: join(dir, "usage.json"), queue, upstream, upstreamPort: (upstream.address() as { port: number }).port };
}

async function teardown(f: Fixture): Promise<void> {
  await new Promise<void>(r => f.upstream.close(() => r()));
  rmSync(f.dir, { recursive: true, force: true });
}

interface Router {
  base: string;
  child: ChildProcess;
  logs: () => string;
  /** SIGTERM and wait for the exit, which is when the history is flushed. */
  stop: () => Promise<void>;
  send: (opts?: { stream?: boolean; auth?: boolean; model?: string }) => Promise<Response>;
  usage: (query?: string, auth?: boolean) => Promise<Response>;
  history: (query?: string) => Promise<Summary>;
}

interface Summary {
  tz: string; tzFallback: boolean; since: number | null;
  windows: Record<"1d" | "7d" | "14d" | "30d", { total: number; input: number; output: number; cacheRead: number; cacheCreation: number; requests: number; partial: boolean }>;
  cells: Array<{ pad?: true; date?: string; total?: number; level?: number | null }>;
  models: { rows: Array<{ model: string; provider: string; total: number }> };
  details: { cacheHitRatio: number | null };
}

async function startRouter(f: Fixture): Promise<Router> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
    ACCOUNTS_PATH: join(f.dir, "accounts.json"), CONFIG_PATH: join(f.dir, "config.json"),
    SESSIONS_PATH: join(f.dir, "sessions.json"),
  };
  // Left unset on purpose: the default must land beside accounts.json.
  delete env["USAGE_PATH"];
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${f.upstreamPort}'});`], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout!.on("data", b => { logs += b; });
  child.stderr!.on("data", b => { logs += b; });
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (logs.includes("Listening:")) { clearInterval(timer); clearTimeout(timeout); resolve(); }
      else if (child.exitCode !== null) { clearInterval(timer); clearTimeout(timeout); reject(new Error(logs)); }
    }, 25);
    const timeout = setTimeout(() => { clearInterval(timer); reject(new Error(logs || "startup timeout")); }, 10_000);
  });
  const base = `http://127.0.0.1:${port}`;
  const usage = (query = "", auth = false) => fetch(`${base}/cc-router/usage-history${query}`, {
    signal: AbortSignal.timeout(5000), headers: auth ? { authorization: `Bearer ${SECRET}` } : {},
  });
  return {
    base, child, logs: () => logs,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 4000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
    send: ({ stream = false, auth = true, model = "claude-sonnet-4-6" } = {}) => fetch(`${base}/v1/messages`, {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: {
        "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": SESSION,
        ...(auth ? { authorization: `Bearer ${SECRET}` } : {}),
      },
      body: JSON.stringify({ model, max_tokens: 1, stream, messages: [{ role: "user", content: "hi" }] }),
    }),
    usage,
    history: async (query = "?tz=UTC") => (await usage(query)).json() as Promise<Summary>,
  };
}

/**
 * The upstream usage is parsed as the response streams through, and the route
 * memoises each summary for two seconds, so a poll may see a stale answer for a
 * moment. Wait long enough to outlast both.
 */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const total = (s: Summary) => s.windows["1d"].total;

describe("usage history through a real router", () => {
  it("records a JSON reply and a streamed reply once each, and serves them without the secret", async () => {
    const f = await fixture();
    const r = await startRouter(f);
    try {
      expect((await r.send()).status).toBe(200);
      f.queue.push("sse");
      const streamed = await r.send({ stream: true });
      expect(streamed.status).toBe(200);
      await streamed.text();
      // 10+5+100+20 and 100+42+800+50
      await until(async () => total(await r.history()) === 135 + 992, "both responses to be recorded");

      const open = await r.usage("?tz=UTC", false); // no secret
      expect(open.status).toBe(200);
      const s = await open.json() as Summary;
      expect(s.windows["1d"]).toMatchObject({ input: 110, output: 47, cacheRead: 900, cacheCreation: 70, total: 1127, requests: 2 });
      expect(s.windows["7d"].total).toBe(1127);
      // One request is one request even though its input and output are recorded separately.
      expect(s.windows["1d"].requests).toBe(2);
      expect(s.details.cacheHitRatio).toBeCloseTo(900 / (900 + 70 + 110));
      expect(s.models.rows).toHaveLength(1);
      expect(s.models.rows[0]).toMatchObject({ provider: "anthropic", total: 1127 });
      expect(s.models.rows[0].model).toMatch(/sonnet/);
      expect(s.since).not.toBeNull();
      expect(s.windows["1d"].partial).toBe(true);
      // Today is the last cell and it carries everything.
      expect(s.cells.at(-1)).toMatchObject({ total: 1127 });
      expect(s.cells.at(-1)!.level).toBeGreaterThanOrEqual(1);
    } finally {
      await r.stop();
      await teardown(f);
    }
  }, 30_000);

  it("agrees with the router's own running totals, which is what the history is meant to extend", async () => {
    const f = await fixture();
    const r = await startRouter(f);
    try {
      f.queue.push("sse", "json", "sse");
      for (const stream of [true, false, true]) await (await r.send({ stream })).text();
      await until(async () => (await r.history()).windows["1d"].requests === 3, "three requests");
      const h = await (await fetch(`${r.base}/cc-router/health`)).json() as Record<string, number>;
      const s = await r.history();
      expect(s.windows["1d"]).toMatchObject({
        input: h["totalInputTokens"], output: h["totalOutputTokens"],
        cacheRead: h["totalCacheReadTokens"], cacheCreation: h["totalCacheCreationTokens"],
      });
    } finally {
      await r.stop();
      await teardown(f);
    }
  }, 30_000);

  it("keeps accumulating across a restart, from a file only its owner can read", async () => {
    const f = await fixture();
    let r = await startRouter(f);
    try {
      await (await r.send()).text();
      await until(async () => total(await r.history()) === 135, "the first response");
      await r.stop();

      expect(existsSync(f.usagePath)).toBe(true);
      expect(statSync(f.usagePath).mode & 0o777).toBe(0o600);
      expect(existsSync(`${f.usagePath}.tmp`)).toBe(false);

      r = await startRouter(f);
      expect(total(await r.history())).toBe(135);
      await (await r.send()).text();
      await until(async () => total(await r.history()) === 270, "the second response after the restart");
      const s = await r.history();
      expect(s.windows["1d"].requests).toBe(2);
      // `since` is the first run's, not the restart's.
      const file = JSON.parse(readFileSync(f.usagePath, "utf-8")) as { since: number };
      expect(s.since).toBe(file.since);
    } finally {
      await r.stop();
      await teardown(f);
    }
  }, 40_000);

  it("leaves no sample for a response whose usage it could not read, instead of recording a zero", async () => {
    const f = await fixture();
    const r = await startRouter(f);
    try {
      f.queue.push("sse-no-usage");
      await (await r.send({ stream: true })).text();
      await new Promise(res => setTimeout(res, 300));
      const s = await r.history();
      expect(s.since).toBeNull();
      expect(s.windows["30d"].requests).toBe(0);
      expect(s.cells.every(c => c.pad || c.level === null)).toBe(true);
    } finally {
      await r.stop();
      await teardown(f);
    }
  }, 30_000);

  it("exposes only aggregates on a route that needs no secret", async () => {
    const f = await fixture();
    const r = await startRouter(f);
    try {
      await (await r.send()).text();
      await until(async () => total(await r.history()) === 135, "the response");
      const body = await (await r.usage("?tz=Asia%2FSeoul")).text();
      for (const leak of [SECRET, SESSION, "fixture", "accountId", "sessionId", "accessToken", "refreshToken"]) {
        expect(body, leak).not.toContain(leak);
      }
      // The same secret still guards everything else.
      expect((await r.send({ auth: false })).status).toBe(401);
    } finally {
      await r.stop();
      await teardown(f);
    }
  }, 30_000);

  it("answers in the viewer's time zone, and falls back to UTC — flagged — for one it does not know", async () => {
    const f = await fixture();
    const r = await startRouter(f);
    try {
      expect(await r.history("?tz=Asia%2FSeoul")).toMatchObject({ tz: "Asia/Seoul", tzFallback: false });
      expect(await r.history("?tz=Mars%2FPhobos")).toMatchObject({ tz: "UTC", tzFallback: true });
      expect(await r.history("?tz=a&tz=b")).toMatchObject({ tz: "UTC" });
      expect(await r.history("")).toMatchObject({ tz: "UTC", tzFallback: false });
    } finally {
      await r.stop();
      await teardown(f);
    }
  }, 30_000);

  it("sets a file that is not JSON aside rather than overwrite it, and starts with an empty history", async () => {
    const f = await fixture();
    writeFileSync(f.usagePath, "{ this is not json");
    const r = await startRouter(f);
    try {
      expect(r.logs()).toContain("could not be read");
      expect(readFileSync(`${f.usagePath}.corrupt`, "utf-8")).toBe("{ this is not json");
      expect((await r.history()).since).toBeNull();
      await (await r.send()).text();
      await until(async () => total(await r.history()) === 135, "the response");
      await r.stop();
      expect(JSON.parse(readFileSync(f.usagePath, "utf-8"))).toMatchObject({ version: 1 });
      expect(readFileSync(`${f.usagePath}.corrupt`, "utf-8")).toBe("{ this is not json");
    } finally {
      await r.stop();
      await teardown(f);
    }
  }, 30_000);

  it("sets aside a JSON file that is not a usage history just the same", async () => {
    const f = await fixture();
    writeFileSync(f.usagePath, JSON.stringify({ version: 9, rows: [] }));
    const r = await startRouter(f);
    try {
      expect(r.logs()).toContain("is not a usage file");
      expect(JSON.parse(readFileSync(`${f.usagePath}.corrupt`, "utf-8"))).toEqual({ version: 9, rows: [] });
      expect((await r.history()).since).toBeNull();
    } finally {
      await r.stop();
      await teardown(f);
    }
  }, 30_000);

  it("writes nothing while idle", async () => {
    const f = await fixture();
    const r = await startRouter(f);
    try {
      await r.history();
      await r.stop();
      expect(existsSync(f.usagePath)).toBe(false);
    } finally {
      await r.stop();
      await teardown(f);
    }
  }, 30_000);
});
