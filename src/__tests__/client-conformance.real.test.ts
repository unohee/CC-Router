import { afterAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeOAuth, listen, startRouter, type RouterRun } from "./helpers/continuity-harness.js";
import { waitFor } from "./helpers/router-process.js";

// The continuity guarantee assumes that every ending the router produces while
// another seat has quota is one Claude Code itself retries. The never-cut suite
// proves the router's side with a simulated client; this one runs the REAL
// `claude` CLI, headless, through the real router, so the assumption is
// measured, not believed. Opt-in: CC_ROUTER_REAL_CLIENT=1 on a machine with
// Claude Code installed (CLAUDE_BIN overrides the lookup).
//
// Isolation, always: a throwaway CLAUDE_CONFIG_DIR, a --settings file pointing
// ANTHROPIC_BASE_URL at the local router, a dummy token, nonessential traffic
// off, and every ANTHROPIC_* / CLAUDE_* variable of the calling session removed.
// The upstream is a local fake that only accepts the router's fixture tokens;
// anything else is recorded as a leak and fails the case.

function findClaude(): string | null {
  if (process.env["CLAUDE_BIN"]) return existsSync(process.env["CLAUDE_BIN"]) ? process.env["CLAUDE_BIN"] : null;
  try {
    // `command -v` in sh finds the binary, not an interactive shell function.
    const p = execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const CLAUDE = process.env["CC_ROUTER_REAL_CLIENT"] === "1" ? findClaude() : null;
const ANSWER = "conformance-ok";
const VERIFIED_PATH = join("src", "continuity", "verified-clients.json");
const REPORT_PATH = join("docs", "continuity", "client-conformance.md");

// ─── A scripted Anthropic ───────────────────────────────────────────────────

type Fault =
  | "none" | "stall" | "break" | "cut" | "silent" | "401" | "429" | "503" | "529" | "reset" | "slow";

const FIXTURE_TOKEN = /^Bearer [a-z0-9]+\.a\d+$/;

class ScriptedUpstream {
  readonly server: Server;
  /** Stream requests seen, in order. */
  streams = 0;
  requests = 0;
  /** POST /v1/messages answered, stream or not (count_tokens excluded). */
  messages = 0;
  /** Whether a non-stream message request followed a stream one: Claude Code's fallback on a broken stream. */
  nonStreamAfterStream = false;
  leaks: string[] = [];
  /** Requests that reached the faulty seat ("seat1"). */
  badSeatHits = 0;
  /** Called when the n-th stream request arrives (before answering). */
  onStream?: (n: number) => void;
  constructor(private readonly faultFor: (seat: string, streamN: number, stream: boolean) => Fault) {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", c => { raw += c; });
      req.on("end", () => this.answer(req, res, raw));
    });
  }

  /** Answers a refusal fault; false when `fault` is not one. */
  private refuse(req: IncomingMessage, res: ServerResponse, fault: Fault): boolean {
    const send = (status: number, type: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify({ type: "error", error: { type, message: `scripted ${status}` } }));
    };
    switch (fault) {
      case "401": send(401, "authentication_error"); return true;
      case "429": send(429, "rate_limit_error", {
        "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "seven_day",
        "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 2 * 86_400), "retry-after": "7200",
      }); return true;
      case "503": send(503, "api_error"); return true;
      case "529": send(529, "overloaded_error"); return true;
      case "reset": req.socket.destroy(); return true;
      case "silent": return true;
      default: return false;
    }
  }

  private answer(req: IncomingMessage, res: ServerResponse, raw: string): void {
    this.requests++;
    const auth = String(req.headers["authorization"] ?? "");
    if (!FIXTURE_TOKEN.test(auth)) this.leaks.push(`${req.method} ${req.url} auth=${auth.slice(0, 16)}`);
    if (!String(req.url).startsWith("/v1/messages")) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
    if (String(req.url).includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":5}'); return; }
    let body: { stream?: boolean; model?: string } = {};
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    this.messages++;
    if (!body.stream && this.streams > 0) this.nonStreamAfterStream = true;
    const seat = auth.replace(/^Bearer /, "").replace(/\.a\d+$/, "");
    if (seat === "seat1") this.badSeatHits++;
    const msg = { id: "msg_c", type: "message", role: "assistant", model: body.model ?? "claude-haiku-4-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } };
    const refusal = this.faultFor(seat, this.streams + (body.stream ? 1 : 0), body.stream === true);
    if (!body.stream && this.refuse(req, res, refusal)) return;
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" });
      res.end(JSON.stringify({ ...msg, content: [{ type: "text", text: ANSWER }], stop_reason: "end_turn" }));
      return;
    }
    const n = ++this.streams;
    this.onStream?.(n);
    const fault = this.faultFor(seat, n, true);
    if (this.refuse(req, res, fault)) return;
    res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-status": "allowed" });
    const ev = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    ev("message_start", { type: "message_start", message: msg });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    const finish = () => {
      if (res.destroyed) return;
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANSWER } });
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
      ev("message_stop", { type: "message_stop" });
      res.end();
    };
    if (fault === "none") { finish(); return; }
    if (fault === "slow") {
      // A turn that streams for about three seconds, long enough to reload or crash under.
      let i = 0;
      const tick = () => {
        if (res.destroyed) return;
        if (i++ < 10) { ev("ping", { type: "ping" }); setTimeout(tick, 300); } else finish();
      };
      tick();
      return;
    }
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial " } });
    if (fault === "break") setTimeout(() => res.socket?.destroy(), 50);
    if (fault === "cut") setTimeout(() => res.end(), 50);
    // "stall": silence on an open socket.
  }
}

