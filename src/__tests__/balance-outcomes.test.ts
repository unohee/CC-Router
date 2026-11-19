import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { QuotaHistory, strandedSeats, STRANDED_WEEK_LEFT, type QuotaFile } from "../proxy/quota-history.js";
import { balanceView, OUTCOMES_DAYS } from "../proxy/balance-view.js";
import { emptyPlacementCounts } from "../proxy/seat-metrics.js";
import { HOUR_MS, DAY_MS } from "../proxy/usage-history.js";
import { WEEK_SEC } from "../proxy/weekly-pace.js";
import type { Account } from "../proxy/types.js";
import { waitForListening } from "./helpers/router-process.js";

// Outcomes: whether placement worked, per seat, kept in the hourly quota store.
// What placement sees right now is in health.balance already; these say what
// it achieved: how much of a seat's week was still unused when the week reset
// (quota that could have served sessions), and how long a seat sat at the cap
// while another seat under the cap still had week to give (sessions on it had
// to move or wait although the pool had room).

const NOW = Date.UTC(2026, 10, 19, 9, 30);
const nowSec = NOW / 1000;
const H = 3600;
const MIN = 60_000;

const reading = (sevenUtil: number, sevenReset: number) => ({ fiveHourUtil: 0.1, fiveHourReset: nowSec + 2 * H, sevenDayUtil: sevenUtil, sevenDayReset: sevenReset });

describe("a weekly reset", () => {
  it("is seen when a reading names a later reset time, and records the util the seat had reached", () => {
    const clock = { now: NOW };
    const q = new QuotaHistory({ now: () => clock.now });
    const r1 = nowSec + 10 * H;
    q.sample("a", reading(0.4, r1));
    clock.now += 2 * HOUR_MS;
    q.sample("a", reading(0.62, r1)); // same window, higher util
    clock.now += 9 * HOUR_MS;        // past r1
    q.sample("a", reading(0.03, r1 + WEEK_SEC)); // the new week
    const o = q.outcomes("a", 7 * DAY_MS, clock.now);
    expect(o.resets).toBe(1);
    expect(o.unusedAtReset).toBeCloseTo(0.38, 6);
    // Every response is watched, not just the one stored per hour: the second
    // reading above fell in a new hour, but a third in the same hour counts too.
    q.sample("a", reading(0.9, r1 + WEEK_SEC));
    clock.now += WEEK_SEC * 1000;
    q.sample("a", reading(0.01, r1 + 2 * WEEK_SEC));
    expect(q.outcomes("a", 14 * DAY_MS, clock.now)).toMatchObject({ resets: 2 });
    expect(q.outcomes("a", 14 * DAY_MS, clock.now).unusedAtReset).toBeCloseTo((0.38 + 0.1) / 2, 6);
  });

  it("is not wiped by a response that carries 5-hour headers only: the week the seat had reached stays what the reset records", () => {
    const clock = { now: NOW };
    const q = new QuotaHistory({ now: () => clock.now });
    const r1 = nowSec + 10 * H;
    q.sample("a", reading(0.99, r1));
    q.sample("a", { fiveHourUtil: 0.5, fiveHourReset: nowSec + 2 * H, sevenDayUtil: 0, sevenDayReset: 0 }); // a 429 with a five-hour claim says this
    clock.now = (r1 + 60) * 1000;
    q.sample("a", reading(0.0, r1 + WEEK_SEC));
    expect(q.outcomes("a", 7 * DAY_MS, clock.now)).toMatchObject({ resets: 1, unusedAtReset: expect.closeTo(0.01, 6) as number });
  });

  it("is not a jittered reset time, and is counted once however many readings name the new window", () => {
    const clock = { now: NOW };
    const q = new QuotaHistory({ now: () => clock.now });
    const r1 = nowSec + 10 * H;
    q.sample("a", reading(0.5, r1));
    q.sample("a", reading(0.5, r1 + 30)); // 30 s of jitter: the same window
    expect(q.outcomes("a", 7 * DAY_MS).resets).toBe(0);
    clock.now = (r1 + 60) * 1000;
    q.sample("a", reading(0.0, r1 + WEEK_SEC));
    q.sample("a", reading(0.1, r1 + WEEK_SEC));
    q.sample("a", reading(0.2, r1 + WEEK_SEC + 10));
    expect(q.outcomes("a", 7 * DAY_MS, clock.now).resets).toBe(1);
  });

  it("is upstream's word: a new window named before the old reset time by this clock is a reset all the same", () => {
    const q = new QuotaHistory({ now: () => NOW });
    const r1 = nowSec + 86_400;
    q.sample("a", reading(0.99, r1));
    q.sample("a", reading(0.02, r1 + WEEK_SEC));
    expect(q.outcomes("a", 7 * DAY_MS)).toMatchObject({ resets: 1, unusedAtReset: expect.closeTo(0.01, 6) as number });
    // But a reset further ahead than a window can reach is garbage.
    expect(q.noteReset("a", nowSec + 3 * WEEK_SEC, 0.5)).toBe(false);
  });

  it("is noted from what an idle seat last held once its reset time has passed, and not again when a reading then names the new window", () => {
    const clock = { now: NOW };
    const q = new QuotaHistory({ now: () => clock.now });
    const r1 = nowSec + 2 * H;
    q.sample("idle", reading(0.7, r1));
    clock.now = (r1 + H) * 1000;           // reset passed an hour ago, jitter not yet
    expect(q.noteElapsedResets(clock.now)).toBe(0);
    clock.now = (r1 + 2 * H) * 1000;
    expect(q.noteElapsedResets(clock.now)).toBe(1);
    expect(q.noteElapsedResets(clock.now)).toBe(0);
    q.sample("idle", reading(0.05, r1 + WEEK_SEC));
    const o = q.outcomes("idle", 7 * DAY_MS, clock.now);
    expect(o.resets).toBe(1);
    expect(o.unusedAtReset).toBeCloseTo(0.3, 6);
  });

  it("outside the window is not counted", () => {
    const q = new QuotaHistory({ now: () => NOW });
    expect(q.noteReset("a", nowSec - 8 * 86_400, 0.5)).toBe(true);
    expect(q.noteReset("a", nowSec - 2 * 86_400, 0.9)).toBe(true);
    expect(q.outcomes("a", 7 * DAY_MS)).toMatchObject({ resets: 1, unusedAtReset: expect.closeTo(0.1, 6) as number });
  });
});

