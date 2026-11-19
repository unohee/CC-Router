import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { SessionRouter, type SessionTarget, type TargetMetrics } from "../proxy/session-router.js";
import { createSeats, type SeatSources } from "../proxy/seat-metrics.js";
import type { Account } from "../proxy/types.js";
import { SCENARIOS } from "./balance/scenarios.js";
import { SCENARIOS_2, type Scenario2 } from "./balance/scenarios-2.js";
import { regressions, score, type ScenarioScore } from "./balance/score.js";
import { regressions2, score2, strictlyBetter2, type ScenarioScore2 } from "./balance/score-2.js";
import { simulate } from "./balance/sim.js";
import { waitForListening } from "./helpers/router-process.js";

// What a reload does to pins and load, and what failover does to them.
// Every deploy is a reload: the pins come back from sessions.json. Before
// this, a restored pin had no pinnedAt, so the 30-minute dwell was skipped and
// every pin could move for pace on its first request after a deploy; the load
// window was in memory only, so for ten minutes every seat read as idle; the
// failover pick was counted as load twice (rank +1, then pinTo +10); and
// pinTo ran on transient 5xx and connection errors that had not cooled the
// seat the session was on, drifting it off where placement put it.

const NOW = Date.UTC(2026, 10, 19, 7, 0);
const nowSec = NOW / 1000;
const H = 3600;
const MIN = 60_000;
const T = (accountId: string): SessionTarget => ({ provider: "anthropic", accountId });

interface Win { util: number; hoursLeft: number }
function seat(now: number, week: Win): TargetMetrics {
  const w = { util: week.util, resetAtSec: now / 1000 + week.hoursLeft * H };
  return { util: w.util, resetAtSec: w.resetAtSec, weekly: w, fiveHour: { util: 0, resetAtSec: 0 } };
}
const PACE = { slack: 0.1, migrateAhead: 0.15, fiveHour: false, fiveHourSlack: 0.2 };
const LIVE = { softCapUtil: 0.98, weeklyPace: PACE };

describe("a restored pin", () => {
  // a: dry (85% spent, 60% of the week left: ratio 0.375); b: on pace with a surplus.
  const dryVsSurplus = (now: number) => (t: SessionTarget) =>
    t.accountId === "a" ? seat(now, { util: 0.85, hoursLeft: 100 }) : seat(now, { util: 0.3, hoursLeft: 100 });
  const pool = [T("a"), T("b")];

  it("keeps its dwell: with no pinnedAt in the snapshot it takes lastSeen, and is not moved for pace at once", () => {
    const clock = { now: NOW };
    const moves: string[] = [];
    const r = new SessionRouter({ now: () => clock.now, ...LIVE, onReassign: ({ reason }) => moves.push(reason) });
    r.restore([{ sessionId: "s", provider: "anthropic", accountId: "a", lastSeen: NOW - 5 * MIN }]);
    expect(r.resolve("s", pool, () => true, dryVsSurplus(clock.now))!.accountId).toBe("a");
    expect(moves).toEqual([]);
    // Once the dwell has passed since lastSeen, the move happens.
    clock.now = NOW + 26 * MIN;
    expect(r.resolve("s", pool, () => true, dryVsSurplus(clock.now))!.accountId).toBe("b");
    expect(moves).toEqual(["weekly-pace"]);
  });

  it("carries pinnedAt through a snapshot, so a pin placed long ago may move after a reload", () => {
    const first = new SessionRouter({ now: () => NOW - 40 * MIN, ...LIVE });
    first.resolve("s", pool, t => t.accountId === "a", dryVsSurplus(NOW - 40 * MIN));
    const saved = first.snapshot();
    expect(saved[0]!.pinnedAt).toBe(NOW - 40 * MIN);
    const moves: string[] = [];
    const second = new SessionRouter({ now: () => NOW, ...LIVE, onReassign: ({ reason }) => moves.push(reason) });
    second.restore(saved);
    expect(second.resolve("s", pool, () => true, dryVsSurplus(NOW))!.accountId).toBe("b");
    expect(moves).toEqual(["weekly-pace"]);
  });
});

