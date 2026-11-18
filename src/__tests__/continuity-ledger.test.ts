import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTINUITY_CAUSES, CONTINUITY_RETENTION_MS, ContinuityLedger, MAX_HANDOFFS, causeOfStatus } from "../proxy/continuity-ledger.js";
import type { HandoffReport } from "../daemon/handoff-protocol.js";
import { renderDashboardHtml } from "../proxy/web-dashboard.js";
import { FakeUpstream, listen, readStream, sendMessage, sseEvents, startRouter, type RouterRun } from "./helpers/continuity-harness.js";
import { waitFor } from "./helpers/router-process.js";

// The ledger is the evidence for "a session is never cut": what clients saw go
// wrong, by cause, over the last hour and day, and every handoff with what it
// dropped. It must count only what reached a client, and survive a restart.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 19, 12, 30);

const report = (at: number, over: Partial<HandoffReport> = {}): HandoffReport => ({
  generation: 2, at, fromPid: 10, toPid: 11, finished: 3, dropped: 0, unsaved: 1, drainMs: 900, ...over,
});

describe("the ledger", () => {
  it("counts only failures a client saw: 401, 429 and 5xx", () => {
    expect(causeOfStatus(401)).toBe("http-401");
    expect(causeOfStatus(429)).toBe("http-429");
    expect(causeOfStatus(503)).toBe("http-5xx");
    expect(causeOfStatus(529)).toBe("http-5xx");
    for (const s of [200, 400, 403, 404, 413]) expect(causeOfStatus(s)).toBeNull();
  });

  it("reports the last hour and the last day by cause", () => {
    let now = T0;
    const l = new ContinuityLedger(() => now);
    l.record("http-429", 1, T0 - 30 * HOUR); // outside the day
    l.record("http-5xx", 2, T0 - 5 * HOUR);
    l.record("stream-stalled", 1, T0 - 10 * 60_000);
    const s = l.snapshot();
    expect(s.lastHour).toMatchObject({ total: 1, byCause: { "stream-stalled": 1, "http-5xx": 0 } });
    expect(s.lastDay).toMatchObject({ total: 3, byCause: { "http-5xx": 2, "stream-stalled": 1, "http-429": 0 } });
    expect(Object.keys(s.lastDay.byCause).sort()).toEqual([...CONTINUITY_CAUSES].sort());
    now = T0 + 2 * HOUR;
    expect(l.snapshot().lastHour.total).toBe(0);
  });

  it("keeps each handoff once, however often the supervisor repeats it", () => {
    const l = new ContinuityLedger(() => T0);
    l.recordHandoff(report(T0 - HOUR));
    l.recordHandoff(report(T0 - HOUR));
    l.recordHandoff(report(T0 - 2 * HOUR, { dropped: 2, toPid: 9 }));
    l.recordHandoff(report(T0 - 30 * HOUR, { dropped: 5, toPid: 8 }));
    const s = l.snapshot();
    expect(s.handoffs).toMatchObject({ lastDay: 2, droppedLastDay: 2 });
    expect(s.handoffs.last?.at).toBe(T0 - HOUR);
    expect(s.handoffs.recent).toHaveLength(3);
    for (let i = 0; i < MAX_HANDOFFS + 5; i++) l.recordHandoff(report(T0 - i * 1000, { toPid: 100 + i }));
    expect(l.toFile().handoffs).toHaveLength(MAX_HANDOFFS);
  });

  it("round-trips through its file, drops what aged out and skips what is malformed", () => {
    const a = new ContinuityLedger(() => T0);
    a.record("http-401", 2, T0 - HOUR);
    a.record("stream-broken", 1, T0 - CONTINUITY_RETENTION_MS - HOUR);
    a.recordHandoff(report(T0 - HOUR));
    expect(a.dirty).toBe(true);
    const file = JSON.parse(JSON.stringify(a.toFile()));
    const b = new ContinuityLedger(() => T0);
    expect(b.restore(file)).toBe(true);
    expect(b.dirty).toBe(false);
    expect(b.snapshot().lastDay.byCause["http-401"]).toBe(2);
    expect(b.toFile().hours.some(([, c]) => "stream-broken" in c)).toBe(false);
    expect(b.snapshot().handoffs.last?.at).toBe(T0 - HOUR);

    const c = new ContinuityLedger(() => T0);
    expect(c.restore({ version: 2 })).toBe(false);
    expect(c.restore({ version: 1, hours: [["x", {}], [T0 / 1000, { "http-429": -4, nonsense: 3, "http-5xx": 1 }]], handoffs: [{ at: "x" }] })).toBe(true);
    expect(c.snapshot().lastDay).toMatchObject({ total: 1, byCause: { "http-5xx": 1, "http-429": 0 } });
  });

  it("keeps what was recorded before a restore marked dirty", () => {
    const l = new ContinuityLedger(() => T0);
    l.record("http-429");
    l.restore({ version: 1, hours: [], handoffs: [] });
    expect(l.dirty).toBe(true);
  });
});

describe("the dashboard", () => {
  it("has a Continuity card drawn from health, validated before use", () => {
    const html = renderDashboardHtml();
    expect(html).toContain('id="ctcard"');
    expect(html).toContain("renderContinuity(h)");
    expect(html).toContain("validContinuity(c)");
    for (const label of ["Last hour", "Last day", "Handoffs, last day", "Last handoff"]) expect(html).toContain(label);
    for (const src of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])) {
      expect(() => new Function(src)).not.toThrow();
    }
  });
});

// ─── Through a real router ──────────────────────────────────────────────────

