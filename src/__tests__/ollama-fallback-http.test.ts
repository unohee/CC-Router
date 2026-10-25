import { expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

// The Ollama fallback spans the cross-provider route, the pool, the /v1 proxy
// and the health endpoint, so it is exercised through a real server. Both
// upstreams are local fakes; nothing here reaches Anthropic or Ollama Cloud.

type Reply = { status: number; headers?: Record<string, string>; body: unknown };

const OK: Reply = {
  status: 200,
  headers: { "anthropic-ratelimit-unified-status": "allowed" },
  body: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "from anthropic" }], usage: { input_tokens: 1, output_tokens: 1 } },
};
const limited = (retryAfter: number): Reply => ({
  status: 429,
  headers: { "retry-after": String(retryAfter) },
  body: { type: "error", error: { type: "rate_limit_error", message: "limited" } },
});

const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const OLLAMA_STREAM = [
  sse("message_start", { message: { id: "o1", type: "message", role: "assistant", model: "glm:cloud", content: [], usage: { input_tokens: 11, output_tokens: 0 } } }),
  sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
  sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "unsigned" } }),
  sse("content_block_stop", { index: 0 }),
  sse("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { index: 1, delta: { type: "text_delta", text: "from ollama" } }),
  sse("content_block_stop", { index: 1 }),
  sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
  sse("message_stop", {}),
].join("");
const OLLAMA_JSON = {
  id: "o2", type: "message", role: "assistant", model: "glm:cloud",
  content: [{ type: "thinking", thinking: "unsigned" }, { type: "text", text: "from ollama" }],
  stop_reason: "end_turn", usage: { input_tokens: 11, cache_read_input_tokens: 2, output_tokens: 4 },
};

/** `mode` shapes failures the status code cannot: a stream cut after its
 *  first events, a 200 stream with no events, a socket dropped right after the
 *  headers, or a request that is never answered. */
type OllamaReply = { status: number; stream?: boolean; body?: unknown; mode?: "truncate" | "empty" | "drop-after-headers" | "hang" };

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

interface Ctx {
  send: (opts?: { stream?: boolean; model?: string; content?: string; signal?: AbortSignal }) => Promise<Response>;
  countTokens: (content?: string) => Promise<Response>;
  health: () => Promise<{
    ollamaFallback: {
      enabled: boolean; requests?: number; errors?: number; serving?: boolean; lastSkipReason?: string | null; lastServedAt?: number | null;
      keyRequired?: boolean; keyPresent?: boolean; ready?: boolean; inactiveReason?: string | null;
      quota?: { status: string; balance?: { includedUsd: number; allowanceUsd: number; purchasedUsd: number } };
    };
    recentLogs: { accountId: string; model: string; type: string; statusCode?: number; details?: string; inputTokens?: number }[];
    totalErrors: number;
  }>;
  anthropicSeen: string[];
  ollamaSeen: { headers: IncomingMessage["headers"]; body: Record<string, unknown> }[];
  /** Ollama requests whose connection closed before the mock answered. */
  ollamaAbandoned: () => number;
  logs: () => string;
  base: () => string;
}

