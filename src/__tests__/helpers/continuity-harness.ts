/**
 * A fake Anthropic upstream, a fake OAuth server that rotates tokens like the
 * real one, and helpers to run a real router (standalone or supervised) against
 * them. Used by the continuity tests: drain, handoff, and the chaos suite.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { waitFor } from "./router-process.js";

export async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

export async function freePort(): Promise<number> {
  const s = createServer();
  const port = await listen(s);
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

// ─── Tokens ─────────────────────────────────────────────────────────────────
// Access tokens are "<id>.a<n>", refresh tokens "<id>.r<n>": the fakes can tell
// which seat a token belongs to and whether it is the latest one issued.

export const accessOf = (id: string, n: number) => `${id}.a${n}`;
export const refreshOf = (id: string, n: number) => `${id}.r${n}`;
const seatOf = (token: string) => token.replace(/\.[ar]\d+$/, "");
const genOf = (token: string) => Number(/\.[ar](\d+)$/.exec(token)?.[1] ?? -1);

/**
 * OAuth like Anthropic's: each refresh token works once and is replaced. A
 * refresh token used twice gets invalid_grant and is counted as a reuse: the
 * failure two writers of accounts.json would cause.
 */
export class FakeOAuth {
  readonly server: Server;
  /** Latest generation issued per seat. */
  readonly latest = new Map<string, number>();
  calls = 0;
  reuses = 0;
  constructor(private readonly expiresInSec: number) {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", c => { raw += c; });
      req.on("end", () => {
        this.calls++;
        const params = new URLSearchParams(raw);
        const token = params.get("refresh_token") ?? JSON.parse(raw || "{}").refresh_token ?? "";
        const id = seatOf(token);
        const gen = genOf(token);
        if (gen !== (this.latest.get(id) ?? 0)) {
          this.reuses++;
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }));
          return;
        }
        const next = gen + 1;
        this.latest.set(id, next);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          access_token: accessOf(id, next), refresh_token: refreshOf(id, next),
          expires_in: this.expiresInSec, scope: "user:inference", token_type: "Bearer",
        }));
      });
    });
  }
}

// ─── Upstream ───────────────────────────────────────────────────────────────

export interface UpstreamRequest { seat: string; token: string; stream: boolean; session: string }

