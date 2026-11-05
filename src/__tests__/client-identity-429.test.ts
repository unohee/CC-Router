import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { hasClaudeCodeIdentity } from "../proxy/client-identity.js";
import { waitFor, waitForListening } from "./helpers/router-process.js";

// A bare 429 (no Retry-After, no window named, status still "allowed") for a
// request without Claude Code identity is upstream refusing that client, not
// the account running out. It is relayed and the account is left alone.
// Claude Code's own bare 429s keep the escalating cooldown. Nothing here
// touches a real account: the upstream is a scripted fake.

describe("Claude Code identity", () => {
  it("is a claude-cli user-agent or a claude-code- beta, nothing else", () => {
    expect(hasClaudeCodeIdentity({ "user-agent": "claude-cli/2.1.317 (external, cli)" })).toBe(true);
    expect(hasClaudeCodeIdentity({ "user-agent": "Claude-CLI/2.0.0" })).toBe(true);
    expect(hasClaudeCodeIdentity({ "anthropic-beta": "oauth-2025-04-20, claude-code-20250219" })).toBe(true);
    expect(hasClaudeCodeIdentity({ "anthropic-beta": ["fine-grained-tool-streaming-2025-05-14", "claude-code-20250219"] })).toBe(true);
    expect(hasClaudeCodeIdentity({ "user-agent": "omp/0.3", "anthropic-beta": "oauth-2025-04-20" })).toBe(false);
    expect(hasClaudeCodeIdentity({ "user-agent": "my-claude-cli/1.0" })).toBe(false);
    expect(hasClaudeCodeIdentity({ "anthropic-beta": "not-claude-code-x" })).toBe(false);
    expect(hasClaudeCodeIdentity({})).toBe(false);
  });
});

type Reply = { status: number; headers?: Record<string, string>; body: unknown };

const BARE_429: Reply = {
  status: 429,
  headers: { "anthropic-ratelimit-unified-status": "allowed" },
  body: { type: "error", error: { type: "rate_limit_error", message: "Error" } },
};
const STATED_429: Reply = { ...BARE_429, headers: { ...BARE_429.headers, "retry-after": "30" } };
const OK: Reply = {
  status: 200,
  headers: { "anthropic-ratelimit-unified-status": "allowed" },
  body: { id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } },
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
  send: (headers?: Record<string, string>) => Promise<Response>;
  coolingForSeconds: () => Promise<number>;
  account: () => Promise<{ errorCount?: number }>;
  logs: () => string;
  seenUserAgents: string[];
}

async function withRouter(script: Reply[], run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-identity-429-"));
  const queue = [...script];
  const seenUserAgents: string[] = [];
  const upstream: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seenUserAgents.push(String(req.headers["user-agent"] ?? ""));
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
  writeFileSync(join(dir, "config.json"), "{}");
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
  const health = async () =>
    (await (await fetch(`${base}/cc-router/health`, { signal: AbortSignal.timeout(3000) })).json()) as
      { accounts: Array<{ id: string; coolingUntil?: number; errorCount?: number }> };
  try {
    await waitForListening(child, () => logs);
    await run({
      send: (headers = {}) => fetch(`${base}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      }),
      coolingForSeconds: async () => {
        const until = (await health()).accounts.find(a => a.id === "fixture")?.coolingUntil ?? 0;
        return Math.max(0, Math.round((until - Date.now()) / 1000));
      },
      account: async () => (await health()).accounts.find(a => a.id === "fixture")!,
      logs: () => logs,
      seenUserAgents,
    });
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>(r => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const FOREIGN = { "user-agent": "omp/0.3.1" };
const CLAUDE_CODE = { "user-agent": "claude-cli/2.1.317 (external, cli)" };

describe("bare 429 by client identity, through a real router", () => {
  it.concurrent("relays a bare 429 for a request without identity and does not cool the account", async () => {
    await withRouter([BARE_429, BARE_429], async ({ send, coolingForSeconds, account, logs, seenUserAgents }) => {
      const first = await send(FOREIGN);
      expect(first.status).toBe(429);
      expect(await first.json()).toMatchObject({ error: { type: "rate_limit_error" } });
      expect(await coolingForSeconds()).toBe(0);
      // A second refusal right away still reaches upstream: nothing is cooling.
      expect((await send(FOREIGN)).status).toBe(429);
      expect(await coolingForSeconds()).toBe(0);
      // The account is not marked: no cooldown and no error on its column.
      expect((await account()).errorCount ?? 0).toBe(0);
      // And the account still serves Claude Code at once.
      expect((await send(CLAUDE_CODE)).status).toBe(200);
      await waitFor(() => logs().includes("account not cooled"), "the relay line");
      expect(logs()).toContain("relayed, account not cooled (request lacks Claude Code identity)");
      expect(logs()).toMatch(/429 bare#0 cooldown=0s/);
      // The router read the identity; it never supplied one.
      expect(seenUserAgents.slice(0, 2)).toEqual(["omp/0.3.1", "omp/0.3.1"]);
    });
  }, 30_000);

  it.concurrent("keeps the escalating cooldown for Claude Code's own bare 429", async () => {
    await withRouter([BARE_429], async ({ send, coolingForSeconds, account, logs }) => {
      expect((await send(CLAUDE_CODE)).status).toBe(429);
      const cooling = await coolingForSeconds();
      expect(cooling).toBeGreaterThanOrEqual(6);
      expect(cooling).toBeLessThanOrEqual(8);
      expect((await account()).errorCount).toBe(1);
      await waitFor(() => logs().includes("429 bare#1"), "the diagnostic line");
      expect(logs()).toContain("429 bare#1 cooldown=8s");
    });
  }, 30_000);

  it.concurrent("counts a claude-code- beta as identity too", async () => {
    await withRouter([BARE_429], async ({ send, coolingForSeconds }) => {
      expect((await send({ "user-agent": "something/1", "anthropic-beta": "claude-code-20250219" })).status).toBe(429);
      expect(await coolingForSeconds()).toBeGreaterThanOrEqual(6);
    });
  }, 30_000);

  it.concurrent("still cools on a 429 that states its wait, whoever asked", async () => {
    await withRouter([STATED_429], async ({ send, coolingForSeconds }) => {
      expect((await send(FOREIGN)).status).toBe(429);
      const cooling = await coolingForSeconds();
      expect(cooling).toBeGreaterThanOrEqual(28);
      expect(cooling).toBeLessThanOrEqual(30);
    });
  }, 30_000);
});