// ─── Running the real client ────────────────────────────────────────────────

interface ClientRun { code: number | null; stdout: string; stderr: string; ms: number }

async function runClaude(base: string): Promise<ClientRun> {
  const cfg = mkdtempSync(join(tmpdir(), "cc-conformance-cfg-"));
  const settings = join(cfg, "settings.json");
  writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "conformance-dummy" } }));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE)/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "conformance-dummy",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
  });
  const started = Date.now();
  try {
    return await new Promise<ClientRun>(resolve => {
      const child = spawn(CLAUDE!, ["-p", "Reply with one word.", "--settings", settings, "--model", "claude-haiku-4-5"], {
        cwd: cfg, env, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", b => { stdout += b; });
      child.stderr.on("data", b => { stderr += b; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
      child.on("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
    });
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
}

// ─── The cases ──────────────────────────────────────────────────────────────

interface CaseResult { name: string; ending: string; passed: boolean; retriedAs: string }
const results: CaseResult[] = [];
let version = "";

const SEATS = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `seat${i + 1}`, expiresAt: Date.now() + 8 * 3_600_000 }));
const GUARD = { CC_ROUTER_STREAM_IDLE_MS: "800", CC_ROUTER_FIRST_BYTE_MS: "1500" };

describe.skipIf(!CLAUDE)("the real Claude Code client through the router", { timeout: 300_000 }, () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of cleanup.splice(0)) await c().catch(() => {});
    writeArtifacts();
  });

  /**
   * The scripted upstream, plus a local OAuth server the router must refresh
   * against: without it a refresh (after a 401, say) would go to claude.ai.
   * `env` carries both the guard limits and the OAuth address.
   */
  async function upstreamFor(faultFor: (seat: string, n: number, stream: boolean) => Fault): Promise<{ up: ScriptedUpstream; port: number; env: Record<string, string> }> {
    const up = new ScriptedUpstream(faultFor);
    const port = await listen(up.server);
    const oauth = new FakeOAuth(8 * 3600);
    const oauthPort = await listen(oauth.server);
    cleanup.push(async () => {
      for (const srv of [up.server, oauth.server]) { srv.closeAllConnections(); await new Promise<void>(r => srv.close(() => r())); }
    });
    return { up, port, env: { ...GUARD, CC_ROUTER_OAUTH_TOKEN_URL: `http://127.0.0.1:${oauthPort}/v1/oauth/token` } };
  }
  const track = (r: RouterRun) => { cleanup.push(() => r.stop()); return r; };

  /** Runs the client and records the case: it must exit 0 with the answer, and nothing may leak. */
  async function expectAnswered(
    name: string, ending: string, base: string, up: ScriptedUpstream, opts: { absorbed?: boolean } = {},
  ): Promise<ClientRun> {
    const run = await runClaude(base);
    const passed = run.code === 0 && run.stdout.includes(ANSWER) && up.leaks.length === 0;
    const retriedAs = opts.absorbed ? "none: the router retried on another seat"
      : up.messages < 2 ? "none needed"
      : up.nonStreamAfterStream ? "non-stream request" : "stream request";
    results.push({ name, ending, passed, retriedAs });
    expect(up.leaks).toEqual([]);
    expect({ code: run.code, out: run.stdout.trim().slice(-200), err: run.stderr.trim().slice(-400) }).toMatchObject({ code: 0 });
    expect(run.stdout).toContain(ANSWER);
    return run;
  }

  it("knows which client it is testing", () => {
    version = execFileSync(CLAUDE!, ["--version"], { encoding: "utf8", env: { ...process.env, DISABLE_AUTOUPDATER: "1" } }).trim().split(/\s+/)[0]!;
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  // Endings the stream guard produces after the first byte: overloaded_error.
  for (const [fault, ending] of [
    ["stall", "stream went silent → overloaded_error event"],
    ["break", "stream broke → overloaded_error event"],
    ["cut", "stream ended without message_stop → overloaded_error event"],
  ] as const) {
    it(`retries after: ${ending}`, async () => {
      // seat1 breaks every stream it serves; seat2 is healthy. Without the
      // router's ending AND its cooldown, the client's retry would be pinned
      // straight back onto seat1.
      const { up, port, env } = await upstreamFor((seat, _n, stream) => (seat === "seat1" && stream ? fault : "none"));
      const r = track(await startRouter({ mode: "standalone", upstreamPort: port, seats: SEATS(2), env }));
      await expectAnswered(`mid-stream ${fault}`, ending, r.base, up);
      expect(up.badSeatHits).toBeGreaterThanOrEqual(1);
      // The client asked again (Claude Code may fall back to a non-stream request).
      expect(up.messages).toBeGreaterThanOrEqual(2);
    });
  }

  // Refusals the router absorbs before the first byte: the client never sees them.
  for (const [fault, ending] of [
    ["silent", "no headers within the first-byte limit → failed over"],
    ["401", "401 from one seat → failed over"],
    ["429", "weekly 429 from one seat → failed over"],
    ["503", "503 from one seat → failed over"],
    ["529", "529 from one seat → failed over"],
    ["reset", "connection reset before headers → failed over"],
  ] as const) {
    it(`never notices: ${ending}`, async () => {
      // seat1 refuses everything; seat2 has quota. Only failover gets the client an answer.
      const { up, port, env } = await upstreamFor(seat => (seat === "seat1" ? fault : "none"));
      const r = track(await startRouter({ mode: "standalone", upstreamPort: port, seats: SEATS(2), env }));
      await expectAnswered(`refusal ${fault}`, ending, r.base, up, { absorbed: true });
      expect(up.badSeatHits).toBeGreaterThanOrEqual(1);
    });
  }

  it("waits out the router's own short Retry-After 429 (a stalled seat sitting out its cooldown)", async () => {
    // One seat: after its stall it cools for 30 s, so the retry meets the
    // router's 429 with Retry-After ≤ 30 and must wait, then succeed.
    const { up, port, env } = await upstreamFor((_seat, n, stream) => (stream && n === 1 ? "stall" : "none"));
    const r = track(await startRouter({ mode: "standalone", upstreamPort: port, seats: SEATS(1), env }));
    const run = await expectAnswered("stall cooldown hold", "router 429, Retry-After ≤ 30 s → client waits", r.base, up);
    expect(run.ms).toBeGreaterThan(20_000);
  });

  it("finishes a streaming turn that a reload happens under", async () => {
    const { up, port, env } = await upstreamFor((_seat, _n, stream) => (stream ? "slow" : "none"));
    const r = track(await startRouter({ mode: "supervised", upstreamPort: port, seats: SEATS(2), env: { ...env, CC_ROUTER_DRAIN_LIMIT_MS: "20000" } }));
    await waitFor(async () => (await r.health()).supervisor?.generation === 1, "the first worker");
    up.onStream = n => { if (n === 1) process.kill(r.child.pid!, "SIGHUP"); };
    await expectAnswered("reload mid-turn", "reload: old worker drains, new one takes over", r.base, up);
    await waitFor(async () => (await r.health()).supervisor?.lastHandoff != null, "the drain report", 30_000);
    expect((await r.health()).supervisor?.lastHandoff?.dropped).toBe(0);
    expect(up.streams).toBe(1);
  });

  it("recovers from a worker crash in the middle of a turn", async () => {
    const { up, port, env } = await upstreamFor((_seat, n, stream) => (stream && n === 1 ? "slow" : "none"));
    const r = track(await startRouter({ mode: "supervised", upstreamPort: port, seats: SEATS(2), env }));
    await waitFor(async () => (await r.health()).supervisor?.generation === 1, "the first worker");
    const workerPid = (await r.health()).worker.pid;
    up.onStream = n => { if (n === 1) setTimeout(() => process.kill(workerPid, "SIGKILL"), 200); };
    await expectAnswered("worker crash", "worker killed mid-stream → connection reset, ~1 s refused", r.base, up);
    expect(up.messages).toBeGreaterThanOrEqual(2);
  });

  it("recovers from a stop and a start, with a stream cut at the drain limit", async () => {
    const { up, port, env } = await upstreamFor((_seat, n, stream) => (stream && n === 1 ? "slow" : "none"));
    const first = await startRouter({ mode: "standalone", upstreamPort: port, seats: SEATS(2), env: { ...env, CC_ROUTER_DRAIN_LIMIT_MS: "300" } });
    const routerPort = Number(new URL(first.base).port);
    let second: RouterRun | undefined;
    cleanup.push(() => first.stop());
    cleanup.push(async () => { await second?.stop(); });
    up.onStream = n => {
      if (n !== 1) return;
      first.child.kill("SIGTERM");
      void first.exited().then(async () => {
        second = await startRouter({ mode: "standalone", upstreamPort: port, seats: SEATS(2), env, port: routerPort });
      });
    };
    await expectAnswered("stop then start", "drain limit → overloaded_error; port closed ~1 s; new router", first.base, up);
    expect(second).toBeDefined();
  });
});

