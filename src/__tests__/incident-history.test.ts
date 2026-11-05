import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DAY_MS, HOUR_MS, RETENTION_DAYS, UsageHistory, type UsageFile } from "../proxy/usage-history.js";
import { readUsageFile, writeUsageFile } from "../config/usage-store.js";
import { INCIDENT_HOURS, summarizeUsage } from "../proxy/usage-summary.js";
import { renderDashboardHtml } from "../proxy/web-dashboard.js";
import { waitForListening } from "./helpers/router-process.js";

// The supply side of the hourly history: when upstream refused or failed, and
// when the router's own throttle held requests back. These are kept per hour
// beside the token rows, survive a restart, age out on the same 92 days, and
// reach the open usage endpoint and the dashboard as pool-wide aggregates.

const T0 = Date.UTC(2026, 10, 4, 12, 30);

function store(now = T0): { h: UsageHistory; at: { now: number } } {
  const at = { now };
  return { h: new UsageHistory({ now: () => at.now }), at };
}

describe("incident buckets", () => {
  it("adds every kind into the hour it happened in", () => {
    const { h } = store();
    h.recordIncident({ ts: T0, rateLimited: 1 });
    h.recordIncident({ ts: T0 + 60_000, rateLimited: 1, errors: 1 });
    h.recordIncident({ ts: T0, throttleWaits: 1, throttleWaitMs: 1500 });
    h.recordIncident({ ts: T0, throttleWaits: 1, throttleWaitMs: 250 });
    h.recordIncident({ ts: T0, throttleBypass: 1 });
    h.recordIncident({ ts: T0 - HOUR_MS, errors: 1 });
    const rows = h.incidents().sort((a, b) => a.hour - b.hour);
    expect(rows).toEqual([
      { hour: Math.floor((T0 - HOUR_MS) / HOUR_MS) * HOUR_MS, errors: 1, rateLimited: 0, throttleWaits: 0, throttleWaitMs: 0, throttleBypass: 0 },
      { hour: Math.floor(T0 / HOUR_MS) * HOUR_MS, errors: 1, rateLimited: 2, throttleWaits: 2, throttleWaitMs: 1750, throttleBypass: 1 },
    ]);
    expect(h.dirty).toBe(true);
  });

  it("ignores a sample that adds nothing, and bad numbers", () => {
    const { h } = store();
    h.recordIncident({ ts: T0 });
    h.recordIncident({ ts: T0, errors: 0, throttleWaitMs: -5 });
    h.recordIncident({ ts: T0, errors: Number.NaN, rateLimited: Number.POSITIVE_INFINITY });
    expect(h.incidents()).toEqual([]);
    expect(h.dirty).toBe(false);
    h.recordIncident({ ts: T0, throttleWaitMs: 12.7, throttleWaits: 1 });
    expect(h.incidents()[0]).toMatchObject({ throttleWaits: 1, throttleWaitMs: 12 });
  });

  it("does not move `since`, which marks when token usage began to be recorded", () => {
    const { h } = store();
    h.recordIncident({ ts: T0, rateLimited: 1 });
    expect(h.since).toBeNull();
  });

  it("is a copy: callers cannot change the store through it", () => {
    const { h } = store();
    h.recordIncident({ ts: T0, errors: 1 });
    h.incidents()[0].errors = 99;
    expect(h.incidents()[0].errors).toBe(1);
  });

  it("ages out on the same retention as token rows", () => {
    const { h, at } = store();
    h.recordIncident({ ts: T0, errors: 1 });
    h.record({ ts: T0, provider: "anthropic", model: "m", input: 1, request: true });
    at.now = T0 + (RETENTION_DAYS - 1) * DAY_MS;
    h.prune();
    expect(h.incidents()).toHaveLength(1);
    at.now = T0 + RETENTION_DAYS * DAY_MS + HOUR_MS;
    h.prune();
    expect(h.incidents()).toEqual([]);
    expect(h.buckets()).toEqual([]);
  });

  it("clamps a timestamp from the future or before the window", () => {
    const { h } = store();
    h.recordIncident({ ts: T0 + 10 * DAY_MS, errors: 1 });
    h.recordIncident({ ts: T0 - 400 * DAY_MS, errors: 1 });
    const hours = h.incidents().map(b => b.hour).sort((a, b) => a - b);
    expect(hours[1]).toBe(Math.floor(T0 / HOUR_MS) * HOUR_MS);
    expect(hours[0]).toBeGreaterThanOrEqual(T0 - RETENTION_DAYS * DAY_MS - HOUR_MS);
  });
});