describe("stranded minutes", () => {
  const seat = (id: string, util: number, hoursLeft: number, usable = true) => ({ id, usable, sevenDayUtil: util, sevenDayReset: nowSec + hoursLeft * H });

  it("are a seat at or past the cap while another usable seat under the cap has a fifth of its week left", () => {
    const cap = 0.98;
    expect(strandedSeats([seat("a", 0.99, 100), seat("b", 0.3, 100)], cap, nowSec)).toEqual(["a"]);
    expect(strandedSeats([seat("a", 0.98, 100), seat("b", 0.97, 100)], cap, nowSec)).toEqual(["a"]);
    // The other seat has too little week left to shelter anything.
    expect(strandedSeats([seat("a", 0.99, 100), seat("b", 0.3, STRANDED_WEEK_LEFT * 168 - 1)], cap, nowSec)).toEqual([]);
    expect(strandedSeats([seat("a", 0.99, 100), seat("b", 0.3, STRANDED_WEEK_LEFT * 168 + 1)], cap, nowSec)).toEqual(["a"]);
    // Both at the cap: nowhere to go, nobody stranded.
    expect(strandedSeats([seat("a", 0.99, 100), seat("b", 0.985, 100)], cap, nowSec)).toEqual([]);
    // A dead shelter (disabled, unhealthy, needs relogin) is no shelter, and a
    // dead seat at the cap is not stranded; a seat with no weekly window is neither.
    expect(strandedSeats([seat("a", 0.99, 100), seat("b", 0.3, 100, false)], cap, nowSec)).toEqual([]);
    expect(strandedSeats([seat("a", 0.99, 100, false), seat("b", 0.3, 100)], cap, nowSec)).toEqual([]);
    expect(strandedSeats([seat("a", 0.99, 100), { id: "c", usable: true, sevenDayUtil: 0, sevenDayReset: 0 }], cap, nowSec)).toEqual([]);
    // Two stranded, one shelter.
    expect(strandedSeats([seat("a", 0.99, 100), seat("b", 1.0, 50), seat("c", 0.5, 100)], cap, nowSec)).toEqual(["a", "b"]);
  });

  it("add up per hour and are summed over the window", () => {
    const clock = { now: NOW };
    const q = new QuotaHistory({ now: () => clock.now });
    for (let i = 0; i < 90; i++) { q.noteStranded("a", 1, clock.now); clock.now += MIN; }
    expect(q.outcomes("a", 7 * DAY_MS, clock.now).strandedMinutes).toBe(90);
    expect(q.outcomes("b", 7 * DAY_MS, clock.now).strandedMinutes).toBe(0);
    // Fractions (a tick shorter than a minute) add up too.
    for (let i = 0; i < 4; i++) q.noteStranded("a", 0.25, clock.now);
    expect(q.outcomes("a", 7 * DAY_MS, clock.now).strandedMinutes).toBe(91);
    // Hours older than the window fall out of the sum.
    expect(q.outcomes("a", 30 * MIN, clock.now).strandedMinutes).toBeLessThan(91);
    expect(q.noteStranded("a", 0, clock.now)).toBe(false);
    expect(q.noteStranded("a", -1, clock.now)).toBe(false);
  });
});