describe("the load window", () => {
  const pool = [T("a"), T("b")];
  const same = (now: number) => () => seat(now, { util: 0.5, hoursLeft: 80 });

  it("survives a reload through loadSnapshot/restoreLoad, so a seat that was busy still reads as busy", () => {
    const first = new SessionRouter({ now: () => NOW, softCapUtil: 0.98 });
    for (let i = 0; i < 10; i++) first.resolve(`on-a-${i}`, pool, t => t.accountId === "a", same(NOW));
    const load = first.loadSnapshot();
    expect(load.length).toBe(10);
    expect(load.every(l => l.accountId === "a" && l.weight === 10)).toBe(true);

    const reloaded = new SessionRouter({ now: () => NOW + MIN, softCapUtil: 0.98 });
    reloaded.restore(first.snapshot());
    reloaded.restoreLoad(load);
    expect(reloaded.resolve("new", pool, () => true, same(NOW + MIN))!.accountId).toBe("b");

    // Without the restore, the same router reads both seats as idle and ties: a or b.
    const bare = new SessionRouter({ now: () => NOW + MIN, softCapUtil: 0.98 });
    bare.restore(first.snapshot());
    const x = bare.explain(pool, () => true, same(NOW + MIN))!;
    expect(x.get("anthropic:a")!.load).toBe(0);
  });

  it("drops entries outside the window and malformed ones", () => {
    const r = new SessionRouter({ now: () => NOW, softCapUtil: 0.98 });
    r.restoreLoad([
      { at: NOW - 11 * MIN, provider: "anthropic", accountId: "a", weight: 10 }, // too old
      { at: NOW + MIN, provider: "anthropic", accountId: "a", weight: 10 },      // from the future
      { at: NOW - MIN, provider: "anthropic", accountId: "a", weight: -1 },      // bad weight
      { at: NOW - MIN, provider: "x" as never, accountId: "a", weight: 1 },      // bad provider
      { at: NOW - MIN, provider: "anthropic", accountId: "a", weight: 10 },      // kept
    ]);
    expect(r.loadSnapshot()).toEqual([{ at: NOW - MIN, provider: "anthropic", accountId: "a", weight: 10 }]);
  });
});

