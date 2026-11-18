import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  DEFAULT_FIRST_BYTE_MS, DEFAULT_STREAM_IDLE_MS, OVERLOADED_EVENT, isFirstByteTimeout, FirstByteTimeoutError, resolveStreamGuard,
} from "../proxy/stream-guard.js";
import { isCompleteStream, listen, readStream, sendMessage, sseEvents, startRouter, type RouterRun } from "./helpers/continuity-harness.js";
import { waitFor } from "./helpers/router-process.js";

// An upstream that goes quiet must not leave Claude Code hanging. Before the
// first byte the next seat answers; after it, the stream ends with an
// overloaded_error event the client retries, never a hang or a silent cut.

describe("stream guard config", () => {
  it("defaults to 120 s before the first byte and 180 s of silence after it", () => {
    expect(resolveStreamGuard(undefined, {})).toEqual({ firstByteMs: DEFAULT_FIRST_BYTE_MS, idleMs: DEFAULT_STREAM_IDLE_MS });
    expect(DEFAULT_FIRST_BYTE_MS).toBe(120_000);
    expect(DEFAULT_STREAM_IDLE_MS).toBe(180_000);
  });

  it("reads seconds from config, ms from the environment, and 0 disables", () => {
    expect(resolveStreamGuard({ firstByteSeconds: 30, idleSeconds: 0 }, {})).toEqual({ firstByteMs: 30_000, idleMs: 0 });
    expect(resolveStreamGuard({ firstByteSeconds: 30 }, { CC_ROUTER_FIRST_BYTE_MS: "250", CC_ROUTER_STREAM_IDLE_MS: "400" }))
      .toEqual({ firstByteMs: 250, idleMs: 400 });
    expect(resolveStreamGuard({ firstByteSeconds: "soon", idleSeconds: -1 }, {}))
      .toEqual({ firstByteMs: DEFAULT_FIRST_BYTE_MS, idleMs: DEFAULT_STREAM_IDLE_MS });
  });

  it("names its own timeout error", () => {
    expect(isFirstByteTimeout(new FirstByteTimeoutError(1000))).toBe(true);
    expect(isFirstByteTimeout(new Error("socket hang up"))).toBe(false);
  });

  it("writes an Anthropic-format overloaded_error after a blank line", () => {
    expect(OVERLOADED_EVENT.startsWith("\n\nevent: error\ndata: ")).toBe(true);
    expect(JSON.parse(OVERLOADED_EVENT.split("data: ")[1]!)).toMatchObject({ type: "error", error: { type: "overloaded_error" } });
  });
});

// ─── Through a real router ──────────────────────────────────────────────────

type Behaviour = "silent" | "stall" | "break" | "cut" | "ok" | "slow" | "json-late";

interface Seen { seat: string; stream: boolean; closedEarly: boolean }

const seatOf = (token: string) => token.replace(/\.[ar]\d+$/, "");

/** Each seat behaves as `behave(seat)` says, for stream requests and plain ones alike. */
function upstream(behave: (seat: string) => Behaviour): { server: Server; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const seat = seatOf(String(req.headers["authorization"] ?? "").replace(/^Bearer /, ""));
      const stream = JSON.parse(raw).stream === true;
      const entry: Seen = { seat, stream, closedEarly: false };
      seen.push(entry);
      res.on("close", () => { if (!res.writableFinished) entry.closedEarly = true; });
      const b = behave(seat);
      if (b === "silent") return; // never answers; the socket stays open
      if (b === "json-late") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "msg_j", type: "message", role: "assistant", content: [{ type: "text", text: "late" }], usage: { input_tokens: 1, output_tokens: 1 } }));
        }, 800);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-status": "allowed" });
      const events = sseEvents(6);
      if (b === "ok") { res.end(events.join("")); return; }
      if (b === "slow") {
        // Alive but slow: every gap is under the idle limit.
        let i = 0;
        const tick = () => { if (res.destroyed) return; res.write(events[i++]); if (i < events.length) setTimeout(tick, 250); else res.end(); };
        tick();
        return;
      }
      res.write(events.slice(0, 3).join(""));
      if (b === "stall") return; // first events, then silence on an open socket
      if (b === "break") { setTimeout(() => res.socket?.destroy(), 50); return; }
      if (b === "cut") { setTimeout(() => res.end(), 50); return; } // ends cleanly, no message_stop
    });
  });
  return { server, seen };
}

interface GuardHealth {
  streamGuard: { firstByteMs: number; idleMs: number; firstByteTimeouts: number; stalled: number; broken: number; truncated: number };
  failover: { byReason: Record<string, number>; byOutcome: Record<string, number> };
}