describe("in the file", () => {
  it("round-trips into a fresh store (a restart), adds the same hour's stranded minutes, keeps a reset once, and reads an old file without them", () => {
    const q = new QuotaHistory({ now: () => NOW });
    const r1 = nowSec - 86_400;
    q.sample("a", reading(0.5, nowSec + 100 * H));
    expect(q.noteReset("a", r1, 0.8)).toBe(true);
    q.noteStranded("a", 12.5);
    q.noteStranded("b", 3);
    const file = q.toFile();
    expect(file.resets).toEqual([[r1, "a", 0.8, nowSec]]);
    expect(file.stranded).toHaveLength(2);
    expect(file.stranded!.find(s => s[1] === "a")![2]).toBe(12.5);

    const restarted = new QuotaHistory({ now: () => NOW + MIN });
    // Recorded before the file is merged (the process ran a minute before restore finished).
    restarted.noteStranded("a", 0.5);
    expect(restarted.restore(JSON.parse(JSON.stringify(file)))).toBe(true);
    expect(restarted.outcomes("a", 7 * DAY_MS)).toEqual({ resets: 1, unusedAtReset: expect.closeTo(0.2, 6) as number, strandedMinutes: 13 });
    expect(restarted.outcomes("b", 7 * DAY_MS)).toEqual({ resets: 0, unusedAtReset: null, strandedMinutes: 3 });
    // Merging the same file again does not double the reset; stranded minutes of
    // an hour already held do add (the file's figure is from before the restart,
    // and a second restore of the same file is not something the router does).
    restarted.restore(JSON.parse(JSON.stringify(file)));
    expect(restarted.outcomes("a", 7 * DAY_MS).resets).toBe(1);

    const old: QuotaFile = { version: 1, rows: file.rows, spent: file.spent };
    const fromOld = new QuotaHistory({ now: () => NOW });
    expect(fromOld.restore(old)).toBe(true);
    expect(fromOld.outcomes("a", 7 * DAY_MS)).toEqual({ resets: 0, unusedAtReset: null, strandedMinutes: 0 });
    // Malformed rows are skipped one by one.
    const bad = { ...file, resets: [[r1, 42, 0.5], ["x", "a", 0.5], [r1 - 10, "a", 11], [r1, "a"]], stranded: [[1, "a"], [1, "a", -2], ["h", "a", 1]] };
    const tolerant = new QuotaHistory({ now: () => NOW });
    expect(tolerant.restore(bad)).toBe(true);
    expect(tolerant.outcomes("a", 7 * DAY_MS)).toEqual({ resets: 0, unusedAtReset: null, strandedMinutes: 0 });
  });

  it("seeds the last reading per seat from its newest hourly row, so a reset across the restart is still seen", () => {
    const before = new QuotaHistory({ now: () => NOW });
    const r1 = nowSec + 5 * H;
    before.sample("a", reading(0.55, r1), NOW - 3 * HOUR_MS);
    before.sample("a", reading(0.6, r1), NOW - HOUR_MS);
    // The newest row has five-hour headers only: it does not stand in for the week.
    before.sample("a", { fiveHourUtil: 0.2, fiveHourReset: nowSec + H, sevenDayUtil: 0, sevenDayReset: 0 }, NOW);
    const after = new QuotaHistory({ now: () => NOW + 6 * HOUR_MS });
    after.restore(before.toFile());
    after.sample("a", reading(0.02, r1 + WEEK_SEC));
    const o = after.outcomes("a", 7 * DAY_MS);
    expect(o.resets).toBe(1);
    // The util of the newest row (an hour before the restart), not the older one.
    expect(o.unusedAtReset).toBeCloseTo(0.4, 6);
  });

  it("ages out with the readings' retention", () => {
    const clock = { now: NOW };
    const q = new QuotaHistory({ now: () => clock.now, retentionDays: 10 });
    q.noteReset("a", nowSec - 86_400, 0.5);
    q.noteStranded("a", 5);
    clock.now = NOW + 11 * DAY_MS;
    expect(q.prune()).toBe(2);
    expect(q.toFile().resets).toEqual([]);
    expect(q.toFile().stranded).toEqual([]);
  });
});