describe("failover", () => {
  function acct(id: string): Account {
    return {
      id, enabled: true, healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0,
      rateLimits: { fiveHourUtil: 0.1, fiveHourReset: nowSec + 3 * H, sevenDayUtil: 0.3, sevenDayReset: nowSec + 100 * H },
    } as unknown as Account;
  }
  function sources(accounts: Account[], router: SessionRouter): SeatSources {
    return {
      pool: {
        getAll: () => accounts, getById: (id: string) => accounts.find(a => a.id === id),
        canServe: (id: string) => accounts.some(a => a.id === id), canRetain: (id: string) => accounts.some(a => a.id === id),
        canServeLastResort: () => false,
      } as unknown as SeatSources["pool"],
      openAIAccounts: [], canServeOpenAI: () => false,
      rank: (c, usable, utilOf, mode) => router.rank(c, usable, utilOf, mode),
    };
  }

  it("counts the seat it picks as load once, through pinTo, not through rank", () => {
    const accounts = [acct("a"), acct("b")];
    const r = new SessionRouter({ now: () => NOW, softCapUtil: 0.98 });
    const seats = createSeats(sources(accounts, r));
    const pick = seats.failoverPick(new Set(), undefined)!;
    expect(r.explain([T("a"), T("b")], () => true, seats.metrics)!.get(`anthropic:${pick.id}`)!.load).toBe(0);
    r.pinTo("s", T(pick.id));
    expect(r.explain([T("a"), T("b")], () => true, seats.metrics)!.get(`anthropic:${pick.id}`)!.load).toBe(1);
    // A request without a session is still counted by rank.
    const before = r.explain([T("a"), T("b")], () => true, seats.metrics)!;
    const plain = r.rank([T("a"), T("b")], () => true, seats.metrics, "rotate")!;
    const after = r.explain([T("a"), T("b")], () => true, seats.metrics)!;
    expect(after.get(`anthropic:${plain.accountId}`)!.load).toBeGreaterThan(before.get(`anthropic:${plain.accountId}`)!.load);
  });

  it("re-pins only when the seat the session was on cannot keep it (server wiring)", () => {
    const src = readFileSync(fileURLToPath(new URL("../proxy/server.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/if \(!authRefusal && pool\.canRetain\(st\.origin, req\._ccAnthropicModel\)\) return;/);
    // An auth refusal from the origin is followed although the seat stays retainable.
    expect(src).toMatch(/const authRefusal = st\.originKind === "401" \|\| st\.originKind === "token-refresh";/);
    // Not when another request of the session has already moved the pin off the origin.
    expect(src).toMatch(/const current = sessionRouter\.peek\(sid\);\s*if \(current && !\(current\.provider === "anthropic" && current\.accountId === st\.origin\)\) return;\s*sessionRouter\.pinTo\(sid, \{ provider: "anthropic", accountId: answered\.id \}\)/);
    // Once, when a seat answered, not per hop.
    expect(src).toMatch(/if \(recovered\) followAnsweringSeat\(req\);/);
    // origin is the first seat, set when the failover state is created.
    expect(src).toMatch(/req\._ccFailover = \{ tried: new Set\(\[account\.id\]\), [^}]*origin: account\.id \}/);
  });
});

describe("in the balance simulator", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterAll(() => { vi.useRealTimers(); });

  const base1 = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/balance/baseline.json", import.meta.url)), "utf8")) as { scenarios: Record<string, ScenarioScore> };
  const base2 = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/balance/baseline-2.json", import.meta.url)), "utf8")) as { scenarios: Record<string, ScenarioScore2> };

  it("is strictly better than baseline-2 on deploy-restore with no cache rewrite in the first 30 minutes, and no worse on every pool in both baselines", () => {
    const worse: string[] = [];
    let deploy: ScenarioScore2 | null = null;
    let early = -1;
    for (const sc of SCENARIOS_2) {
      const r = simulate(sc, { setClock: ms => vi.setSystemTime(ms) });
      const waits = Object.values(r.queueWaitBySeat);
      const s = score2({ ...r.metrics, overspendAtEnd: r.overspendAtEnd, queueWait: waits.reduce((a, b) => a + b, 0), queueWaitMaxSeat: Math.max(0, ...waits) });
      worse.push(...regressions2(sc.name, s, base2.scenarios[sc.name]));
      if (sc.name === "deploy-restore") { deploy = s; early = r.earlyMoves; }
    }
    for (const sc of SCENARIOS) {
      const r = simulate(sc, { setClock: ms => vi.setSystemTime(ms) });
      worse.push(...regressions(sc.name, score(r.metrics), base1.scenarios[sc.name]));
    }
    expect(worse).toEqual([]);
    expect(strictlyBetter2(deploy!, base2.scenarios["deploy-restore"])).toBe(true);
    // The 40 restored pins stay where they were through the first half hour.
    expect(early).toBe(0);
  }, 600_000);

  it("the dwell is what holds a restored pin: with a surplus seat in the pool, pins move only after it, while an expired pinnedAt moves them at once", () => {
    // deploy-restore as frozen has no surplus seat, so no pin can move for pace
    // there whatever its dwell. The same pool with kyte almost unspent is a
    // target for heewon's restored pins (ratio 0.68 against kyte's 1.10).
    const deploy = SCENARIOS_2.find(sc => sc.name === "deploy-restore")!;
    const variant: Scenario2 = { ...deploy, name: "deploy-restore-surplus", seats: deploy.seats.map(s => s.id === "kyte" ? { ...s, weeklyUtil: 0.05 } : s) };
    const setClock = (ms: number) => vi.setSystemTime(ms);
    const dwell = simulate(variant, { setClock });
    const expired = simulate(variant, { setClock, restoredPinnedAt: (_lastSeen, now) => now - 31 * MIN });
    expect(expired.firstMoveAtMs).not.toBeNull();
    expect(expired.firstMoveAtMs!).toBeLessThan(5 * MIN);
    // Restored lastSeen is staggered over the last ten minutes, so the first
    // pin becomes movable twenty minutes in.
    expect(dwell.firstMoveAtMs === null || dwell.firstMoveAtMs >= 20 * MIN).toBe(true);
    expect(dwell.earlyMoves).toBeLessThan(expired.earlyMoves);
  }, 600_000);
});

// ─── Through a real router reload ───────────────────────────────────────────

const SECRET = "s3cret-for-the-balance-restore-test";
const SEATS = ["a", "b", "c"];
const DRY_SEAT = "a";

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

function reply(res: ServerResponse, seat: string, status: number, dry: boolean): void {
  const nowSec = Math.floor(Date.now() / 1000);
  if (status === 429) {
    res.writeHead(429, {
      "content-type": "application/json", "retry-after": "120",
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-5h-reset": String(nowSec + 3600),
    });
    res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
    return;
  }
  if (status === 401) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid token" } }));
    return;
  }
  if (status !== 200) {
    // A transient upstream failure: no rate-limit headers, nothing to cool.
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "overloaded" } }));
    return;
  }
  // Once `dry` is set, the dry seat has spent 85% of its week with 60% of it
  // left while the others have a surplus; before that every seat reads alike.
  const util = dry && seat === DRY_SEAT ? "0.85" : "0.30";
  res.writeHead(200, {
    "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.10", "anthropic-ratelimit-unified-5h-reset": String(nowSec + 3 * 3600),
    "anthropic-ratelimit-unified-7d-utilization": util, "anthropic-ratelimit-unified-7d-reset": String(nowSec + 100 * 3600),
  });
  res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
}