async function withRouter(
  opts: { anthropic: Reply[]; ollama?: OllamaReply[]; ollamaConfig: Record<string, unknown> | null },
  run: (ctx: Ctx) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-ollama-test-"));
  const anthropicQueue = [...opts.anthropic];
  const anthropicSeen: string[] = [];
  const anthropic: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      anthropicSeen.push(req.url ?? "");
      if (req.url?.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 5 }));
        return;
      }
      const reply = anthropicQueue.shift() ?? OK;
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body));
    });
  });
  const ollamaQueue = [...(opts.ollama ?? [])];
  const ollamaSeen: Ctx["ollamaSeen"] = [];
  let ollamaAbandoned = 0;
  const ollama: Server = createServer((req, res) => {
    // Balance telemetry is not an inference and must not consume the scripted
    // inference responses or affect the request/abandonment assertions below.
    if (req.method === "GET" && req.url === "/api/balance") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        included: { balance_usd: 75, allowance_usd: 100, period: { until: new Date(Date.now() + 86_400_000).toISOString() } },
        purchased: { balance_usd: 5 },
      }));
      return;
    }
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      ollamaSeen.push({ headers: req.headers, body });
      const reply = ollamaQueue.shift() ?? { status: 200, stream: body["stream"] === true };
      if (reply.mode === "hang") {
        res.on("close", () => { if (!res.writableEnded) ollamaAbandoned++; });
        return;
      }
      if (reply.mode === "empty") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end();
        return;
      }
      if (reply.mode === "drop-after-headers") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      if (reply.mode === "truncate") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // message_start and the start of the text block, then the socket dies.
        res.write(OLLAMA_STREAM.slice(0, OLLAMA_STREAM.indexOf("event: content_block_stop", OLLAMA_STREAM.indexOf("from ollama"))));
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      if (reply.status !== 200) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body ?? { type: "error", error: { type: "rate_limit_error", message: "usage credits reached" } }));
        return;
      }
      if (reply.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Split mid-event so the router's buffering is exercised end to end.
        const half = Math.floor(OLLAMA_STREAM.length / 2);
        res.write(OLLAMA_STREAM.slice(0, half));
        setTimeout(() => res.end(OLLAMA_STREAM.slice(half)), 20);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body ?? OLLAMA_JSON));
    });
  });
  const anthropicPort = await listen(anthropic);
  const ollamaPort = await listen(ollama);

  const port = await freePort();
  writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
    id: "fixture", accessToken: "fixture", refreshToken: "fixture",
    expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }]));
  writeFileSync(join(dir, "config.json"), JSON.stringify(opts.ollamaConfig
    ? { ollamaFallback: { baseUrl: `http://127.0.0.1:${ollamaPort}`, apiKeyEnv: "CC_ROUTER_TEST_OLLAMA_KEY", ...opts.ollamaConfig } }
    : {}));

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${anthropicPort}'});`], {
    env: {
      ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
      ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"),
      SESSIONS_PATH: join(dir, "sessions.json"),
      CC_ROUTER_TEST_OLLAMA_KEY: "test-ollama-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", b => { logs += b; });
  child.stderr.on("data", b => { logs += b; });
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    "content-type": "application/json", "anthropic-version": "2023-06-01",
    "x-claude-code-session-id": "0123456789abcdef",
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (logs.includes("Listening:")) { clearInterval(timer); clearTimeout(timeout); resolve(); }
        else if (child.exitCode !== null) { clearInterval(timer); clearTimeout(timeout); reject(new Error(logs)); }
      }, 25);
      const timeout = setTimeout(() => { clearInterval(timer); reject(new Error(logs || "startup timeout")); }, 8000);
    });
    await run({
      send: ({ stream = false, model = "claude-sonnet-4-6", content = "hi", signal } = {}) => fetch(`${base}/v1/messages`, {
        method: "POST", signal: signal ?? AbortSignal.timeout(5000), headers,
        body: JSON.stringify({ model, max_tokens: 16, stream, messages: [{ role: "user", content }] }),
      }),
      countTokens: (content = "count me") => fetch(`${base}/v1/messages/count_tokens`, {
        method: "POST", signal: AbortSignal.timeout(5000), headers,
        body: countTokensBody(content),
      }),
      health: async () => await (await fetch(`${base}/cc-router/health`, { signal: AbortSignal.timeout(3000) })).json() as Awaited<ReturnType<Ctx["health"]>>,
      anthropicSeen,
      ollamaSeen,
      ollamaAbandoned: () => ollamaAbandoned,
      logs: () => logs,
      base: () => base,
    });
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>(r => anthropic.close(() => r()));
    await new Promise<void>(r => ollama.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const countTokensBody = (content: string) => JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content }] });
/** estimatePromptTokens: raw request bytes / 2, rounded up. */
const estimateOf = (body: string) => Math.ceil(Buffer.byteLength(body) / 2);
const ENABLED = { enabled: true, model: "glm:cloud", tierMap: { opus: "big:cloud" } };