describe("health balance", () => {
  it("carries the outcomes per seat over the last seven days, rounded for the page", () => {
    const q = new QuotaHistory({ now: () => NOW });
    q.noteReset("a", nowSec - 86_400, 0.84);
    q.noteReset("a", nowSec - 3 * 86_400, 0.7);
    q.noteReset("a", nowSec - 9 * 86_400, 0.1); // outside the window
    q.noteStranded("a", 47.4);
    const acct = (id: string) => ({
      id, enabled: true, healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0,
      rateLimits: { fiveHourUtil: 0.1, fiveHourReset: nowSec + 3 * H, sevenDayUtil: 0.3, sevenDayReset: nowSec + 100 * H },
    }) as unknown as Account;
    const v = balanceView([acct("a"), acct("b")], null, new Map(), { lastHour: emptyPlacementCounts(), lastDay: emptyPlacementCounts() }, NOW,
      (id, windowMs) => q.outcomes(id, windowMs));
    expect(OUTCOMES_DAYS).toBe(7);
    expect(v.seats.find(s => s.id === "a")!.outcomes).toEqual({ days: 7, resets: 2, unusedAtReset: 0.23, strandedMinutes: 47 });
    expect(v.seats.find(s => s.id === "b")!.outcomes).toEqual({ days: 7, resets: 0, unusedAtReset: null, strandedMinutes: 0 });
  });

  it("is wired: the server hands quotaHistory.outcomes to the view, ticks stranded seats and elapsed resets, and smoke prints them", () => {
    const src = readFileSync(fileURLToPath(new URL("../proxy/server.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/\(id, windowMs\) => quotaHistory\.outcomes\(id, windowMs\)/);
    expect(src).toMatch(/quotaHistory\.noteElapsedResets\(now\)/);
    expect(src).toMatch(/for \(const id of strandedSeats\(seats, cap, now \/ 1000\)\) quotaHistory\.noteStranded\(id, outcomesTickMs \/ 60_000, now\)/);
    expect(src).toMatch(/usable: a\.enabled && a\.healthy && a\.authState !== "needs-relogin"/);
    const smoke = readFileSync(fileURLToPath(new URL("../../scripts/smoke-remote.sh", import.meta.url)), "utf8");
    expect(smoke).toMatch(/x\.outcomes\.strandedMinutes/);
    expect(smoke).toMatch(/\[smoke\] outcomes/);
  });
});

// ─── Through a real router ──────────────────────────────────────────────────

const SECRET = "s3cret-for-the-balance-outcomes-test";

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

interface Fixture {
  dir: string; upstream: Server; upstreamPort: number;
  /** What each seat reports for its week; changed by the test. */
  week: Record<string, { util: string; reset: number }>;
  /** Seats that answered, in order. */
  served: string[];
}

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-balance-outcomes-"));
  const nowS = Math.floor(Date.now() / 1000);
  // "a" is at the cap with a day left; "b" is under it with five days left, but
  // with less than 40% of its window free, so the pin on "a" is not shed to it
  // (CAP_RELIEF_ROOM) and "a" keeps answering its session.
  const f: Fixture = {
    dir, upstream: null as unknown as Server, upstreamPort: 0, served: [],
    week: { a: { util: "0.99", reset: nowS + 86_400 }, b: { util: "0.65", reset: nowS + 5 * 86_400 } },
  };
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const seat = String(req.headers["authorization"] ?? "").replace(/^Bearer fixture-/, "");
      const w = f.week[seat] ?? { util: "0", reset: 0 };
      f.served.push(seat);
      res.writeHead(200, {
        "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.10", "anthropic-ratelimit-unified-5h-reset": String(nowS + 3 * 3600),
        "anthropic-ratelimit-unified-7d-utilization": w.util, "anthropic-ratelimit-unified-7d-reset": String(w.reset),
      });
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  f.upstream = upstream;
  f.upstreamPort = (upstream.address() as { port: number }).port;
  // "c" is disabled: it takes no request (and is no shelter), but its history is still judged.
  writeFileSync(join(dir, "accounts.json"), JSON.stringify(["a", "b", "c"].map(id => ({
    id, accessToken: `fixture-${id}`, refreshToken: "fixture", expiresAt: Date.now() + 86_400_000, scopes: [], enabled: id !== "c",
  }))));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ proxySecret: SECRET, routing: { softCapUtil: 0.98, weeklyPace: { enabled: true } } }));
  return f;
}

