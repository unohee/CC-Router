import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  FakeOAuth, isCompleteStream, listen, readStream, sendMessage, sseEvents, startRouter, type RouterRun,
} from "./helpers/continuity-harness.js";
import { waitFor } from "./helpers/router-process.js";

// The continuity guarantee, end to end: while another seat has quota, every
// client request either completes or ends in a form Claude Code retries
// (an overloaded_error, a 529). Never a relayed 401 or 5xx, a reset, a hang or a
// silently cut answer. Each fault runs through the real router; the reload and
// stop cases run through the real supervisor.

// ─── A misbehaving Anthropic ────────────────────────────────────────────────

type Fault =
  | "ok" | "slow" | "weekly-429" | "500" | "503" | "529" | "401"
  | "reset" | "silent" | "stall" | "break" | "cut";

const CHUNKS = 8;
const seatOf = (token: string) => token.replace(/\.[ar]\d+$/, "");

interface Hit { seat: string; stream: boolean; fault: Fault }

class ChaosUpstream {
  readonly server: Server;
  readonly hits: Hit[] = [];
  private readonly counts = new Map<string, number>();
  constructor(private readonly fault: (seat: string, n: number, stream: boolean) => Fault) {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", c => { raw += c; });
      req.on("end", () => this.answer(req, res, raw));
    });
  }

  private answer(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const seat = seatOf(String(req.headers["authorization"] ?? "").replace(/^Bearer /, ""));
    let stream = false;
    try { stream = JSON.parse(raw).stream === true; } catch { /* not JSON */ }
    const n = (this.counts.get(seat) ?? 0) + 1;
    this.counts.set(seat, n);
    const fault = this.fault(seat, n, stream);
    this.hits.push({ seat, stream, fault });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const apiError = (type: string) => ({ type: "error", error: { type, message: `chaos ${fault}` } });
    switch (fault) {
      case "weekly-429":
        return json(429, apiError("rate_limit_error"), {
          "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "seven_day",
          "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 2 * 86_400), "retry-after": "7200",
        });
      case "500": return json(500, apiError("api_error"));
      case "503": return json(503, apiError("api_error"));
      case "529": return json(529, apiError("overloaded_error"));
      case "401": return json(401, apiError("authentication_error"));
      case "reset": req.socket.destroy(); return;
      case "silent": return; // headers never come
      default: break;
    }
    if (!stream) {
      return json(200, { id: "msg_j", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } },
        { "anthropic-ratelimit-unified-status": "allowed" });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-status": "allowed" });
    const events = sseEvents(CHUNKS);
    if (fault === "ok") { res.end(events.join("")); return; }
    if (fault === "slow") {
      let i = 0;
      const tick = () => { if (res.destroyed) return; res.write(events[i++]); if (i < events.length) setTimeout(tick, 120); else res.end(); };
      tick();
      return;
    }
    res.write(events.slice(0, 3).join(""));
    if (fault === "break") setTimeout(() => res.socket?.destroy(), 30);
    if (fault === "cut") setTimeout(() => res.end(), 30);
    // "stall": first events, then silence on an open socket.
  }
}

// ─── What the client saw ────────────────────────────────────────────────────

type Outcome = "ok" | "retryable" | `failure: ${string}`;

/** Sends one Claude Code-like request and classifies how it ended for the client. */
async function outcomeOf(base: string, opts: { stream: boolean; session: string }): Promise<Outcome> {
  let res: Response;
  try {
    res = await sendMessage(base, { ...opts, timeoutMs: 20_000 });
  } catch (err) {
    return `failure: ${(err as Error).name === "TimeoutError" ? "hang" : "connection"}`;
  }
  if (res.status === 529) {
    const body = await res.json().catch(() => null) as { error?: { type?: string } } | null;
    return body?.error?.type === "overloaded_error" ? "retryable" : "failure: 529 without overloaded_error";
  }
  if (res.status !== 200) return `failure: HTTP ${res.status}`;
  if (!opts.stream) {
    const body = await res.json().catch(() => null) as { type?: string } | null;
    return body?.type === "message" ? "ok" : "failure: bad JSON body";
  }
  const { text, broken } = await readStream(res);
  if (broken) return "failure: stream reset";
  if (isCompleteStream(text, CHUNKS)) return "ok";
  if (text.includes("event: error") && text.includes('"overloaded_error"')) return "retryable";
  return "failure: stream cut silently";
}

