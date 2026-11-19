import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createSeats, isFirstPlacement, seatMetrics, worstWindowUtil, PLACEMENT_REASONS, type SeatSources } from "../proxy/seat-metrics.js";
import { DAY_MS, HOUR_MS, RETENTION_DAYS, UsageHistory, type UsageFile } from "../proxy/usage-history.js";
import type { Account } from "../proxy/types.js";
import { waitForListening } from "./helpers/router-process.js";

// Seat metrics and predicates moved out of server.ts so the balance simulator
// can drive exactly what production ranks on. These tests pin the moved code to
// its old behaviour, and cover the hourly placement counters health now reports.

const limits = (fiveHourUtil: number, fiveHourReset: number, sevenDayUtil: number, sevenDayReset: number) =>
  ({ fiveHourUtil, fiveHourReset, sevenDayUtil, sevenDayReset });

describe("seatMetrics (was sessionTargetUtil in server.ts)", () => {
  it("reads unknown quota as empty", () => {
    expect(seatMetrics(undefined)).toEqual({ util: 0 });
    expect(seatMetrics(null)).toEqual({ util: 0 });
  });

  it("binds on the fuller window and ranks on the five-hour one", () => {
    expect(seatMetrics(limits(0.2, 1000, 0.9, 9000))).toEqual({
      util: 0.9, resetAtSec: 9000,
      pace: { util: 0.2, resetAtSec: 1000 },
      weekly: { util: 0.9, resetAtSec: 9000 },
      fiveHour: { util: 0.2, resetAtSec: 1000 },
    });
    expect(seatMetrics(limits(0.7, 1000, 0.3, 9000))).toMatchObject({ util: 0.7, resetAtSec: 1000, pace: { util: 0.7 } });
  });

  it("binds on the five-hour window when the two are equal", () => {
    expect(seatMetrics(limits(0.5, 1000, 0.5, 9000))).toMatchObject({ util: 0.5, resetAtSec: 1000 });
  });

  it("worstWindowUtil is the larger of the two", () => {
    expect(worstWindowUtil(limits(0.2, 0, 0.9, 0))).toBe(0.9);
    expect(worstWindowUtil(limits(0.6, 0, 0.1, 0))).toBe(0.6);
  });
});

function acct(id: string, five: number, seven: number): Account {
  return {
    id, enabled: true, healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0,
    rateLimits: { ...limits(five, 0, seven, 0) },
  } as unknown as Account;
}

function sources(accounts: Account[], serve: Set<string>, retain: Set<string>, lastResort = new Set<string>()): SeatSources {
  return {
    pool: {
      getAll: () => accounts,
      getById: (id: string) => accounts.find(a => a.id === id),
      canServe: (id: string) => serve.has(id),
      canRetain: (id: string) => retain.has(id),
      canServeLastResort: (id: string) => lastResort.has(id),
    } as unknown as SeatSources["pool"],
    openAIAccounts: [
      { id: "codex", enabled: true, rateLimits: limits(0.4, 100, 0.1, 200) },
      { id: "codex-off", enabled: false, rateLimits: limits(0, 0, 0, 0) },
    ] as unknown as SeatSources["openAIAccounts"],
    canServeOpenAI: a => a.enabled !== false,
  };
}