interface Router { base: string; child: ChildProcess; stop: () => Promise<boolean> }

async function startRouter(f: Fixture): Promise<Router> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
    ACCOUNTS_PATH: join(f.dir, "accounts.json"), CONFIG_PATH: join(f.dir, "config.json"), SESSIONS_PATH: join(f.dir, "sessions.json"),
    QUOTA_HISTORY_PATH: join(f.dir, "quota-history.json"), ACCOUNT_STATE_PATH: join(f.dir, "account-state.json"),
  };
  delete env["USAGE_PATH"];
  // A 100 ms tick, so stranded time accrues within the test.
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${f.upstreamPort}', outcomesTickMs: 100});`], { env, stdio: ["ignore", "pipe", "pipe"] });
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

interface Health { balance: { seats: Array<{ id: string; outcomes: { days: number; resets: number; unusedAtReset: number | null; strandedMinutes: number } }> } }
const health = async (base: string): Promise<Health> => await (await fetch(`${base}/cc-router/health`)).json() as Health;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("through a real router", () => {
  it("restores outcomes from the quota file, sees a weekly reset from the headers, strands a seat at the cap, and saves all of it at shutdown", async () => {
    const f = await fixture();
    const nowS = Math.floor(Date.now() / 1000);
    const hourS = Math.floor(Date.now() / HOUR_MS) * 3600;
    // From a previous run: one reset for "a" two days ago at 60%, 30 minutes
    // stranded this hour, and last hour's reading of "a" (99% of the week, a
    // day left), which is what the router will compare the next reading with.
    // "c" (disabled now) was last read three hours ago at 45% with its reset
    // two hours ago, and gets no request here: the tick alone must note it.
    writeFileSync(join(f.dir, "quota-history.json"), JSON.stringify({
      version: 1,
      rows: [
        [hourS - 3600, "a", hourS - 3600, 0.1, nowS + 3 * 3600, 0.99, nowS + 86_400, null],
        [hourS - 3 * 3600, "c", hourS - 3 * 3600, 0.1, nowS + 3 * 3600, 0.45, nowS - 2 * 3600, null],
      ],
      resets: [[nowS - 2 * 86_400, "a", 0.6]], stranded: [[hourS, "a", 30]],
    }));
    // The pool's last readings (account-state.json, as a live pool has): "a" at
    // the cap with a day left, "b" at 65% with five days left. From the first
    // tick "a" is stranded: at the cap while "b" is under it with week to give.
    const rl = (util: number, reset: number) => ({ status: "allowed", fiveHourUtil: 0.1, fiveHourReset: nowS + 3 * 3600, sevenDayUtil: util, sevenDayReset: reset, claim: "", plan: "", requestsLimit: 0, lastUpdated: Date.now() });
    writeFileSync(join(f.dir, "account-state.json"), JSON.stringify({
      version: 1, savedAt: Date.now(),
      accounts: { a: { rateLimits: rl(0.99, nowS + 86_400), sevenDayWindowSeen: true }, b: { rateLimits: rl(0.65, nowS + 5 * 86_400), sevenDayWindowSeen: true } },
    }));
    // A session pinned to "a": placement would not choose a seat over the cap,
    // but a pin is kept there, and its answer is where the new week shows.
    writeFileSync(join(f.dir, "sessions.json"), JSON.stringify({ version: 1, sessions: [{ sessionId: "on-a", provider: "anthropic", accountId: "a", lastSeen: Date.now() - 60_000 }] }));
    const r = await startRouter(f);
    let clean = false;
    try {
      const h0 = await health(r.base);
      const a0 = h0.balance.seats.find(s => s.id === "a")!.outcomes;
      expect(a0).toMatchObject({ days: OUTCOMES_DAYS, resets: 1, unusedAtReset: 0.4, strandedMinutes: 30 });
      expect(h0.balance.seats.find(s => s.id === "b")!.outcomes).toMatchObject({ resets: 0, unusedAtReset: null, strandedMinutes: 0 });

      await sleep(1200);
      // "c" never answered: its reset two hours ago was noted by the tick from the 45% it last held.
      expect(f.served).toEqual([]);
      expect((await health(r.base)).balance.seats.find(s => s.id === "c")!.outcomes).toMatchObject({ resets: 1, unusedAtReset: 0.55, strandedMinutes: 0 });
      // "a" reports a new week: its reset moved on and it starts at 2%. (By
      // this clock the old reset was a day away; upstream's word counts.)
      f.week["a"] = { util: "0.02", reset: nowS + 86_400 + WEEK_SEC };
      expect((await send(r.base, "on-a")).status).toBe(200);
      expect((await send(r.base, "on-a")).status).toBe(200);
      expect(f.served).toEqual(["a", "a"]);
      const h1 = await health(r.base);
      const a1 = h1.balance.seats.find(s => s.id === "a")!.outcomes;
      expect(a1.resets).toBe(2);
      // (0.4 + 0.01) / 2, rounded to 3 places.
      expect(a1.unusedAtReset).toBeCloseTo(0.205, 3);
      expect(a1.strandedMinutes).toBe(30); // 30 + about a second, rounded
    } finally { clean = await r.stop(); }
    try {
      expect(clean).toBe(true);
      const saved = JSON.parse(readFileSync(join(f.dir, "quota-history.json"), "utf8")) as QuotaFile;
      const resets = saved.resets!.filter(x => x[1] === "a");
      expect(resets).toHaveLength(2);
      expect(resets.map(x => x[2]).sort()).toEqual([0.6, 0.99]);
      // The early reset dates from when it was seen, so it shows in the window.
      expect(resets.find(x => x[2] === 0.99)![3]).toBeGreaterThanOrEqual(nowS);
      // The 30 restored minutes plus what the ticks added while "a" sat at the cap.
      const stranded = saved.stranded!.filter(x => x[1] === "a").reduce((n, x) => n + x[2], 0);
      expect(stranded).toBeGreaterThan(30);
      expect(stranded).toBeLessThan(31);
      expect(saved.stranded!.some(x => x[1] === "b" || x[1] === "c")).toBe(false);
      expect(saved.resets!.filter(x => x[1] === "c")).toEqual([[nowS - 2 * 3600, "c", 0.45, expect.any(Number)]]);
    } finally {
      await new Promise<void>(res => f.upstream.close(() => res()));
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 60_000);
});