/** What Claude Code does with a retryable answer: send it again, same session. */
async function withRetries(base: string, opts: { stream: boolean; session: string }, tries = 3): Promise<Outcome[]> {
  const seen: Outcome[] = [];
  for (let i = 0; i < tries; i++) {
    const o = await outcomeOf(base, opts);
    seen.push(o);
    if (o !== "retryable") break;
  }
  return seen;
}

const failures = (outcomes: Outcome[]) => outcomes.filter(o => o.startsWith("failure"));

// ─── The suite ──────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const GUARD_ENV = { CC_ROUTER_FIRST_BYTE_MS: "600", CC_ROUTER_STREAM_IDLE_MS: "600" };

describe("never cut while another seat has quota", { timeout: 120_000 }, () => {
  let router: RouterRun | undefined;
  let up: ChaosUpstream | undefined;
  let oauth: FakeOAuth | undefined;
  afterEach(async () => {
    await router?.stop();
    for (const s of [up?.server, oauth?.server]) {
      if (!s) continue;
      s.closeAllConnections();
      await new Promise<void>(r => s.close(() => r()));
    }
    router = up = oauth = undefined;
  });

  async function boot(opts: {
    seats: string[];
    fault: (seat: string, n: number, stream: boolean) => Fault;
    mode?: "standalone" | "supervised";
    dead?: string[];
    env?: Record<string, string>;
  }): Promise<RouterRun> {
    oauth = new FakeOAuth(8 * 3600);
    for (const d of opts.dead ?? []) oauth.dead.add(d);
    const oauthPort = await listen(oauth.server);
    up = new ChaosUpstream(opts.fault);
    const upstreamPort = await listen(up.server);
    router = await startRouter({
      mode: opts.mode ?? "standalone", upstreamPort,
      // Dead seats sit inside the lead window, so the first refresh finds them dead.
      seats: opts.seats.map(id => ({ id, expiresAt: Date.now() + ((opts.dead ?? []).includes(id) ? 2 : 8) * HOUR })),
      config: { tokenRefresh: { leadMinutes: 240 } },
      env: { CC_ROUTER_OAUTH_TOKEN_URL: `http://127.0.0.1:${oauthPort}/v1/oauth/token`, CC_ROUTER_DRAIN_LIMIT_MS: "20000", ...GUARD_ENV, ...opts.env },
    });
    if (opts.mode === "supervised") {
      const r = router;
      await waitFor(async () => (await r.health()).supervisor?.generation === 1, "the first worker");
    }
    return router;
  }

  /**
   * Sends `n` requests at once, alternating stream and non-stream, each in its
   * own session and retried like Claude Code. `all` is every answer seen,
   * `finals` the last one per request.
   */
  async function burst(r: RouterRun, n: number, prefix: string): Promise<{ all: Outcome[]; finals: Outcome[] }> {
    const per = await Promise.all(Array.from({ length: n }, (_, i) =>
      withRetries(r.base, { stream: i % 2 === 0, session: `${prefix}-${i}` })));
    return { all: per.flat(), finals: per.map(p => p[p.length - 1]!) };
  }

  const refusals: [string, Fault][] = [
    ["a weekly 429 on one seat", "weekly-429"],
    ["a 500 on one seat", "500"],
    ["a 503 on one seat", "503"],
    ["a 529 on one seat", "529"],
    ["a revoked token (401) on one seat", "401"],
    ["a connection reset before headers on one seat", "reset"],
    ["no headers at all on one seat", "silent"],
  ];
  for (const [name, fault] of refusals) {
    it(`${name}: every request is answered by another seat`, async () => {
      const r = await boot({ seats: ["bad", "good"], fault: seat => (seat === "bad" ? fault : "ok") });
      const { all } = await burst(r, 8, fault);
      expect(failures(all)).toEqual([]);
      expect(all.every(o => o === "ok")).toBe(true);
      expect(up!.hits.some(h => h.seat === "bad")).toBe(true);
    });
  }

  it("a refresh token refused with invalid_grant: no client sees a 401", async () => {
    const r = await boot({
      seats: ["dead", "good"], dead: ["dead"],
      // The dead seat's access token is also revoked upstream.
      fault: seat => (seat === "dead" ? "401" : "ok"),
    });
    await waitFor(async () => (await r.health()).accounts.find(a => a.id === "dead")?.auth.state === "needs-relogin", "the dead seat to be marked");
    const { all } = await burst(r, 8, "grant");
    expect(failures(all)).toEqual([]);
    expect(all.every(o => o === "ok")).toBe(true);
  });

  for (const fault of ["stall", "break", "cut"] as const) {
    it(`a stream that ${fault}s after its first byte ends retryably, and the retry is answered`, async () => {
      // The faulty seat misbehaves on streams only; its retry must land elsewhere.
      const r = await boot({ seats: ["bad", "good"], fault: (seat, _n, stream) => (seat === "bad" && stream ? fault : "ok") });
      const { all, finals } = await burst(r, 8, fault);
      expect(failures(all)).toEqual([]);
      expect(all).toContain("retryable");
      // Every request ended "ok" in the end: its retry did not meet the same fault.
      expect(finals.every(o => o === "ok")).toBe(true);
    });
  }

  it("mixed chaos across three seats while one stays healthy", async () => {
    // A seeded mix of every fault on two seats; the third always answers.
    let seed = 7;
    const rand = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    const pool: Fault[] = ["ok", "slow", "weekly-429", "500", "503", "529", "401", "reset", "silent", "stall", "break", "cut"];
    const r = await boot({
      seats: ["x", "y", "z"],
      fault: seat => (seat === "z" ? "ok" : pool[Math.floor(rand() * pool.length)]!),
    });
    const { all, finals } = await burst(r, 24, "mix");
    expect(failures(all)).toEqual([]);
    expect(finals.every(o => o === "ok")).toBe(true);
  });

  it("a reload during streams drops nothing, and a stop drains them", async () => {
    const r = await boot({ seats: ["lyra", "vega"], fault: (_seat, _n, stream) => (stream ? "slow" : "ok"), mode: "supervised" });
    // Streams in flight across a reload.
    const inFlight = Array.from({ length: 4 }, (_, i) => outcomeOf(r.base, { stream: true, session: `reload-${i}` }));
    await waitFor(() => up!.hits.length >= 4, "the streams to start");
    process.kill(r.child.pid!, "SIGHUP");
    await waitFor(async () => (await r.health()).supervisor?.generation === 2, "the new worker", 30_000);
    // New work meanwhile, on the new worker.
    const during = burst(r, 4, "during");
    expect(await Promise.all(inFlight)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(failures((await during).all)).toEqual([]);
    await waitFor(async () => (await r.health()).supervisor?.lastHandoff != null, "the drain report", 30_000);
    expect((await r.health()).supervisor?.lastHandoff?.dropped).toBe(0);

    // A stop with streams in flight: they finish before anything exits.
    const stopping = Array.from({ length: 3 }, (_, i) => outcomeOf(r.base, { stream: true, session: `stop-${i}` }));
    const before = up!.hits.length;
    await waitFor(() => up!.hits.length >= before + 3, "the streams to start");
    r.child.kill("SIGTERM");
    expect(await Promise.all(stopping)).toEqual(["ok", "ok", "ok"]);
    expect(await r.exited()).toBe(0);
  });

  it("without the stream guard the same stall would hang: the suite can tell", async () => {
    // A control: with the idle guard off, a stalled stream is not answered
    // within the client's patience. If this ever passes as "ok", the
    // classifier above has stopped telling a hang from an answer.
    const r = await boot({ seats: ["only"], fault: (_s, _n, stream) => (stream ? "stall" : "ok"), env: { CC_ROUTER_STREAM_IDLE_MS: "0" } });
    let res: Response | undefined;
    const outcome = await Promise.race([
      sendMessage(r.base, { stream: true, session: "control" }).then(async x => { res = x; return (await readStream(x)).text; }),
      new Promise<"hang">(resolve => setTimeout(() => resolve("hang"), 2_500)),
    ]);
    expect(outcome).toBe("hang");
    void res?.body?.cancel().catch(() => {});
  });
});
