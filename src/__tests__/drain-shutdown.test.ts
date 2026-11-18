import { afterEach, describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_DRAIN_LIMIT_MS, MAX_DRAIN_LIMIT_MS, MIN_DRAIN_LIMIT_MS, drainServer, endUnfinishedResponse, resolveDrainLimitMs,
} from "../proxy/drain.js";
import { InFlightCounter } from "../proxy/in-flight.js";
import { FakeUpstream, isCompleteStream, listen, readStream, sendMessage, startRouter, type RouterRun } from "./helpers/continuity-harness.js";
import { waitFor } from "./helpers/router-process.js";

// Stopping the router (systemctl stop/restart, Ctrl+C) used to exit at once and
// cut every stream in flight. Now it stops accepting, finishes what is in
// flight up to a limit, ends the rest retryably, and only then saves and exits.

describe("drain limit", () => {
  it("defaults to ten minutes and clamps configured values", () => {
    expect(resolveDrainLimitMs(undefined, {})).toBe(DEFAULT_DRAIN_LIMIT_MS);
    expect(DEFAULT_DRAIN_LIMIT_MS).toBe(600_000);
    expect(resolveDrainLimitMs(120, {})).toBe(120_000);
    expect(resolveDrainLimitMs(0, {})).toBe(MIN_DRAIN_LIMIT_MS);
    expect(resolveDrainLimitMs(99_999, {})).toBe(MAX_DRAIN_LIMIT_MS);
    expect(resolveDrainLimitMs("soon", {})).toBe(DEFAULT_DRAIN_LIMIT_MS);
    expect(resolveDrainLimitMs(120, { CC_ROUTER_DRAIN_LIMIT_MS: "250" })).toBe(250);
  });
});

/** A ServerResponse stand-in that records what was written to it. */
function fakeRes(opts: { headersSent: boolean; contentType?: string }) {
  const res = Object.assign(new EventEmitter(), {
    headersSent: opts.headersSent, writableEnded: false, destroyed: false,
    status: 0, body: "", cut: false,
    getHeader: (name: string) => (name === "content-type" ? opts.contentType : undefined),
    writeHead(status: number) { this.status = status; this.headersSent = true; return this; },
    end(chunk?: string) { this.body += chunk ?? ""; this.writableEnded = true; return this; },
    destroy() { this.cut = true; this.destroyed = true; return this; },
  });
  return res;
}

describe("a response the drain limit catches unfinished", () => {
  it("gets a 529 overloaded_error before any byte", () => {
    const res = fakeRes({ headersSent: false });
    expect(endUnfinishedResponse(res as unknown as ServerResponse)).toBe("529");
    expect(res.status).toBe(529);
    expect(JSON.parse(res.body).error.type).toBe("overloaded_error");
  });

  it("gets an SSE error event inside a stream, after a blank line that closes any half-written event", () => {
    const res = fakeRes({ headersSent: true, contentType: "text/event-stream" });
    expect(endUnfinishedResponse(res as unknown as ServerResponse)).toBe("sse-error");
    expect(res.body.startsWith("\n\nevent: error\ndata: ")).toBe(true);
    expect(JSON.parse(res.body.split("data: ")[1]!).error.type).toBe("overloaded_error");
  });

  it("is cut when a JSON body is already under way", () => {
    const res = fakeRes({ headersSent: true, contentType: "application/json" });
    expect(endUnfinishedResponse(res as unknown as ServerResponse)).toBe("cut");
    expect(res.cut).toBe(true);
  });
});

describe("drainServer", () => {
  it("stops accepting at once and returns when the last request closes", async () => {
    const inFlight = new InFlightCounter();
    const calls: string[] = [];
    const res = new EventEmitter() as unknown as ServerResponse;
    inFlight.track(res);
    const server = { close: () => { calls.push("close"); return server; }, closeIdleConnections: () => { calls.push("idle"); } };
    setTimeout(() => (res as unknown as EventEmitter).emit("close"), 150);
    const result = await drainServer({ server: server as never, inFlight, limitMs: 5_000, pollMs: 20 });
    expect(calls[0]).toBe("close");
    expect(result).toMatchObject({ dropped: 0, finished: 1 });
    expect(result.durationMs).toBeLessThan(2_000);
  });
});