/** `failQueue` holds the status of the next upstream requests, in order, whichever seat they reach. */
interface Fixture {
  dir: string; served: string[]; failQueue: number[]; dry: boolean; upstream: Server; upstreamPort: number;
  /** Stands in for the OAuth token endpoint a 401 sends a refresh to; slow and failing transiently, so the seat stays retainable meanwhile. */
  oauth: Server; oauthPort: number;
}

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-balance-restore-"));
  const served: string[] = [];
  const failQueue: number[] = [];
  const f: Fixture = { dir, served, failQueue, dry: false, upstream: null as unknown as Server, upstreamPort: 0, oauth: null as unknown as Server, oauthPort: 0 };
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const seat = String(req.headers["authorization"] ?? "").replace(/^Bearer fixture-/, "");
      const status = failQueue.shift() ?? 200;
      if (status === 200) served.push(seat);
      reply(res, seat, status, f.dry);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const now = Date.now();
  writeFileSync(join(dir, "accounts.json"), JSON.stringify(SEATS.map(id => ({
    id, accessToken: `fixture-${id}`, refreshToken: "fixture", expiresAt: now + 86_400_000, scopes: [], enabled: true,
  }))));
  // Every seat starts with a weekly reading (as a live pool does, from
  // account-state.json): placement does not consider a seat with no reading
  // while measured ones exist, so without this the first seat measured would
  // take every session.
  const reading = {
    status: "allowed", fiveHourUtil: 0.1, fiveHourReset: Math.floor(now / 1000) + 3 * 3600, sevenDayUtil: 0.3, sevenDayReset: Math.floor(now / 1000) + 100 * 3600,
    claim: "", plan: "", requestsLimit: 0, lastUpdated: now,
  };
  writeFileSync(join(dir, "account-state.json"), JSON.stringify({
    version: 1, savedAt: now, accounts: Object.fromEntries(SEATS.map(id => [id, { rateLimits: reading, sevenDayWindowSeen: true }])),
  }));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ proxySecret: SECRET, routing: { softCapUtil: 0.98, weeklyPace: { enabled: true } } }));
  f.upstream = upstream;
  f.upstreamPort = (upstream.address() as { port: number }).port;
  const oauth = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    // Slow, as the live endpoint is next to a local hop: the hop answers while
    // the refresh is still out, so the origin seat still reads as retainable.
    req.on("end", () => setTimeout(() => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "temporarily_unavailable" }));
    }, 1500));
  });
  oauth.listen(0, "127.0.0.1");
  await once(oauth, "listening");
  f.oauth = oauth;
  f.oauthPort = (oauth.address() as { port: number }).port;
  return f;
}

/** `stop` resolves true when the router exited by itself on SIGTERM (and so wrote its files), false when it had to be killed. */
interface Router { base: string; child: ChildProcess; stop: () => Promise<boolean> }