it.concurrent("answers from Ollama when the pool is blocked far into the future, without thinking blocks", async () => {
  await withRouter({ anthropic: [limited(7200)], ollamaConfig: ENABLED }, async ({ send, health, ollamaSeen, anthropicSeen, logs, base }) => {
    expect((await send()).status).toBe(429); // upstream's own 429 cools the only account
    await sleep(50);

    const streamed = await send({ stream: true });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const text = await streamed.text();
    expect(text).toContain("from ollama");
    expect(text).not.toContain("thinking");
    expect(text).toContain('"model":"claude-sonnet-4-6"');
    expect(text).toContain('"index":0');
    expect(text).not.toContain('"index":1');

    const plain = await send({ model: "claude-opus-4-1" });
    expect(plain.status).toBe(200);
    const json = await plain.json() as { model: string; content: { type: string }[] };
    expect(json.model).toBe("claude-opus-4-1");
    expect(json.content.map(b => b.type)).toEqual(["text"]);

    expect(ollamaSeen.map(s => s.body["model"])).toEqual(["glm:cloud", "big:cloud"]);
    expect((await health()).ollamaFallback.quota).toMatchObject({
      status: "known", balance: { includedUsd: 75, allowanceUsd: 100, purchasedUsd: 5 },
    });
    expect(ollamaSeen[0].headers["authorization"]).toBe("Bearer test-ollama-key");
    expect(ollamaSeen[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(ollamaSeen[0].body["messages"]).toEqual([{ role: "user", content: "hi" }]);
    expect(anthropicSeen.filter(u => u.startsWith("/v1/messages"))).toHaveLength(1);

    const h = await health();
    expect(h.ollamaFallback).toMatchObject({
      enabled: true, requests: 2, errors: 0, serving: true,
      keyRequired: false, keyPresent: true, ready: true, inactiveReason: null,
    });
    expect(JSON.stringify(h)).not.toContain("test-ollama-key");
    expect(h.ollamaFallback.lastServedAt).toBeGreaterThan(0);
    const routed = h.recentLogs.filter(l => l.accountId === "ollama");
    expect(routed.map(l => l.model)).toEqual(["big:cloud", "glm:cloud"]);
    expect(routed[1].inputTokens).toBe(11);
    expect(logs()).toContain("serving switched to Ollama");
    expect(logs()).not.toContain("test-ollama-key");

    // Token history records it under its own provider, never a Claude account.
    const history = JSON.stringify(await (await fetch(`${base()}/cc-router/usage-history`, { signal: AbortSignal.timeout(3000) })).json());
    expect(history).toMatch(/"model":"glm:cloud","provider":"ollama"|"provider":"ollama","model":"glm:cloud"/);
  });
}, 30_000);

it.concurrent("keeps the router's 429 when the reset is near, and does not call Ollama", async () => {
  await withRouter({ anthropic: [limited(30)], ollamaConfig: ENABLED }, async ({ send, health, ollamaSeen }) => {
    expect((await send()).status).toBe(429);
    const res = await send();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(28);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(30);
    expect(res.headers.get("x-should-retry")).toBe("true");
    await res.text();
    expect(ollamaSeen).toHaveLength(0);
    expect((await health()).ollamaFallback.lastSkipReason).toMatch(/^reset-near/);
  });
}, 30_000);

it.concurrent("falls through to the router's 429 when Ollama refuses before the first byte", async () => {
  await withRouter({
    anthropic: [limited(7200)],
    ollama: [{ status: 429 }, { status: 500, body: { type: "error", error: { type: "api_error", message: "boom" } } }],
    ollamaConfig: ENABLED,
  }, async ({ send, health, ollamaSeen }) => {
    expect((await send()).status).toBe(429);
    for (const stream of [true, false]) {
      const res = await send({ stream });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(7000);
      expect(res.headers.get("x-should-retry")).toBe("true");
      const body = await res.json() as { error: { message: string } };
      expect(body.error.message).toBe("No configured account is currently available");
    }
    expect(ollamaSeen).toHaveLength(2);
    const h = await health();
    expect(h.ollamaFallback.requests).toBe(0);
    expect(h.ollamaFallback.lastSkipReason).toMatch(/^ollama-failed \(upstream_status 500/);
  });
}, 30_000);

it.concurrent("answers count_tokens locally only while requests go to Ollama", async () => {
  await withRouter({ anthropic: [limited(7200)], ollamaConfig: ENABLED }, async ({ send, countTokens, anthropicSeen, ollamaSeen }) => {
    const before = await countTokens();
    expect(await before.json()).toEqual({ input_tokens: 5 }); // proxied while an account is free
    expect((await send()).status).toBe(429);

    const during = await countTokens();
    expect(during.status).toBe(200);
    const { input_tokens } = await during.json() as { input_tokens: number };
    expect(input_tokens).toBe(estimateOf(countTokensBody("count me")));
    const longer = "x".repeat(4000);
    const larger = await (await countTokens(longer)).json() as { input_tokens: number };
    expect(larger.input_tokens).toBe(estimateOf(countTokensBody(longer)));
    expect(anthropicSeen.filter(u => u.startsWith("/v1/messages/count_tokens"))).toHaveLength(1);
    expect(ollamaSeen).toHaveLength(0);
  });
}, 30_000);

it.concurrent("never calls Ollama while the feature is disabled", async () => {
  await withRouter({ anthropic: [limited(7200)], ollamaConfig: { ...ENABLED, enabled: false } }, async ({ send, countTokens, health, ollamaSeen }) => {
    expect((await send()).status).toBe(429);
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.headers.get("x-should-retry")).toBe("true");
    await res.text();
    expect((await countTokens()).status).toBe(429); // the pool's answer, as before
    expect(ollamaSeen).toHaveLength(0);
    expect((await health()).ollamaFallback).toEqual({ enabled: false });
  });
}, 30_000);

it.concurrent("returns to Anthropic on the first request after the cooldown expires", async () => {
  await withRouter({ anthropic: [limited(3)], ollamaConfig: { ...ENABLED, minWaitSeconds: 0 } }, async ({ send, health, ollamaSeen, anthropicSeen, logs }) => {
    expect((await send()).status).toBe(429);
    const viaOllama = await send();
    expect(viaOllama.status).toBe(200);
    expect(((await viaOllama.json()) as { content: { text: string }[] }).content[0].text).toBe("from ollama");

    await sleep(3300);
    const back = await send();
    expect(back.status).toBe(200);
    expect(((await back.json()) as { content: { text: string }[] }).content[0].text).toBe("from anthropic");
    expect(ollamaSeen).toHaveLength(1);
    expect(anthropicSeen.filter(u => u.startsWith("/v1/messages"))).toHaveLength(2);
    await sleep(50);
    expect((await health()).ollamaFallback.serving).toBe(false);
    expect(logs()).toContain("serving back on Anthropic");
  });
}, 30_000);

it.concurrent("falls through to the router's 429 on a refused connection, an empty stream or a dropped socket", async () => {
  const closedPort = await freePort();
  // A refused connection: baseUrl points at a port nothing listens on.
  await withRouter({ anthropic: [limited(7200)], ollamaConfig: { ...ENABLED, baseUrl: `http://127.0.0.1:${closedPort}` } }, async ({ send, health }) => {
    expect((await send()).status).toBe(429);
    const res = await send({ stream: true });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(7000);
    expect(res.headers.get("x-should-retry")).toBe("true");
    await res.text();
    expect((await health()).ollamaFallback.lastSkipReason).toMatch(/^ollama-failed \(network/);
  });
  await withRouter({
    anthropic: [limited(7200)],
    ollama: [{ status: 200, mode: "empty" }, { status: 200, mode: "drop-after-headers" }],
    ollamaConfig: ENABLED,
  }, async ({ send, health, ollamaSeen }) => {
    expect((await send()).status).toBe(429);
    const empty = await send({ stream: true });
    expect(empty.status).toBe(429);
    expect(empty.headers.get("x-should-retry")).toBe("true");
    await empty.text();
    expect((await health()).ollamaFallback.lastSkipReason).toMatch(/^ollama-failed \(invalid_response/);
    const dropped = await send({ stream: true });
    expect(dropped.status).toBe(429);
    expect(Number(dropped.headers.get("retry-after"))).toBeGreaterThan(7000);
    await dropped.text();
    expect((await health()).ollamaFallback.lastSkipReason).toMatch(/^ollama-failed \((network|invalid_response)/);
    expect(ollamaSeen).toHaveLength(2);
    expect((await health()).ollamaFallback.requests).toBe(0);
  });
}, 30_000);

it.concurrent("counts a stream that Ollama cuts mid-way as an error, after the client got a 200", async () => {
  await withRouter({ anthropic: [limited(7200)], ollama: [{ status: 200, mode: "truncate" }], ollamaConfig: ENABLED }, async ({ send, health }) => {
    expect((await send()).status).toBe(429);
    const before = (await health()).totalErrors;
    const res = await send({ stream: true });
    expect(res.status).toBe(200);
    const text = await res.text().catch(() => "");
    expect(text).toContain("from ollama");
    expect(text).not.toContain("message_stop");
    await sleep(50);
    const h = await health();
    expect(h.ollamaFallback).toMatchObject({ requests: 1, errors: 1 });
    expect(h.totalErrors).toBe(before + 1);
    const entry = h.recentLogs.find(l => l.accountId === "ollama")!;
    expect(entry.type).toBe("error");
    expect(entry.details).toMatch(/failed mid-response/);
  });
}, 30_000);

it.concurrent("keeps a conversation known to be too large for the Ollama model on the router's 429", async () => {
  await withRouter({ anthropic: [limited(7200)], ollamaConfig: { ...ENABLED, contextTokens: 100 } }, async ({ send, health, ollamaSeen }) => {
    expect((await send()).status).toBe(429);
    const res = await send({ content: "x".repeat(400) });
    expect(res.status).toBe(429);
    expect(res.headers.get("x-should-retry")).toBe("true");
    await res.text();
    expect(ollamaSeen).toHaveLength(0);
    expect((await health()).ollamaFallback.lastSkipReason).toMatch(/^too-large/);
    // A small one still goes.
    expect((await send()).status).toBe(200);
    expect(ollamaSeen).toHaveLength(1);
  });
}, 30_000);

it.concurrent("aborts Ollama when the client hangs up, without logging a pool 429 or an Ollama failure", async () => {
  await withRouter({ anthropic: [limited(7200)], ollama: [{ status: 200, mode: "hang" }], ollamaConfig: ENABLED }, async ({ send, health, ollamaSeen, ollamaAbandoned }) => {
    expect((await send()).status).toBe(429);
    const before = await health();
    const poolBefore = before.recentLogs.filter(l => l.accountId === "pool").length;
    const controller = new AbortController();
    const pending = send({ stream: true, signal: controller.signal }).catch(() => null);
    while (ollamaSeen.length === 0) await sleep(10);
    controller.abort();
    await pending;
    await sleep(200);
    expect(ollamaAbandoned()).toBe(1);
    const after = await health();
    expect(after.recentLogs.filter(l => l.accountId === "pool")).toHaveLength(poolBefore);
    expect(after.totalErrors).toBe(before.totalErrors);
    expect(after.ollamaFallback.lastSkipReason ?? "").not.toMatch(/^ollama-failed/);
  });
}, 30_000);

it.concurrent("reports a missing Ollama Cloud key on the health endpoint before the pool is blocked", async () => {
  // ollama.com is never contacted: the account is free, so no request reaches the fallback.
  await withRouter({ anthropic: [], ollamaConfig: { ...ENABLED, baseUrl: "https://ollama.com", apiKeyEnv: "CC_ROUTER_TEST_UNSET_OLLAMA_KEY" } }, async ({ health, send, ollamaSeen }) => {
    expect((await health()).ollamaFallback).toMatchObject({
      enabled: true, keyRequired: true, keyPresent: false, ready: false, inactiveReason: "no-api-key",
    });
    expect((await send()).status).toBe(200);
    expect(ollamaSeen).toHaveLength(0);
  });
}, 30_000);
