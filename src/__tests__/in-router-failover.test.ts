import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { FAILOVER_STATUSES, isFailoverStatus } from "../proxy/failover.js";
import { waitForListening } from "./helpers/router-process.js";

// POST /v1/messages is retried inside the router: 429, 529, 500/502/503/504
// and connection errors before any response byte go to the next eligible
// account with the identical body, once per account; then the Ollama fallback;
// then the last refusal is relayed. Nothing is retried after the first byte or
// for other 4xx, and SSE passes through unchanged. All against fake upstreams.

/** What the fake Anthropic does for one request, chosen per account token. */
type Behaviour =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | { drop: "before-headers" }
  | { sse: string; cutAfter?: number };

const OK_BODY = { id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
const ok = (from: string): Behaviour => ({ status: 200, headers: { "anthropic-ratelimit-unified-status": "allowed" }, body: { ...OK_BODY, id: from } });
const refuse = (status: number, extra: Record<string, string> = {}): Behaviour => ({
  status, headers: extra, body: { type: "error", error: { type: status === 429 ? "rate_limit_error" : "api_error", message: `refused ${status}` } },
});
/** A 429 that names the weekly window: cools the account well past the test. */
const weekly429 = (): Behaviour => refuse(429, {
  "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "seven_day",
  "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 2 * 86_400), "retry-after": "7200",
});

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"s","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

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

interface Seen { account: string; body: string; url: string }
interface Ctx {
  send: (opts?: { body?: Record<string, unknown>; headers?: Record<string, string> }) => Promise<Response>;
  seen: Seen[];
  ollamaSeen: number;
  logs: () => string;
}

async function withRouter(
  accounts: string[],
  behave: (account: string, n: number) => Behaviour,
  run: (ctx: Ctx) => Promise<void>,
  opts: { config?: Record<string, unknown>; ollama?: boolean } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-failover-"));
  const seen: Seen[] = [];
  const counts = new Map<string, number>();
  const anthropic = createServer((req: IncomingMessage, res: ServerResponse) => {
    const account = String(req.headers["authorization"] ?? "").replace(/^Bearer /, "");
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      seen.push({ account, body: raw, url: req.url ?? "" });
      const n = (counts.get(account) ?? 0) + 1;
      counts.set(account, n);
      const b = behave(account, n);
      if ("drop" in b) { req.socket.destroy(); return; }
      if ("sse" in b) {
        res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-status": "allowed" });
        if (b.cutAfter !== undefined) {
          res.write(b.sse.slice(0, b.cutAfter));
          setTimeout(() => res.socket?.destroy(), 30);
          return;
        }
        res.end(b.sse);
        return;
      }
      res.writeHead(b.status, { "content-type": "application/json", ...b.headers });
      res.end(JSON.stringify(b.body ?? {}));
    });
  });
  const anthropicPort = await listen(anthropic);

  let ollamaSeen = 0;
  const ollama = createServer((req, res) => {
    if (req.method === "GET") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ included: { balance_usd: 10, allowance_usd: 10, period: { until: new Date(Date.now() + 86_400_000).toISOString() } }, purchased: { balance_usd: 0 } }));
      return;
    }
    req.resume();
    req.on("end", () => {
      ollamaSeen++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "o", type: "message", role: "assistant", model: "glm:cloud", content: [{ type: "text", text: "from ollama" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const ollamaPort = await listen(ollama);

  writeFileSync(join(dir, "accounts.json"), JSON.stringify(accounts.map(id => ({
    id, accessToken: id, refreshToken: id, expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }))));
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    ...(opts.ollama ? { ollamaFallback: { enabled: true, model: "glm:cloud", baseUrl: `http://127.0.0.1:${ollamaPort}`, apiKeyEnv: "CC_ROUTER_TEST_OLLAMA_KEY" } } : {}),
    ...opts.config,
  }));
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${anthropicPort}'});`], {
    env: {
      ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0", CC_ROUTER_TEST_OLLAMA_KEY: "k",
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
    await waitForListening(child, () => logs);
    await run({
      send: ({ body = {}, headers = {} } = {}) => fetch(`${base}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/json", "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/2.1.317 (external, cli)", ...headers,
        },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 64, messages: [{ role: "user", content: "same body" }], ...body }),
      }),
      seen,
      get ollamaSeen() { return ollamaSeen; },
      logs: () => logs,
    });
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 3000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>(r => anthropic.close(() => r()));
    await new Promise<void>(r => ollama.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const accountsSeen = (seen: Seen[]) => seen.map(s => s.account);

describe("which statuses fail over", () => {
  it("is 429, 529 and 500/502/503/504, and no other", () => {
    expect([...FAILOVER_STATUSES].sort()).toEqual([429, 500, 502, 503, 504, 529]);
    for (const s of [200, 400, 401, 403, 404, 413, 422, 501]) expect(isFailoverStatus(s)).toBe(false);
  });
});

describe("in-router failover through a real router", () => {
  for (const status of [429, 529, 500, 502, 503, 504]) {
    it.concurrent(`retries a ${status} on the next account with the identical body`, async () => {
      // Whichever account goes first refuses; the other answers.
      let first: string | null = null;
      await withRouter(["alpha", "beta"], account => {
        first ??= account;
        return account === first ? refuse(status, status === 429 ? { "retry-after": "30" } : {}) : ok(account);
      }, async ({ send, seen, logs }) => {
        const res = await send();
        expect(res.status).toBe(200);
        const body = await res.json() as { id: string };
        expect(seen).toHaveLength(2);
        expect(new Set(accountsSeen(seen)).size).toBe(2);
        expect(body.id).toBe(seen[1].account);
        // Byte for byte the same request, to the same path: the proxy's
        // pathRewrite edits req.url in place, and a retry must not double it.
        expect(seen[1].body).toBe(seen[0].body);
        expect(seen.every(s => s.url === "/v1/messages")).toBe(true);
        expect(logs()).toMatch(new RegExp(`failover: ${seen[0].account} answered HTTP ${status}; retrying on ${seen[1].account}`));
      });
    }, 30_000);
  }

  it.concurrent("retries a connection dropped before any response byte", async () => {
    let first: string | null = null;
    await withRouter(["alpha", "beta"], account => {
      first ??= account;
      return account === first ? { drop: "before-headers" } : ok(account);
    }, async ({ send, seen, logs }) => {
      const res = await send();
      expect(res.status).toBe(200);
      await res.text();
      expect(new Set(accountsSeen(seen)).size).toBe(2);
      expect(logs()).toMatch(/answered connection error/);
    });
  }, 30_000);

  it.concurrent("tries each account once, then relays the last refusal", async () => {
    await withRouter(["alpha", "beta", "gamma"], () => refuse(503), async ({ send, seen, logs }) => {
      const res = await send();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ type: "error", error: { type: "api_error", message: "refused 503" } });
      expect(accountsSeen(seen).sort()).toEqual(["alpha", "beta", "gamma"]);
      expect(seen.every(s => s.url === "/v1/messages")).toBe(true);
      expect(logs()).toContain("failover: no account left after 3 tried; relaying the last refusal (HTTP 503)");
    });
  }, 30_000);

  it.concurrent("hands the request to Ollama once every account has refused", async () => {
    await withRouter(["alpha", "beta"], () => weekly429(), async ctx => {
      const res = await ctx.send();
      expect(res.status).toBe(200);
      expect((await res.json() as { content: Array<{ text: string }> }).content[0].text).toBe("from ollama");
      expect(accountsSeen(ctx.seen).sort()).toEqual(["alpha", "beta"]);
      expect(ctx.ollamaSeen).toBe(1);
    }, { ollama: true });
  }, 30_000);

  for (const status of [400, 401, 403, 404, 413]) {
    it.concurrent(`does not retry a ${status}`, async () => {
      await withRouter(["alpha", "beta"], () => refuse(status), async ({ send, seen }) => {
        const res = await send();
        expect(res.status).toBe(status);
        await res.text();
        expect(seen).toHaveLength(1);
      });
    }, 30_000);
  }

  it.concurrent("does not retry a bare 429 for a client without Claude Code identity", async () => {
    await withRouter(["alpha", "beta"], () => refuse(429, { "anthropic-ratelimit-unified-status": "allowed" }), async ({ send, seen }) => {
      const res = await send({ headers: { "user-agent": "omp/0.3" } });
      expect(res.status).toBe(429);
      await res.text();
      expect(seen).toHaveLength(1);
    });
  }, 30_000);

  it.concurrent("passes SSE through unchanged", async () => {
    await withRouter(["alpha"], () => ({ sse: SSE }), async ({ send, seen }) => {
      const res = await send({ body: { stream: true } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(await res.text()).toBe(SSE);
      expect(seen).toHaveLength(1);
    });
  }, 30_000);

  it.concurrent("never retries once the first byte has gone out", async () => {
    await withRouter(["alpha", "beta"], () => ({ sse: SSE, cutAfter: 120 }), async ({ send, seen }) => {
      const res = await send({ body: { stream: true } });
      expect(res.status).toBe(200);
      const text = await res.text().catch(() => "");
      expect(SSE.startsWith(text)).toBe(true);
      expect(seen).toHaveLength(1);
    });
  }, 30_000);

  it.concurrent("is off when routing.failover.enabled is false", async () => {
    await withRouter(["alpha", "beta"], () => refuse(503), async ({ send, seen }) => {
      const res = await send();
      expect(res.status).toBe(503);
      await res.text();
      expect(seen).toHaveLength(1);
    }, { config: { routing: { failover: { enabled: false } } } });
  }, 30_000);
});