/** SSE for one message whose text arrives as `chunks` deltas, `gapMs` apart. */
export function sseEvents(chunks: number): string[] {
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  ];
  for (let i = 0; i < chunks; i++) {
    events.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `part${i} ` } })}\n\n`);
  }
  events.push(
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: chunks } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  );
  return events;
}

/**
 * Anthropic, as far as the router can tell. Streams when the request asks to,
 * `chunks` deltas `gapMs` apart. When `oauth` is given, only the latest access
 * token of a seat is accepted; an older one gets 401 (and is counted).
 */
export class FakeUpstream {
  readonly server: Server;
  readonly seen: UpstreamRequest[] = [];
  staleTokens = 0;
  constructor(opts: { chunks?: number; gapMs?: number; oauth?: FakeOAuth } = {}) {
    const chunks = opts.chunks ?? 10;
    const gapMs = opts.gapMs ?? 150;
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", c => { raw += c; });
      req.on("end", () => {
        const token = String(req.headers["authorization"] ?? "").replace(/^Bearer /, "");
        let stream = false;
        try { stream = JSON.parse(raw).stream === true; } catch { /* not JSON */ }
        this.seen.push({ seat: seatOf(token), token, stream, session: String(req.headers["x-claude-code-session-id"] ?? "") });
        if (opts.oauth && genOf(token) !== (opts.oauth.latest.get(seatOf(token)) ?? 0)) {
          this.staleTokens++;
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "stale token" } }));
          return;
        }
        if (!stream) {
          res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" });
          res.end(JSON.stringify({ id: "msg_j", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-status": "allowed" });
        const events = sseEvents(chunks);
        let i = 0;
        const tick = () => {
          if (res.destroyed) return;
          res.write(events[i++]);
          if (i < events.length) setTimeout(tick, gapMs);
          else res.end();
        };
        tick();
      });
    });
  }
}

// ─── The router ─────────────────────────────────────────────────────────────

export interface RouterRun {
  child: ChildProcess;
  base: string;
  dir: string;
  logs: () => string;
  health: () => Promise<Health>;
  /** Waits for the process to exit; resolves its exit code. */
  exited: () => Promise<number | null>;
  stop: () => Promise<void>;
}

export interface Health {
  build?: { sha: string | null };
  inFlight: { requests: number; served: number };
  worker: { pid: number; draining: boolean; frozen: boolean };
  supervisor: null | {
    supervised: true; supervisorPid: number; generation: number; failedReloads: number;
    lastHandoff: null | { generation: number; fromPid: number; toPid: number; finished: number; dropped: number; unsaved: number };
  };
  accounts: { id: string; healthy: boolean; auth: { state: string } }[];
}

export interface RouterOpts {
  /** "standalone": startServer directly. "supervised": `cc-router supervise` through the CLI. */
  mode: "standalone" | "supervised";
  upstreamPort: number;
  seats: { id: string; expiresAt: number; gen?: number }[];
  config?: Record<string, unknown>;
  env?: Record<string, string>;
}

export async function startRouter(opts: RouterOpts): Promise<RouterRun> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-continuity-"));
  writeFileSync(join(dir, "accounts.json"), JSON.stringify(opts.seats.map(s => ({
    id: s.id, accessToken: accessOf(s.id, s.gen ?? 0), refreshToken: refreshOf(s.id, s.gen ?? 0),
    expiresAt: s.expiresAt, scopes: [], enabled: true,
  }))));
  writeFileSync(join(dir, "config.json"), JSON.stringify(opts.config ?? {}));
  const port = await freePort();
  const upstream = `http://127.0.0.1:${opts.upstreamPort}`;
  const args = opts.mode === "standalone"
    ? ["--import", "tsx", "--input-type=module", "-e",
      `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'${upstream}'});`]
    : ["--import", "tsx", join(dir, "release", "cli", "index.ts"), "supervise", "--port", String(port), `--litellm=${upstream}`];
  // Like a host's `current` symlink: workers start from whatever it points at
  // when they are forked, so a test can swap in a broken release.
  if (opts.mode === "supervised") symlinkSync(resolve("src"), join(dir, "release"));
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
      ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"),
      SESSIONS_PATH: join(dir, "sessions.json"),
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so a test can stop the supervisor and its workers
    // together: cluster workers outlive a killed primary.
    detached: true,
  });
  let logs = "";
  child.stdout!.on("data", b => { logs += b; });
  child.stderr!.on("data", b => { logs += b; });
  const base = `http://127.0.0.1:${port}`;
  const health = async () => (await fetch(`${base}/cc-router/health`, { signal: AbortSignal.timeout(3000) })).json() as Promise<Health>;
  const exitPromise = once(child, "exit").then(([code]) => code as number | null);
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`router exited during startup:\n${logs}`);
    try { await health(); return true; } catch { return false; }
  }, "the router to answer health", 30_000);
  return {
    child, base, dir, logs: () => logs, health,
    exited: () => exitPromise,
    stop: async () => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
      await Promise.race([exitPromise, new Promise(r => setTimeout(r, 3000))]);
      // rmSync unlinks the `release` symlink; it does not follow it into src/.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** A Claude Code-like /v1/messages call. */
export function sendMessage(base: string, opts: { stream?: boolean; session?: string; timeoutMs?: number } = {}): Promise<Response> {
  return fetch(`${base}/v1/messages`, {
    method: "POST", signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    headers: {
      "content-type": "application/json", "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2.1.317 (external, cli)",
      ...(opts.session ? { "x-claude-code-session-id": opts.session } : {}),
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 64, stream: opts.stream === true, messages: [{ role: "user", content: "hi" }] }),
  });
}

/**
 * Reads a streaming response, calling `onFirstChunk` once the first bytes
 * arrive. Resolves the whole text, or what arrived before the stream broke.
 */
export async function readStream(res: Response, onFirstChunk?: () => void): Promise<{ text: string; broken: boolean }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let first = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (first) { first = false; onFirstChunk?.(); }
    }
    return { text, broken: false };
  } catch {
    return { text, broken: true };
  }
}

/** True when an SSE body is a complete message: every delta and message_stop, no error event. */
export function isCompleteStream(text: string, chunks: number): boolean {
  if (!text.includes('"type":"message_stop"')) return false;
  if (text.includes("event: error")) return false;
  for (let i = 0; i < chunks; i++) if (!text.includes(`part${i} `)) return false;
  return true;
}