interface ContinuityHealth {
  continuity: {
    lastHour: { total: number; byCause: Record<string, number> };
    lastDay: { total: number; byCause: Record<string, number> };
    handoffs: { lastDay: number; droppedLastDay: number; last: HandoffReport | null };
    workerCrashes: number | null;
  };
}

/** One seat per behaviour: "refuse" answers 503, "weekly" a weekly 429, "stall" stops mid-stream. */
function scripted(behave: (seat: string) => "ok" | "refuse" | "weekly" | "stall"): Server {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const seat = String(req.headers["authorization"] ?? "").replace(/^Bearer /, "").replace(/\.a\d+$/, "");
      const stream = JSON.parse(raw).stream === true;
      const b = behave(seat);
      if (b === "refuse") { res.writeHead(503, { "content-type": "application/json" }); res.end('{"type":"error","error":{"type":"api_error","message":"down"}}'); return; }
      if (b === "weekly") {
        res.writeHead(429, {
          "content-type": "application/json", "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "seven_day",
          "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 2 * 86_400), "retry-after": "7200",
        });
        res.end('{"type":"error","error":{"type":"rate_limit_error","message":"weekly"}}');
        return;
      }
      if (!stream) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"m","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}'); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = sseEvents(4);
      if (b === "ok") { res.end(events.join("")); return; }
      res.write(events.slice(0, 2).join("")); // then silence
    });
  });
}

describe("a real router keeps the ledger", { timeout: 90_000 }, () => {
  const routers: RouterRun[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    for (const r of routers.splice(0)) await r.stop();
    for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  });
  const ledger = async (r: RouterRun) => ((await r.health()) as unknown as ContinuityHealth).continuity;

  it("counts what clients saw, not what failover absorbed, and keeps it across a restart", async () => {
    let mode: "absorb" | "exhaust" | "stall" = "absorb";
    const up = scripted(seat => {
      if (mode === "absorb") return seat === "bad" ? "refuse" : "ok";
      if (mode === "exhaust") return "weekly";
      return "stall";
    });
    servers.push(up);
    const upstreamPort = await listen(up);
    const seats = [{ id: "bad", expiresAt: Date.now() + 8 * HOUR }, { id: "good", expiresAt: Date.now() + 8 * HOUR }];
    const env = { CC_ROUTER_STREAM_IDLE_MS: "400", CC_ROUTER_FIRST_BYTE_MS: "2000" };
    const r = await startRouter({ mode: "standalone", upstreamPort, seats, env });
    routers.push(r);

    // Refusals absorbed by failover are invisible to clients and to the ledger.
    for (let i = 0; i < 4; i++) expect((await sendMessage(r.base, { session: `a${i}` })).status).toBe(200);
    expect((await ledger(r)).lastDay.total).toBe(0);

    // A stall the client saw (as overloaded_error) is counted.
    mode = "stall";
    const stalled = await readStream(await sendMessage(r.base, { stream: true, session: "s" }));
    expect(stalled.text).toContain("overloaded_error");
    await waitFor(async () => (await ledger(r)).lastHour.byCause["stream-stalled"] === 1, "the stall to be counted");

    // Every seat out of quota: the client gets 429s, each counted.
    mode = "exhaust";
    for (let i = 0; i < 3; i++) expect((await sendMessage(r.base, { session: `e${i}` })).status).toBe(429);
    await waitFor(async () => (await ledger(r)).lastHour.byCause["http-429"] === 3, "the 429s to be counted");
    const before = await ledger(r);
    expect(before.lastDay.total).toBe(4);
    expect(before.workerCrashes).toBeNull();

    // A stop saves the ledger; the next router starts from it.
    r.child.kill("SIGTERM");
    expect(await r.exited()).toBe(0);
    expect(existsSync(join(r.dir, "continuity.json"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(r.dir, "continuity.json"), "utf8")) as { version: number };
    expect(saved.version).toBe(1);
    const again = await startRouter({ mode: "standalone", upstreamPort, seats, env: { ...env, CONTINUITY_PATH: join(r.dir, "continuity.json") } });
    routers.push(again);
    expect((await ledger(again)).lastDay).toMatchObject({ total: 4, byCause: { "http-429": 3, "stream-stalled": 1 } });
  });

  it("records each handoff under the supervisor, with nothing dropped", async () => {
    const up = new FakeUpstream({ chunks: 6, gapMs: 100 });
    servers.push(up.server);
    const upstreamPort = await listen(up.server);
    const r = await startRouter({
      mode: "supervised", upstreamPort, seats: [{ id: "lyra", expiresAt: Date.now() + 8 * HOUR }],
      env: { CC_ROUTER_DRAIN_LIMIT_MS: "20000" },
    });
    routers.push(r);
    await waitFor(async () => (await r.health()).supervisor?.generation === 1, "the first worker");
    expect((await ledger(r)).workerCrashes).toBe(0);
    const res = await sendMessage(r.base, { stream: true, session: "h" });
    const streamed = readStream(res, () => { process.kill(r.child.pid!, "SIGHUP"); });
    expect((await streamed).broken).toBe(false);
    await waitFor(async () => (await ledger(r)).handoffs.lastDay === 1, "the handoff to reach the ledger", 30_000);
    const c = await ledger(r);
    expect(c.handoffs).toMatchObject({ lastDay: 1, droppedLastDay: 0 });
    expect(c.handoffs.last).toMatchObject({ generation: 2, dropped: 0 });
    expect(c.lastDay.total).toBe(0);
  });
});