describe("createSeats", () => {
  const a = acct("a", 0.1, 0.8);
  const b = acct("b", 0.3, 0.2);
  const c = acct("c", 0.05, 0.05);

  it("routes usable and retainable to the pool for Claude and to the picker predicate for OpenAI", () => {
    const s = createSeats(sources([a, b], new Set(["a"]), new Set(["a", "b"])));
    expect(s.usable({ provider: "anthropic", accountId: "a" })).toBe(true);
    expect(s.usable({ provider: "anthropic", accountId: "b" })).toBe(false);
    expect(s.retainable({ provider: "anthropic", accountId: "b" })).toBe(true);
    expect(s.usable({ provider: "openai", accountId: "codex" })).toBe(true);
    expect(s.usable({ provider: "openai", accountId: "codex-off" })).toBe(false);
    expect(s.retainable({ provider: "openai", accountId: "missing" })).toBe(false);
  });

  it("builds metrics from the pool's or the OpenAI account's limits", () => {
    const s = createSeats(sources([a, b], new Set(), new Set()));
    expect(s.metrics({ provider: "anthropic", accountId: "a" })).toEqual(seatMetrics(a.rateLimits));
    expect(s.metrics({ provider: "openai", accountId: "codex" })).toMatchObject({ util: 0.4, resetAtSec: 100 });
    expect(s.metrics({ provider: "anthropic", accountId: "gone" })).toEqual({ util: 0 });
  });

  it("failoverPick takes the coolest untried usable seat and does not count the request", () => {
    const s = createSeats(sources([a, b, c], new Set(["a", "b", "c"]), new Set()));
    expect(s.failoverPick(new Set(), undefined)?.id).toBe("c");
    expect(s.failoverPick(new Set(["c"]), undefined)?.id).toBe("b"); // b's worst 0.3 < a's 0.8
    expect(c.requestCount).toBe(0);
  });

  it("failoverPick falls back to a last-resort seat, then to none", () => {
    const s = createSeats(sources([a, b], new Set(), new Set(), new Set(["b"])));
    expect(s.failoverPick(new Set(), undefined)?.id).toBe("b");
    expect(s.failoverPick(new Set(["b"]), undefined)).toBeNull();
  });

  it("isFirstPlacement is true only for a session that had no pin and got one", () => {
    const t = { provider: "anthropic" as const, accountId: "a" };
    expect(isFirstPlacement(null, t)).toBe(true);
    expect(isFirstPlacement(undefined, t)).toBe(true);
    expect(isFirstPlacement(t, t)).toBe(false);
    expect(isFirstPlacement(null, null)).toBe(false);
  });
});

describe("server.ts uses seat-metrics", () => {
  it("imports the module and no longer builds metrics inline", () => {
    const src = readFileSync(new URL("../proxy/server.ts", import.meta.url), "utf8");
    expect(src).toContain('from "./seat-metrics.js"');
    expect(src).not.toMatch(/limits\.sevenDayUtil > limits\.fiveHourUtil/);
  });
});

// ─── Hourly placement counters ───────────────────────────────────────────────

const T0 = Date.UTC(2026, 10, 19, 12, 30);

describe("placement counters", () => {
  it("count by reason into the hour they happened in", () => {
    const at = { now: T0 };
    const h = new UsageHistory({ now: () => at.now });
    h.recordPlacement("placed");
    h.recordPlacement("placed");
    h.recordPlacement("soft-cap");
    at.now += HOUR_MS;
    h.recordPlacement("weekly-pace");
    const rows = h.placements().sort((x, y) => x.hour - y.hour);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ placed: 2, "soft-cap": 1, "weekly-pace": 0 });
    expect(rows[1]).toMatchObject({ placed: 0, "weekly-pace": 1 });
    expect(h.placementTotals(HOUR_MS)).toMatchObject({ placed: 2, "soft-cap": 1, "weekly-pace": 1 });
    expect(h.placementTotals(DAY_MS)).toMatchObject({ placed: 2, "soft-cap": 1, "weekly-pace": 1, unservable: 0, repin: 0 });
  });

  it("ignore an unknown reason", () => {
    const h = new UsageHistory({ now: () => T0 });
    h.recordPlacement("teleport" as never);
    expect(h.placements()).toEqual([]);
    expect(h.dirty).toBe(false);
  });

  it("round-trip through the usage file, and an old file loads with none", () => {
    const h = new UsageHistory({ now: () => T0 });
    h.recordPlacement("placed");
    h.recordPlacement("repin");
    const file = JSON.parse(JSON.stringify(h.toFile())) as UsageFile;
    expect(file.placements).toEqual([[Math.floor(T0 / HOUR_MS) * HOUR_MS / 1000, 1, 0, 0, 0, 1]]);
    expect(file.placements![0]).toHaveLength(1 + PLACEMENT_REASONS.length);

    const back = new UsageHistory({ now: () => T0 });
    expect(back.restore(file)).toBe(true);
    expect(back.placementTotals(DAY_MS)).toMatchObject({ placed: 1, repin: 1 });

    const old = new UsageHistory({ now: () => T0 });
    expect(old.restore({ version: 1, since: null, rows: [] })).toBe(true);
    expect(old.placements()).toEqual([]);
  });

  it("skip malformed rows and keep the rest", () => {
    const hourSec = Math.floor(T0 / HOUR_MS) * HOUR_MS / 1000;
    const h = new UsageHistory({ now: () => T0 });
    h.restore({
      version: 1, since: null, rows: [],
      placements: [[hourSec, 1, 2], "x", [null, 1, 1, 1, 1, 1], [hourSec, 3, 0, -4, "y", 1]],
    });
    expect(h.placementTotals(DAY_MS)).toEqual({ placed: 3, unservable: 0, "soft-cap": 0, "weekly-pace": 0, repin: 1 });
  });

  it("age out on the same retention as the other hourly rows", () => {
    const at = { now: T0 };
    const h = new UsageHistory({ now: () => at.now });
    h.recordPlacement("placed");
    at.now += (RETENTION_DAYS + 1) * DAY_MS;
    h.prune();
    expect(h.placements()).toEqual([]);
  });
});