describe("a real router with a misbehaving upstream", { timeout: 60_000 }, () => {
  let router: RouterRun | undefined;
  let up: { server: Server; seen: Seen[] } | undefined;
  afterEach(async () => {
    await router?.stop();
    up?.server.closeAllConnections();
    await new Promise<void>(r => (up ? up.server.close(() => r()) : r()));
    router = up = undefined;
  });

  async function boot(seats: string[], behave: (seat: string) => Behaviour) {
    up = upstream(behave);
    const upstreamPort = await listen(up.server);
    router = await startRouter({
      mode: "standalone", upstreamPort,
      seats: seats.map(id => ({ id, expiresAt: Date.now() + 8 * 3_600_000 })),
      env: { CC_ROUTER_FIRST_BYTE_MS: "500", CC_ROUTER_STREAM_IDLE_MS: "600" },
    });
    return router;
  }
  const health = async (r: RouterRun) => (await r.health()) as unknown as GuardHealth;

  it("fails a stream over when its upstream sends no headers, and the client never knows", async () => {
    const r = await boot(["stuck", "good"], seat => (seat === "stuck" ? "silent" : "ok"));
    // Each new session is placed round-robin; send until one lands on the stuck seat first.
    for (let i = 0; i < 4; i++) {
      const res = await sendMessage(r.base, { stream: true, session: `fb${i}` });
      expect(res.status).toBe(200);
      expect(isCompleteStream((await readStream(res)).text, 6)).toBe(true);
    }
    expect(up!.seen.some(s => s.seat === "stuck")).toBe(true);
    const h = await health(r);
    expect(h.streamGuard.firstByteTimeouts).toBeGreaterThanOrEqual(1);
    expect(h.failover.byReason["timeout"]).toBe(h.streamGuard.firstByteTimeouts);
    expect(h.failover.byOutcome["recovered"]).toBe(h.streamGuard.firstByteTimeouts);
    // The abandoned upstream request was closed, not left open.
    await waitFor(() => up!.seen.filter(s => s.seat === "stuck").every(s => s.closedEarly), "the stuck request to be closed");
  });

  it("does not time out a non-stream request, whose headers come with its whole answer", async () => {
    const r = await boot(["lyra"], () => "json-late");
    const res = await sendMessage(r.base, { stream: false, session: "json" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: { text: string }[] }).content[0]!.text).toBe("late");
    expect((await health(r)).streamGuard.firstByteTimeouts).toBe(0);
  });

  for (const [behaviour, counter] of [["stall", "stalled"], ["break", "broken"], ["cut", "truncated"]] as const) {
    it(`ends a stream that ${behaviour === "stall" ? "goes silent" : behaviour === "break" ? "breaks" : "ends without message_stop"} with overloaded_error`, async () => {
      const r = await boot(["lyra"], () => behaviour);
      const startedAt = Date.now();
      const res = await sendMessage(r.base, { stream: true, session: behaviour });
      expect(res.status).toBe(200);
      const { text, broken } = await readStream(res);
      // A clean end the client can read, not a hang or a reset.
      expect(broken).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(text).toContain("part0 ");
      expect(text).toContain("event: error");
      expect(text).toContain('"overloaded_error"');
      expect(text).not.toContain('"message_stop"');
      const h = await health(r);
      expect(h.streamGuard[counter]).toBe(1);
      expect(r.logs()).toMatch(/ended with overloaded_error so the client retries/);
    });
  }

  it("leaves a healthy stream untouched, and a slow one that is still alive", async () => {
    const r = await boot(["lyra"], () => "slow");
    // Gaps of 250 ms, idle limit 600 ms: never a stall.
    const res = await sendMessage(r.base, { stream: true, session: "slow" });
    const { text } = await readStream(res);
    expect(isCompleteStream(text, 6)).toBe(true);
    const h = await health(r);
    expect(h.streamGuard).toMatchObject({ firstByteTimeouts: 0, stalled: 0, broken: 0, truncated: 0, firstByteMs: 500, idleMs: 600 });
  });

  it("closes the upstream request when the client hangs up mid-stream", async () => {
    const r = await boot(["lyra"], () => "stall");
    const controller = new AbortController();
    const res = await fetch(`${r.base}/v1/messages`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.317 (external, cli)" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await waitFor(() => up!.seen[0]?.closedEarly === true, "the upstream request to be closed", 5_000);
    // A client that left is not a stall: nothing is counted.
    expect((await health(r)).streamGuard.stalled).toBe(0);
  });
});
