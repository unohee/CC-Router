import { expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

// An upstream plan-limit 429 belongs to one pool account. These tests run the
// real router in front of a fake upstream that answers per account token, and
// check what the client is told: a short retryable wait when another account
// can serve, the pool's wait when none can, and the verbatim relay on opt-out.

const WEEKLY_429 = (resetSec: number) => ({
  status: 429,
  headers: {
    "retry-after": String(resetSec - Math.floor(Date.now() / 1000)),
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "seven_day",
    "anthropic-ratelimit-unified-7d-reset": String(resetSec),
    "anthropic-ratelimit-unified-7d-utilization": "1.0",
    "anthropic-ratelimit-unified-5h-utilization": "0.2",
  } as Record<string, string>,
  body: { type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit." } },
});
const OK = {
  status: 200,
  headers: { "anthropic-ratelimit-unified-status": "allowed" } as Record<string, string>,
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

async function withRouter(
  accounts: Array<string | Record<string, unknown>>,
  config: Record<string, unknown>,
  replyFor: (token: string) => { status: number; headers: Record<string, string>; body: unknown },
  run: (ctx: { send: () => Promise<Response>; seen: string[]; logs: () => string }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-429-relay-"));
  const seen: string[] = [];
  const upstream: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const token = String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
      seen.push(token);
      const reply = replyFor(token);
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as { port: number }).port;
  const port = await freePort();
  writeFileSync(join(dir, "accounts.json"), JSON.stringify(accounts.map(a => typeof a === "string" ? {
    id: a, accessToken: a, refreshToken: a, expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  } : a)));
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
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (logs.includes("Listening:")) { clearInterval(timer); clearTimeout(timeout); resolve(); }
        else if (child.exitCode !== null) { clearInterval(timer); clearTimeout(timeout); reject(new Error(logs)); }
      }, 25);
      const timeout = setTimeout(() => { clearInterval(timer); reject(new Error(logs || "startup timeout")); }, 8000);
    });
    await run({
      // One session throughout: the retry must leave the refusing account even
      // though the session was pinned to it.
      send: () => fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": "relay-session" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      }),
      seen,
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

const unifiedHeaders = (res: Response) => [...res.headers.keys()].filter(k => k.startsWith("anthropic-ratelimit-unified"));

it.concurrent("turns one account's weekly 429 into a 1s retry that another account serves", async () => {
  const reset = Math.floor(Date.now() / 1000) + 2 * 86_400;
  await withRouter(["alpha", "beta"], {}, t => t === "alpha" ? WEEKLY_429(reset) : OK, async ({ send, seen, logs }) => {
    // Whichever account the session lands on first, make it the refusing one.
    let first = await send();
    if (first.status === 200) { await first.text(); first = await send(); }
    expect(seen).toContain("alpha");
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("1");
    expect(first.headers.get("x-should-retry")).toBe("true");
    expect(unifiedHeaders(first)).toEqual([]);
    await first.text();

    const retry = await send();
    expect(retry.status).toBe(200);
    expect(seen[seen.length - 1]).toBe("beta");
    await retry.text();
    expect(logs()).toContain("client retries in 1s (plan-limit headers withheld)");
  });
});

it.concurrent("with no other account, tells the client the pool's real wait — still without plan-limit headers", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3_600;
  await withRouter(["solo"], {}, () => WEEKLY_429(reset), async ({ send }) => {
    const res = await send();
    expect(res.status).toBe(429);
    const wait = Number(res.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(3_500);
    expect(wait).toBeLessThanOrEqual(3_600);
    expect(res.headers.get("x-should-retry")).toBe("true");
    expect(unifiedHeaders(res)).toEqual([]);
    await res.text();
  });
});

it.concurrent("tells the client 1s when the Ollama fallback would answer the retry", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3_600;
  const config = { ollamaFallback: { enabled: true, baseUrl: "http://127.0.0.1:9", model: "m:cloud", minWaitSeconds: 900 } };
  await withRouter(["solo"], config, () => WEEKLY_429(reset), async ({ send }) => {
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(unifiedHeaders(res)).toEqual([]);
    await res.text();
  });
});

it.concurrent("relays the upstream 429 verbatim when upstream429Relay is passthrough", async () => {
  const reset = Math.floor(Date.now() / 1000) + 2 * 86_400;
  await withRouter(["solo"], { upstream429Relay: "passthrough" }, () => WEEKLY_429(reset), async ({ send }) => {
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.headers.get("anthropic-ratelimit-unified-representative-claim")).toBe("seven_day");
    expect(res.headers.get("x-should-retry")).toBeNull();
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(86_400);
    await res.text();
  });
});

it.concurrent("never overrules an upstream x-should-retry: false", async () => {
  const reset = Math.floor(Date.now() / 1000) + 2 * 86_400;
  const refusal = WEEKLY_429(reset);
  refusal.headers["x-should-retry"] = "false";
  await withRouter(["alpha", "beta"], {}, () => refusal, async ({ send }) => {
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(res.headers.get("anthropic-ratelimit-unified-representative-claim")).toBe("seven_day");
    await res.text();
  });
});

it.concurrent("tells the client 1s when the Codex cross-provider fallback would answer the retry", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3_600;
  const codex = {
    id: "codex", provider: "openai_subscription", accessToken: "codex", refreshToken: "codex",
    expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  };
  const config = { crossProviderFallback: true, modelRouting: { openAIDefaultModel: "gpt-5.5" } };
  // Only the Anthropic account's 429 is under test; the retry is never sent here.
  await withRouter(["solo", codex], config, () => WEEKLY_429(reset), async ({ send }) => {
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(unifiedHeaders(res)).toEqual([]);
    await res.text();
  });
});