const HOUR = 3_600_000;

describe("a real router on SIGTERM", { timeout: 90_000 }, () => {
  let router: RouterRun | undefined;
  let upstream: FakeUpstream | undefined;
  afterEach(async () => {
    await router?.stop();
    await new Promise<void>(r => (upstream ? upstream.server.close(() => r()) : r()));
    router = upstream = undefined;
  });

  async function boot(mode: "standalone" | "supervised", opts: { chunks: number; gapMs: number; limitMs: number }) {
    upstream = new FakeUpstream({ chunks: opts.chunks, gapMs: opts.gapMs });
    const upstreamPort = await listen(upstream.server);
    router = await startRouter({
      mode, upstreamPort, seats: [{ id: "lyra", expiresAt: Date.now() + 8 * HOUR }],
      env: { CC_ROUTER_DRAIN_LIMIT_MS: String(opts.limitMs) },
    });
    if (mode === "supervised") {
      const r = router;
      await waitFor(async () => (await r.health()).supervisor?.generation === 1, "the first worker");
    }
    return router;
  }

  it("finishes the stream in flight, refuses new connections, then saves and exits", async () => {
    const r = await boot("standalone", { chunks: 10, gapMs: 150, limitMs: 20_000 });
    const res = await sendMessage(r.base, { stream: true, session: "s1" });
    const streamed = readStream(res, () => { r.child.kill("SIGTERM"); });
    // Once draining, the port is closed: a new connection is refused, which the
    // client retries, rather than accepted and then cut.
    await waitFor(async () => {
      try { await fetch(`${r.base}/cc-router/health`, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; }
    }, "the listener to close", 5_000);
    expect(r.child.exitCode).toBeNull();
    const { text, broken } = await streamed;
    expect(broken).toBe(false);
    expect(isCompleteStream(text, 10)).toBe(true);
    expect(await r.exited()).toBe(0);
    // Saved after the drain, as before.
    expect(existsSync(join(r.dir, "sessions.json"))).toBe(true);
    expect(r.logs()).toMatch(/drained: 1 finished, 0 ended at the limit/);
  });

  it("ends a stream that outlasts the limit with a retryable overloaded_error", async () => {
    const r = await boot("standalone", { chunks: 40, gapMs: 150, limitMs: 400 });
    const res = await sendMessage(r.base, { stream: true, session: "s2" });
    const streamed = readStream(res, () => { r.child.kill("SIGTERM"); });
    const { text } = await streamed;
    expect(text).toContain("event: error");
    expect(text).toContain('"overloaded_error"');
    expect(text).not.toContain('"message_stop"');
    expect(await r.exited()).toBe(0);
    expect(r.logs()).toMatch(/drained: 0 finished, 1 ended at the limit/);
  });

  it("under the supervisor, SIGTERM drains the worker the same way and everything exits", async () => {
    const r = await boot("supervised", { chunks: 10, gapMs: 150, limitMs: 20_000 });
    const workerPid = (await r.health()).worker.pid;
    const res = await sendMessage(r.base, { stream: true, session: "s3" });
    const streamed = readStream(res, () => { r.child.kill("SIGTERM"); });
    const { text, broken } = await streamed;
    expect(broken).toBe(false);
    expect(isCompleteStream(text, 10)).toBe(true);
    expect(await r.exited()).toBe(0);
    await waitFor(() => { try { process.kill(workerPid, 0); return false; } catch { return true; } }, "the worker to exit", 5_000);
    expect(existsSync(join(r.dir, "sessions.json"))).toBe(true);
  });
});