describe("incidents on disk", () => {
  it("round-trip through the file a restart reads back", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-incidents-"));
    try {
      const path = join(dir, "usage.json");
      const { h } = store();
      h.record({ ts: T0, provider: "anthropic", model: "claude-opus-4-1", input: 5, output: 7, request: true });
      h.recordIncident({ ts: T0, rateLimited: 3, errors: 1, throttleWaits: 2, throttleWaitMs: 900, throttleBypass: 4 });
      expect(writeUsageFile(path, h.toFile())).toEqual({ ok: true });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const file = JSON.parse(readFileSync(path, "utf-8")) as UsageFile;
      // Compatible: the version stays 1, so a rolled-back router still reads the tokens.
      expect(file.version).toBe(1);
      expect(file.incidents).toEqual([[Math.floor(T0 / HOUR_MS) * HOUR_MS / 1000, 1, 3, 2, 900, 4]]);

      const read = readUsageFile(path);
      expect(read.status).toBe("ok");
      const { h: after } = store();
      expect(after.restore((read as { data: unknown }).data)).toBe(true);
      expect(after.incidents()).toEqual(h.incidents());
      expect(after.buckets()).toEqual(h.buckets());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a file written before incidents were kept, with none", () => {
    const { h } = store();
    const old = { version: 1, since: T0, rows: [[Math.floor(T0 / HOUR_MS) * 3600, "anthropic", "m", 1, 2, 3, 4, 1]] };
    expect(h.restore(old)).toBe(true);
    expect(h.incidents()).toEqual([]);
    expect(h.buckets()).toHaveLength(1);
  });

  it("skips malformed incident rows and keeps the rest", () => {
    const { h } = store();
    const hourSec = Math.floor(T0 / HOUR_MS) * 3600;
    expect(h.restore({
      version: 1, since: T0, rows: [],
      incidents: [
        [hourSec, 1, 2, 3, 4, 5],
        [hourSec, 1, 2],
        ["x", 1, 1, 1, 1, 1],
        null,
        [hourSec - 3600, "a", -1, 1, 1, 1],
      ],
    })).toBe(true);
    const rows = h.incidents().sort((a, b) => a.hour - b.hour);
    expect(rows).toEqual([
      { hour: (hourSec - 3600) * 1000, errors: 0, rateLimited: 0, throttleWaits: 1, throttleWaitMs: 1, throttleBypass: 1 },
      { hour: hourSec * 1000, errors: 1, rateLimited: 2, throttleWaits: 3, throttleWaitMs: 4, throttleBypass: 5 },
    ]);
  });

  it("ignores an incidents field that is not a list", () => {
    const { h } = store();
    expect(h.restore({ version: 1, since: null, rows: [], incidents: { a: 1 } })).toBe(true);
    expect(h.incidents()).toEqual([]);
  });
});

describe("incidents in the usage summary", () => {
  it("totals rolling windows and lists the last 24 hours, quiet hours as zeros", () => {
    const { h } = store();
    h.recordIncident({ ts: T0, rateLimited: 2 });
    h.recordIncident({ ts: T0 - 3 * HOUR_MS, errors: 1, throttleWaits: 1, throttleWaitMs: 400 });
    h.recordIncident({ ts: T0 - 3 * DAY_MS, rateLimited: 5 });
    h.recordIncident({ ts: T0 - 20 * DAY_MS, throttleBypass: 7 });
    const s = summarizeUsage(h, { now: T0, tz: "UTC" });
    expect(s.incidents.windows["1d"]).toEqual({ errors: 1, rateLimited: 2, throttleWaits: 1, throttleWaitMs: 400, throttleBypass: 0 });
    expect(s.incidents.windows["7d"].rateLimited).toBe(7);
    expect(s.incidents.windows["14d"].throttleBypass).toBe(0);
    expect(s.incidents.windows["30d"].throttleBypass).toBe(7);
    expect(s.incidents.hours).toHaveLength(INCIDENT_HOURS);
    const last = s.incidents.hours.at(-1)!;
    expect(last).toMatchObject({ start: Math.floor(T0 / HOUR_MS) * HOUR_MS, date: "2026-11-04", rateLimited: 2 });
    expect(s.incidents.hours.at(-4)).toMatchObject({ errors: 1, throttleWaitMs: 400 });
    expect(s.incidents.hours.at(-2)).toMatchObject({ errors: 0, rateLimited: 0, throttleWaits: 0 });
    // Pool-wide aggregates only: nothing account-shaped on the open endpoint.
    expect(JSON.stringify(s.incidents)).not.toMatch(/account/i);
  });

  it("is all zeros for a source that keeps no incidents", () => {
    const s = summarizeUsage({ buckets: () => [], since: null }, { now: T0, tz: "UTC" });
    expect(s.incidents.windows["30d"]).toEqual({ errors: 0, rateLimited: 0, throttleWaits: 0, throttleWaitMs: 0, throttleBypass: 0 });
    expect(s.incidents.hours.every(x => x.errors === 0 && x.rateLimited === 0)).toBe(true);
  });
});

describe("incidents on the dashboard", () => {
  it("has a card that is drawn from the usage-history reply and validated before use", () => {
    const html = renderDashboardHtml();
    expect(html).toContain('id="inccard"');
    expect(html).toContain('id="inchours"');
    expect(html).toContain("function renderIncidents");
    expect(html).toContain("validIncidents(v)");
    expect(html).toContain("renderIncidents(d)");
    expect(html).toContain("Rate limited (429)");
    expect(html).toContain("Throttle bypasses");
  });

  it("keeps the incidents script valid JavaScript", () => {
    const html = renderDashboardHtml();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
  });
});

// ─── Through a real router, against a fake upstream ─────────────────────────