async function startRouter(f: Fixture): Promise<Router> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
    ACCOUNTS_PATH: join(f.dir, "accounts.json"), CONFIG_PATH: join(f.dir, "config.json"), SESSIONS_PATH: join(f.dir, "sessions.json"),
    ACCOUNT_STATE_PATH: join(f.dir, "account-state.json"),
    CC_ROUTER_OAUTH_TOKEN_URL: `http://127.0.0.1:${f.oauthPort}/v1/oauth/token`,
  };
  delete env["USAGE_PATH"];
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${f.upstreamPort}'});`], { env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout!.on("data", b => { logs += b; });
  child.stderr!.on("data", b => { logs += b; });
  await waitForListening(child, () => logs);
  return {
    base: `http://127.0.0.1:${port}`, child,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 15_000))]);
      if (child.exitCode !== null) return true;
      child.kill("SIGKILL");
      return false;
    },
  };
}

const send = (base: string, session: string) => fetch(`${base}/v1/messages`, {
  method: "POST", signal: AbortSignal.timeout(8000),
  headers: {
    "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.327 (external, cli)",
    "x-claude-code-session-id": session, authorization: `Bearer ${SECRET}`,
  },
  body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
});

interface Health {
  balance: { seats: Array<{ id: string; load: number; weekRatio: number | null }> };
  placements: { lastHour: Record<string, number> };
}
const health = async (base: string): Promise<Health> => await (await fetch(`${base}/cc-router/health`)).json() as Health;

/**
 * Send fresh sessions, all seats reading alike, until one sits on the seat
 * that is about to turn dry; then turn it dry and let that session's next
 * request bring back the dry reading. Returns the session: pinned seconds ago
 * to a seat that now reads dry while the others have a surplus.
 */
async function warm(f: Fixture, base: string, tag: string): Promise<string> {
  let onDry = "";
  for (let i = 0; i < 12 && !onDry; i++) {
    const s = `${tag}-${i}`;
    expect((await send(base, s)).status).toBe(200);
    if (f.served[f.served.length - 1] === DRY_SEAT) onDry = s;
  }
  expect(onDry).not.toBe("");
  f.dry = true;
  expect((await send(base, onDry)).status).toBe(200);
  expect(f.served[f.served.length - 1]).toBe(DRY_SEAT);
  return onDry;
}

/** The dry seat reads as dry and another seat as a surplus target, so only the dwell keeps a pin on it. */
function expectMoveWouldPay(h: Health): void {
  const dry = h.balance.seats.find(s => s.id === DRY_SEAT)!.weekRatio!;
  const best = Math.max(...h.balance.seats.filter(s => s.id !== DRY_SEAT).map(s => s.weekRatio!));
  expect(dry).toBeLessThan(0.75);
  expect(best - dry).toBeGreaterThan(0.35);
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture();
  try { await run(f); } finally {
    await new Promise<void>(res => f.upstream.close(() => res()));
    await new Promise<void>(res => f.oauth.close(() => res()));
    rmSync(f.dir, { recursive: true, force: true });
  }
}