/** Writes the report and the verified-versions list, only when every case passed. */
function writeArtifacts(): void {
  if (!CLAUDE || !version || results.length === 0 || results.some(r => !r.passed)) return;
  type Verified = { verified: { version: string; cases: number; firstVerified: string }[] };
  let data: Verified = { verified: [] };
  try { data = JSON.parse(readFileSync(VERIFIED_PATH, "utf8")) as Verified; } catch { /* first run */ }
  const existing = data.verified.find(v => v.version === version);
  if (existing) existing.cases = results.length;
  else data.verified.push({ version, cases: results.length, firstVerified: new Date().toISOString().slice(0, 10) });
  data.verified.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  mkdirSync(dirname(VERIFIED_PATH), { recursive: true });
  writeFileSync(VERIFIED_PATH, JSON.stringify(data, null, 2) + "\n");

  // No timings or attempt counts: the report must not change between identical runs.
  const rows = results.map(r => `| ${r.name} | ${r.ending} | ${r.retriedAs} | answered |`).join("\n");
  const versions = data.verified.map(v => `- ${v.version} (${v.cases} cases, first verified ${v.firstVerified})`).join("\n");
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `# Client conformance: does the real Claude Code survive every ending the router produces?

Generated by \`src/__tests__/client-conformance.real.test.ts\` (\`CC_ROUTER_REAL_CLIENT=1 npx vitest run src/__tests__/client-conformance.real.test.ts\`).
"Client's retry" is how the client asked again after meeting the ending, or why it did not have to.
Each case runs the installed \`claude -p\` headless, with an isolated config directory, through the real router to a
local fake upstream that injects one fault, and passes only when the client exits 0 with the expected answer.
No real account or live router is involved.

## Last run: Claude Code ${version}

| Case | What the client met | Client's retry | Result |
|---|---|---|---|
${rows}

## Verified versions

${versions}

A version not listed here has not been through this suite. Health reports the client versions the router serves.

## Notes from building this suite (Claude Code 2.1.327, 2026-11-19)

- After a stream breaks, the client asks again with a **non-stream** request; the router serves it like any other.
- A stream that simply ends without \`message_stop\` is also retried by this version, with or without the
  router's \`overloaded_error\` event. The event stays: it is the documented way to say "retry", and it does not
  depend on how a given version treats a half stream.
- With one seat refusing every request and failover off for that status, the client never got an answer (the case
  timed out at 150 s). Failover, not the client's own retries, is what keeps a session alive while one seat fails.
- Faults are injected on one seat for every request, with the other seat healthy: a fault on the first attempt
  only is hidden by the client's own retry and proves nothing about the router.
`);
}