const SECRET = "s3cret-for-the-incident-test";
const SESSION = "sess-89ab0123-4567-89ef-0123-456789abcdef";

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

type Reply = "ok" | "503" | "429";
interface Fixture { dir: string; queue: Reply[]; upstream: Server; upstreamPort: number }

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-incident-http-"));
  const queue: Reply[] = [];
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const kind = queue.shift() ?? "ok";
      if (kind === "503") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "unavailable" } }));
      } else if (kind === "429") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
      } else {
        res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" });
        res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 } }));
      }
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
    id: "fixture", accessToken: "fixture", refreshToken: "fixture",
    expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }]));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ proxySecret: SECRET }));
  return { dir, queue, upstream, upstreamPort: (upstream.address() as { port: number }).port };
}

interface Router { base: string; child: ChildProcess; stop: () => Promise<void> }

async function startRouter(f: Fixture): Promise<Router> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
    ACCOUNTS_PATH: join(f.dir, "accounts.json"), CONFIG_PATH: join(f.dir, "config.json"),
    SESSIONS_PATH: join(f.dir, "sessions.json"),
  };
  delete env["USAGE_PATH"];
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${f.upstreamPort}'});`], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout!.on("data", b => { logs += b; });
  child.stderr!.on("data", b => { logs += b; });
  await waitForListening(child, () => logs);
  return {
    base: `http://127.0.0.1:${port}`, child,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 4000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

interface Served { incidents: { windows: Record<string, { errors: number; rateLimited: number }>; hours: unknown[] } }

const send = (base: string) => fetch(`${base}/v1/messages`, {
  method: "POST", signal: AbortSignal.timeout(8000),
  headers: {
    "content-type": "application/json", "anthropic-version": "2023-06-01",
    "x-claude-code-session-id": SESSION, authorization: `Bearer ${SECRET}`,
  },
  body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
});
const served = async (base: string): Promise<Served> =>
  (await fetch(`${base}/cc-router/usage-history?tz=UTC`, { signal: AbortSignal.timeout(5000) })).json() as Promise<Served>;

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("incident history through a real router", () => {
  it("counts an upstream 5xx and a 429, serves them without the secret, and keeps them across a restart", async () => {
    const f = await fixture();
    let r = await startRouter(f);
    try {
      f.queue.push("503");
      expect((await send(r.base)).status).toBe(503);
      f.queue.push("429");
      expect((await send(r.base)).status).toBe(429);
      await until(async () => {
        const w = (await served(r.base)).incidents.windows["1d"];
        return w.errors === 1 && w.rateLimited === 1;
      }, "the 503 and the 429 to be counted");

      await r.stop();
      const file = JSON.parse(readFileSync(join(f.dir, "usage.json"), "utf-8")) as UsageFile;
      expect(file.incidents?.reduce((n, row) => n + row[1] + row[2], 0)).toBe(2);

      r = await startRouter(f);
      const after = await served(r.base);
      expect(after.incidents.windows["1d"]).toMatchObject({ errors: 1, rateLimited: 1 });
      expect(after.incidents.hours).toHaveLength(INCIDENT_HOURS);
    } finally {
      await r.stop();
      await new Promise<void>(res => f.upstream.close(() => res()));
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("throttle incidents through a real router", () => {
  // As in throttle-short-request-http: the account's only slot is held by a long
  // stream, a classifier-shaped request bypasses, an ordinary one waits.
  it("counts a throttle bypass and a throttle wait with its duration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-incident-throttle-"));
    const held: ServerResponse[] = [];
    let seen = 0;
    const upstream = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      seen++;
      if ((JSON.parse(raw) as { stream?: boolean }).stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": hold\n\n");
        held.push(res);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
      id: "fixture", accessToken: "fixture", refreshToken: "fixture",
      expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
    }]));
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      throttle: { enabled: true, perAccountMaxInFlight: 1, minIntervalMs: 0, maxWaitMs: 1500 },
    }));
    const r = await startRouter({ dir, queue: [], upstream, upstreamPort });
    const controller = new AbortController();
    const post = (body: object) => fetch(`${r.base}/v1/messages?beta=true`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "x-claude-code-session-id": "same-session" },
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }], ...body }),
    });
    try {
      const long = await post({ stream: true, max_tokens: 32_000, tools: [{ name: "Bash", input_schema: { type: "object" } }] });
      expect(long.status).toBe(200);
      await until(async () => seen === 1, "the long turn to reach upstream");
      await (await post({ max_tokens: 2068, system: [{ type: "text", text: "classify" }] })).text();
      await (await post({ max_tokens: 32_000 })).text();

      let w = { throttleWaits: 0, throttleWaitMs: 0, throttleBypass: 0 };
      await until(async () => {
        w = (await served(r.base)).incidents.windows["1d"] as unknown as typeof w;
        return w.throttleWaits === 1 && w.throttleBypass === 1;
      }, "one bypass and one wait");
      expect(w.throttleWaitMs).toBeGreaterThanOrEqual(1_400);
    } finally {
      controller.abort();
      for (const res of held) res.end();
      await r.stop();
      await new Promise<void>(res => upstream.close(() => res()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