describe("through a real router reload", () => {
  it("saves pinnedAt and the load window, restores them, and keeps a fresh pin on its dry seat after the restart", async () => {
    await withFixture(async f => {
      let r = await startRouter(f);
      let sid = "";
      let cleanExit = false;
      try {
        sid = await warm(f, r.base, "sess");
        expectMoveWouldPay(await health(r.base));
      } finally { cleanExit = await r.stop(); }
      // The files below are written at shutdown; a killed router leaves them stale.
      expect(cleanExit).toBe(true);

      const saved = JSON.parse(readFileSync(join(f.dir, "sessions.json"), "utf8")) as { sessions: Array<{ sessionId: string; accountId: string; pinnedAt?: number }>; load: unknown[] };
      const mine = saved.sessions.find(s => s.sessionId === sid)!;
      expect(mine.accountId).toBe(DRY_SEAT);
      expect(typeof mine.pinnedAt).toBe("number");
      expect(Array.isArray(saved.load) && saved.load.length).toBeGreaterThan(0);

      r = await startRouter(f);
      try {
        // Before any request: the load window is back from the file, and so are the readings.
        const h0 = await health(r.base);
        expect(h0.balance.seats.reduce((n, s) => n + s.load, 0)).toBeGreaterThan(0);
        expectMoveWouldPay(h0);
        // The dry seat has no surplus and another seat does, so without the dwell this would move now.
        const before = f.served.length;
        expect((await send(r.base, sid)).status).toBe(200);
        expect(f.served[before]).toBe(DRY_SEAT);
        expect((await health(r.base)).placements.lastHour["weekly-pace"] ?? 0).toBe(0);
      } finally { await r.stop(); }
    });
  }, 60_000);

  it("honours a sessions.json written before pinnedAt and the load window existed, with the dwell taken from lastSeen", async () => {
    await withFixture(async f => {
      const sid = "from-the-old-build";
      writeFileSync(join(f.dir, "sessions.json"), JSON.stringify({
        version: 1, sessions: [{ sessionId: sid, provider: "anthropic", accountId: DRY_SEAT, lastSeen: Date.now() - 60_000 }],
      }));
      const r = await startRouter(f);
      try {
        await warm(f, r.base, "other");
        expectMoveWouldPay(await health(r.base));
        // The restored session's seat is dry and a surplus seat exists; lastSeen
        // one minute ago stands in for pinnedAt, so it stays.
        const before = f.served.length;
        expect((await send(r.base, sid)).status).toBe(200);
        expect(f.served[before]).toBe(DRY_SEAT);
        expect((await health(r.base)).placements.lastHour["weekly-pace"] ?? 0).toBe(0);
      } finally { await r.stop(); }
    });
  }, 60_000);

  /** A failover with `statuses` answered by the pinned seat and then each hop, in order; returns the seat that answered. */
  async function failover(f: Fixture, base: string, sid: string, statuses: number[]): Promise<string> {
    const n = f.served.length;
    f.failQueue.push(...statuses);
    expect((await send(base, sid)).status).toBe(200);
    const answered = f.served[n]!;
    expect(answered).not.toBe(DRY_SEAT);
    expect((await send(base, sid)).status).toBe(200);
    return answered;
  }

  it("does not re-pin after a transient 503 from the pinned seat: another seat answers once, the next request goes back", async () => {
    await withFixture(async f => {
      const r = await startRouter(f);
      try {
        const sid = await warm(f, r.base, "sess");
        await failover(f, r.base, sid, [503]);
        expect(f.served[f.served.length - 1]).toBe(DRY_SEAT);
        expect((await health(r.base)).placements.lastHour["unservable"] ?? 0).toBe(0);
      } finally { await r.stop(); }
    });
  }, 60_000);

  it("judges the re-pin on the seat the session was on, not on the last hop: pinned 503, hop 429, next hop answers, the pin stays", async () => {
    await withFixture(async f => {
      const r = await startRouter(f);
      try {
        const sid = await warm(f, r.base, "sess");
        await failover(f, r.base, sid, [503, 429]);
        expect(f.served[f.served.length - 1]).toBe(DRY_SEAT);
        expect((await health(r.base)).placements.lastHour["unservable"] ?? 0).toBe(0);
      } finally { await r.stop(); }
    });
  }, 60_000);

  it("follows the answering seat after a 401 from the pinned seat, which leaves that seat retainable while its token is refreshed", async () => {
    await withFixture(async f => {
      const r = await startRouter(f);
      try {
        const sid = await warm(f, r.base, "sess");
        const answered = await failover(f, r.base, sid, [401]);
        expect(f.served[f.served.length - 1]).toBe(answered);
        expect((await health(r.base)).placements.lastHour["unservable"]).toBe(1);
      } finally { await r.stop(); }
    });
  }, 60_000);

  it("re-pins to the seat that answered when the pinned seat cools: pinned 429, hop 503, next hop answers and keeps the session", async () => {
    await withFixture(async f => {
      const r = await startRouter(f);
      try {
        const sid = await warm(f, r.base, "sess");
        const answered = await failover(f, r.base, sid, [429, 503]);
        expect(f.served[f.served.length - 1]).toBe(answered);
        expect((await health(r.base)).placements.lastHour["unservable"]).toBe(1);
      } finally { await r.stop(); }
    });
  }, 60_000);
});