// ─── Through a real router, against a fake upstream ─────────────────────────

const SECRET = "s3cret-for-the-seat-metrics-test";
const SESSION = "sess-5ea7-0000-4000-8000-000000000001";

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

interface Fixture { dir: string; queue: Array<"ok" | "429">; upstream: Server; upstreamPort: number }

function reply(res: ServerResponse, kind: "ok" | "429"): void {
  if (kind === "429") {
    res.writeHead(429, {
      "content-type": "application/json", "retry-after": "120",
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3600),
    });
    res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" });
  res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 1, output_tokens: 1 } }));
}

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-seat-metrics-"));
  const queue: Array<"ok" | "429"> = [];
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => reply(res, queue.shift() ?? "ok"));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  writeFileSync(join(dir, "accounts.json"), JSON.stringify(["one", "two"].map(id => ({
    id, accessToken: `fixture-${id}`, refreshToken: "fixture",
    expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }))));
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

// Claude Code identity, so a 429 cools the seat (a bare 429 for another client does not).
const send = (base: string) => fetch(`${base}/v1/messages`, {
  method: "POST", signal: AbortSignal.timeout(8000),
  headers: {
    "content-type": "application/json", "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/2.1.327 (external, cli)",
    "x-claude-code-session-id": SESSION, authorization: `Bearer ${SECRET}`,
  },
  body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
});

interface PlacementView { placements: { lastHour: Record<string, number>; lastDay: Record<string, number> } }
const health = async (base: string): Promise<PlacementView> =>
  (await fetch(`${base}/cc-router/health`, { signal: AbortSignal.timeout(5000) })).json() as Promise<PlacementView>;

describe("placements through a real router", () => {
  it("counts a first pin and a move off a cooling seat, and keeps them across a restart", async () => {
    const f = await fixture();
    let r = await startRouter(f);
    try {
      expect((await send(r.base)).status).toBe(200);
      expect((await send(r.base)).status).toBe(200);
      let h = await health(r.base);
      expect(h.placements.lastHour).toMatchObject({ placed: 1, unservable: 0 });

      // The pinned seat answers 429: failover serves the request from the other
      // seat, and the next request moves the session off the cooling one.
      f.queue.push("429");
      expect((await send(r.base)).status).toBe(200);
      expect((await send(r.base)).status).toBe(200);
      h = await health(r.base);
      expect(h.placements.lastHour).toMatchObject({ placed: 1, unservable: 1 });
      expect(h.placements.lastDay).toMatchObject({ placed: 1, unservable: 1 });

      await r.stop();
      const file = JSON.parse(readFileSync(join(f.dir, "usage.json"), "utf-8")) as UsageFile;
      expect(file.placements?.reduce((n, row) => n + row[1] + row[2], 0)).toBe(2);

      r = await startRouter(f);
      expect((await health(r.base)).placements.lastDay).toMatchObject({ placed: 1, unservable: 1 });
    } finally {
      await r.stop();
      await new Promise<void>(res => f.upstream.close(() => res()));
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 45_000);
});
