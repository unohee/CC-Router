import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { SessionRouter, type SessionTarget, type TargetMetrics } from "../proxy/session-router.js";
import { SCENARIOS } from "./balance/scenarios.js";
import { SCENARIOS_2, type Scenario2 } from "./balance/scenarios-2.js";
import { SCENARIOS_3 } from "./balance/scenarios-3.js";
import { regressions, score, type ScenarioScore } from "./balance/score.js";
import { regressions2, score2, type RunMetrics2, type ScenarioScore2 } from "./balance/score-2.js";
import { poolOutcomes, regressions3, score3, type ScenarioScore3 } from "./balance/score-3.js";
import { simulate, type SimResult } from "./balance/sim.js";
import { waitForListening } from "./helpers/router-process.js";

// A seat with no weekly reading competes for sessions instead of being shut
// out. Since run 2 (paceTier) a seat whose weekly ratio was null (never read,
// or its reset passed and the pool swept the reading to 0/0) was dropped from
// the session pool while any measured seat under the cap existed: it took no
// new session until a request without a session id rotated onto it, or a dry
// seat moved a pin onto it. Now it joins whichever tier the measured seats
// resolve to and competes on the score with util 0 and a full week to its
// reset; its load counts, so it wins a session or two and then the measured
// seats take over, and its first response gives it a reading.

const NOW = Date.UTC(2026, 10, 19, 7, 0);
const nowSec = NOW / 1000;
const H = 3600;
const MIN = 60_000;
const T = (accountId: string): SessionTarget => ({ provider: "anthropic", accountId });

interface Win { util: number; hoursLeft: number }
function seat(week: Win, five: Win = { util: 0, hoursLeft: 0 }, extra: Partial<TargetMetrics> = {}): TargetMetrics {
  const w = { util: week.util, resetAtSec: nowSec + week.hoursLeft * H };
  const f = five.hoursLeft > 0 ? { util: five.util, resetAtSec: nowSec + five.hoursLeft * H } : { util: 0, resetAtSec: 0 };
  const bind = w.util > f.util ? w : f;
  return { util: bind.util, resetAtSec: bind.resetAtSec, pace: f, weekly: w, fiveHour: f, ...extra };
}
/** What the pool hands placement for a seat whose reading was swept (reset passed) or never taken. */
const UNREAD: TargetMetrics = { util: 0, resetAtSec: 0, pace: { util: 0, resetAtSec: 0 }, weekly: { util: 0, resetAtSec: 0 }, fiveHour: { util: 0, resetAtSec: 0 } };
const PACE = { slack: 0.1, migrateAhead: 0.15, fiveHour: true, fiveHourSlack: 0.2 };
const LIVE = { softCapUtil: 0.98, weeklyPace: PACE };

describe("a seat with no weekly reading", () => {
  // Two measured seats on pace with most of their weeks (nothing is dry, so no
  // pin ever moves for pace) and one seat never read.
  const onPace = (t: SessionTarget): TargetMetrics => t.accountId === "fresh" ? UNREAD : seat({ util: 0.3, hoursLeft: 100 });
  const pool = ["a", "b", "fresh"].map(T);

  it("is placeable and on-pace in the explanation while measured seats under the cap exist", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const x = r.explain(pool, () => true, onPace)!;
    expect(x.get("anthropic:fresh")).toMatchObject({ placeable: true, tier: "on-pace", weekRatio: null });
    expect(x.get("anthropic:a")!.placeable).toBe(true);
  });

  it("takes a new session within the first few placements, then yields to the measured seats as its load counts", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const picks = Array.from({ length: 12 }, (_, i) => r.resolve(`s${i}`, pool, () => true, onPace)!.accountId);
    const first = picks.indexOf("fresh");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(4);
    // Not every session: the measured seats keep taking most of them.
    expect(picks.filter(p => p === "fresh").length).toBeLessThanOrEqual(4);
    expect(picks.filter(p => p !== "fresh").length).toBeGreaterThanOrEqual(8);
  });

  it("is judged on its reading once it has one: a fresh week on pace competes as any seat, a dry one waits", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    // After its first response the seat reports 2% of a new week.
    const read = (t: SessionTarget): TargetMetrics => t.accountId === "fresh" ? seat({ util: 0.02, hoursLeft: 167 }) : seat({ util: 0.3, hoursLeft: 100 });
    expect(r.explain(pool, () => true, read)!.get("anthropic:fresh")).toMatchObject({ placeable: true, tier: "on-pace" });
    // A seat that reads dry on its week waits while the others are on pace, as before.
    const dry = (t: SessionTarget): TargetMetrics => t.accountId === "fresh" ? seat({ util: 0.9, hoursLeft: 100 }) : seat({ util: 0.3, hoursLeft: 100 });
    expect(r.explain(pool, () => true, dry)!.get("anthropic:fresh")).toMatchObject({ placeable: false, tier: "behind" });
  });

  it("joins the tier the measured seats resolve to: week-ok, or behind with pace as a factor", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const weekOk = (t: SessionTarget): TargetMetrics => t.accountId === "fresh" ? UNREAD : seat({ util: 0.3, hoursLeft: 100 }, { util: 0.9, hoursLeft: 4.5 });
    const x1 = r.explain(pool, () => true, weekOk)!;
    expect(x1.get("anthropic:a")!.tier).toBe("week-ok");
    expect(x1.get("anthropic:fresh")!.placeable).toBe(true);
    const behind = (t: SessionTarget): TargetMetrics => t.accountId === "fresh" ? UNREAD : seat({ util: 0.7, hoursLeft: 100 });
    const x2 = r.explain(pool, () => true, behind)!;
    expect(x2.get("anthropic:a")!.tier).toBe("behind");
    expect(x2.get("anthropic:fresh")!.placeable).toBe(true);
    expect(x2.get("anthropic:a")!.placeable).toBe(true);
  });

  it("is still the only candidate when every measured seat is over the cap, and a pool of only unread seats rotates", () => {
    const over = (t: SessionTarget): TargetMetrics => t.accountId === "fresh" ? UNREAD : seat({ util: 0.99, hoursLeft: 50 });
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    expect(r.resolve("s", pool, () => true, over)!.accountId).toBe("fresh");
    const all = new SessionRouter({ now: () => NOW, ...LIVE });
    const picks = new Set(Array.from({ length: 6 }, (_, i) => all.resolve(`u${i}`, pool, () => true, () => UNREAD)!.accountId));
    expect(picks.size).toBeGreaterThan(1);
  });

  it("is a relief target for a pin leaving a dry seat, as before", () => {
    const clock = { now: NOW };
    const r = new SessionRouter({ now: () => clock.now, ...LIVE });
    const dryA = (t: SessionTarget): TargetMetrics => t.accountId === "fresh" ? UNREAD : t.accountId === "a" ? seat({ util: 0.85, hoursLeft: 100 }) : seat({ util: 0.86, hoursLeft: 100 });
    r.restore([{ sessionId: "p", provider: "anthropic", accountId: "a", lastSeen: NOW - 40 * MIN, pinnedAt: NOW - 40 * MIN }]);
    expect(r.resolve("p", pool, () => true, dryA)!.accountId).toBe("fresh");
  });
});

// ─── In the balance simulator ───────────────────────────────────────────────

describe("in the balance simulator", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterAll(() => { vi.useRealTimers(); });

  const base1 = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/balance/baseline.json", import.meta.url)), "utf8")) as { scenarios: Record<string, ScenarioScore> };
  const base2 = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/balance/baseline-2.json", import.meta.url)), "utf8")) as { scenarios: Record<string, ScenarioScore2> };
  const base3 = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/balance/baseline-3.json", import.meta.url)), "utf8")) as { scenarios: Record<string, ScenarioScore3> };
  const setClock = (ms: number) => vi.setSystemTime(ms);
  const m2 = (r: SimResult): RunMetrics2 => {
    const w = Object.values(r.queueWaitBySeat);
    return { ...r.metrics, overspendAtEnd: r.overspendAtEnd, queueWait: w.reduce((a, b) => a + b, 0), queueWaitMaxSeat: Math.max(0, ...w) };
  };
  const s3 = (r: SimResult): ScenarioScore3 => {
    const p = poolOutcomes(r.outcomesBySeat);
    return score3({ ...m2(r), resets: p.resets, unusedShareAtReset: p.unusedShareAtReset, strandedSeatMinutes: r.strandedSeatMinutes, outcomesBySeat: r.outcomesBySeat });
  };

  it("is no worse than any of the three baselines on any pool", () => {
    const worse: string[] = [];
    for (const sc of SCENARIOS) worse.push(...regressions(sc.name, score(simulate(sc, { setClock }).metrics), base1.scenarios[sc.name]!));
    for (const sc of [...SCENARIOS_2, ...SCENARIOS_3]) {
      const r = simulate(sc, { setClock });
      if (base2.scenarios[sc.name]) worse.push(...regressions2(sc.name, score2(m2(r)), base2.scenarios[sc.name]!));
      worse.push(...regressions3(sc.name, s3(r), base3.scenarios[sc.name]!));
    }
    expect(worse).toEqual([]);
  }, 1_800_000);

  it("changes nothing on fresh-reset and live-week, where a dry seat already moved a pin onto the fresh seat within a minute of its reset", () => {
    // Recorded while freezing live-week (scenarios-3.ts): in both pools the
    // seats whose weeks reset are picked up by a pace move from a dry seat
    // (heewon, ratio 0.64-0.68) before any new session could reach them, so
    // the outcomes are the baseline's to the minute. The exclusion this
    // milestone removes bit only while no seat was dry and no request without
    // a session id arrived; the next test is that case.
    for (const name of ["fresh-reset", "live-week"]) {
      const sc = [...SCENARIOS_2, ...SCENARIOS_3].find(s => s.name === name)!;
      const cur = s3(simulate(sc, { setClock }));
      const base = base3.scenarios[name]!;
      expect(cur.strandedSeatMinutes).toBe(base.strandedSeatMinutes);
      expect(cur.unusedShareAtReset).toBeCloseTo(base.unusedShareAtReset, 6);
    }
  }, 1_800_000);

  it("no placement policy can be strictly better than baseline-3 on fresh-reset by stranded minutes: the floor set by the seats that start at the cap is above the gate", () => {
    // Stranded minutes are judged on readings. A seat that starts the run at
    // or past the soft cap reads so until its week resets (placement cannot
    // lower a reading; the cap keeps it from being spent further), and is
    // stranded every one of those minutes while any usable seat under the cap
    // has a fifth of its week left, which heewon, vega and kyte have all run.
    // In fresh-reset rigel (0.98, reset at 39 h) and lyra (0.98, reset after
    // the run) give 2,340 + 2,880 = 5,220 seat-minutes before any policy acts.
    // strictlyBetter3 needs fewer than baseline - max(5, 5%) = 5,216.45.
    const sc = SCENARIOS_2.find(s => s.name === "fresh-reset")!;
    const cap = (sc.routing as { softCapUtil: number }).softCapUtil;
    const runMin = sc.days * 24 * 60;
    const floor = sc.seats.filter(s => s.weeklyUtil >= cap).reduce((n, s) => n + Math.min(runMin, s.weeklyResetH * 60), 0);
    expect(floor).toBe(5220);
    const base = base3.scenarios["fresh-reset"]!;
    const gate = base.strandedSeatMinutes - Math.max(5, 0.05 * base.strandedSeatMinutes);
    expect(floor).toBeGreaterThan(gate);
    // The baseline's own figure for those two seats is the floor; what a policy
    // answers for is heewon's 271 (it reached the cap during the run), under the gate.
    expect(base.outcomesBySeat["rigel"]!.strandedMinutes + base.outcomesBySeat["lyra"]!.strandedMinutes).toBe(floor);
    // By unused share instead: rigel resets at the cap (0.02 is the cap's
    // own 2%); only vega, 47% left with 6 hours to its reset, could be spent
    // harder, and the score already prefers it about 9x (its hours to reset
    // divide the score). live-week's floor is rigel's 780 minutes (reset at
    // 13 h); its gate, 2,089, would need lyra (0.97 at the start) kept under
    // the cap all day, which leaves a point of its week unused at its reset:
    // the unused share then rises by exactly the 0.005 the gate allows.
    expect(base.outcomesBySeat["rigel"]!.unusedAtReset).toBeCloseTo(1 - cap, 6);
    const live = base3.scenarios["live-week"]!;
    expect(live.outcomesBySeat["rigel"]!.strandedMinutes).toBe(13 * 60);
  });

  it("a seat that resets while every other seat is on pace, with no session-less requests, serves its first session within minutes of its reset", () => {
    // fresh-reset reshaped (not a frozen pool): vega starts over the cap and
    // resets 6 minutes in; the other seats are on pace on their weeks (ratio
    // about 1.1, nothing dry, so no pin moves for pace); every request is
    // inside a session. Under the run-2 rule vega, its reading swept at the
    // reset, took no session all day (the run-1 metrics never saw it: vega's
    // unused quota is charged only at its next reset, a week away).
    const fresh = SCENARIOS_2.find(s => s.name === "fresh-reset")!;
    const sc: Scenario2 = {
      ...fresh, name: "fresh-reset-on-pace", days: 1,
      seats: fresh.seats.map(s => s.id === "vega" ? { ...s, weeklyUtil: 0.98, weeklyResetH: 0.1 }
        : s.id === "rigel" || s.id === "lyra" ? { ...s, weeklyUtil: 0.4, weeklyResetH: 120 }
        : { ...s, weeklyUtil: 0.25, weeklyResetH: 120 }),
      demand: { ...fresh.demand, noSessionShare: 0 },
    };
    const r = simulate(sc, { setClock });
    expect(r.outcomesBySeat["vega"]!.resets).toBe(1);
    const first = r.firstServedAtMs["vega"];
    expect(first).not.toBeNull();
    expect(first!).toBeGreaterThanOrEqual(6 * MIN);
    expect(first!).toBeLessThan(30 * MIN);
    // And it went on to carry a share of the day, not a token.
    expect(r.servedBySeat["vega"]!).toBeGreaterThan(0.05 * Object.values(r.servedBySeat).reduce((a, b) => a + b, 0));
  }, 600_000);
});

// ─── Through a real router ──────────────────────────────────────────────────

const SECRET = "s3cret-for-the-balance-explore-test";

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

interface Fixture { dir: string; served: string[]; upstream: Server; upstreamPort: number }

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-balance-explore-"));
  const served: string[] = [];
  const nowS = Math.floor(Date.now() / 1000);
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const seat = String(req.headers["authorization"] ?? "").replace(/^Bearer fixture-/, "");
      served.push(seat);
      // a and b report 30% of a week with 100 h left (on pace); c, freshly reset, reports 2% of a new week.
      const week = seat === "c" ? { util: "0.02", reset: nowS + 167 * 3600 } : { util: "0.30", reset: nowS + 100 * 3600 };
      res.writeHead(200, {
        "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.05", "anthropic-ratelimit-unified-5h-reset": String(nowS + 3 * 3600),
        "anthropic-ratelimit-unified-7d-utilization": week.util, "anthropic-ratelimit-unified-7d-reset": String(week.reset),
      });
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  writeFileSync(join(dir, "accounts.json"), JSON.stringify(["a", "b", "c"].map(id => ({
    id, accessToken: `fixture-${id}`, refreshToken: "fixture", expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }))));
  // The pool's last readings: a and b on pace with most of their weeks; c's
  // week reset two hours ago with no reading since (its saved reading says
  // 97% of a window whose reset has passed, which the pool sweeps to no
  // reading). Nothing is dry, so no pin moves; every request carries a
  // session id, so rotation never reaches c: only placement can.
  const rl = (util: number, reset: number) => ({ status: "allowed", fiveHourUtil: 0.05, fiveHourReset: nowS + 3 * 3600, sevenDayUtil: util, sevenDayReset: reset, claim: "", plan: "", requestsLimit: 0, lastUpdated: Date.now() - 3 * 3_600_000 });
  writeFileSync(join(dir, "account-state.json"), JSON.stringify({
    version: 1, savedAt: Date.now(),
    accounts: {
      a: { rateLimits: rl(0.3, nowS + 100 * 3600), sevenDayWindowSeen: true },
      b: { rateLimits: rl(0.3, nowS + 100 * 3600), sevenDayWindowSeen: true },
      c: { rateLimits: rl(0.97, nowS - 2 * 3600), sevenDayWindowSeen: true },
    },
  }));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ proxySecret: SECRET, routing: { softCapUtil: 0.98, weeklyPace: { enabled: true } } }));
  return { dir, served, upstream, upstreamPort: (upstream.address() as { port: number }).port };
}

interface Router { base: string; child: ChildProcess; stop: () => Promise<void> }

async function startRouter(f: Fixture): Promise<Router> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
    ACCOUNTS_PATH: join(f.dir, "accounts.json"), CONFIG_PATH: join(f.dir, "config.json"), SESSIONS_PATH: join(f.dir, "sessions.json"),
    ACCOUNT_STATE_PATH: join(f.dir, "account-state.json"), QUOTA_HISTORY_PATH: join(f.dir, "quota-history.json"),
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
      if (child.exitCode === null) child.kill("SIGKILL");
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

interface Health { balance: { seats: Array<{ id: string; tier: string; placeable: boolean; weekRatio: number | null; fiveHourReported: boolean | null }> } }

describe("through a real router", () => {
  it("places a new session on a seat whose weekly reset has passed within the first few placements, while two measured seats are under the cap", async () => {
    const f = await fixture();
    const r = await startRouter(f);
    try {
      // Before any request: c has no weekly reading (its saved window has reset), yet it is placeable and on-pace.
      const h0 = await (await fetch(`${r.base}/cc-router/health`)).json() as Health;
      const c0 = h0.balance.seats.find(s => s.id === "c")!;
      expect(c0).toMatchObject({ placeable: true, tier: "on-pace", weekRatio: null });
      expect(h0.balance.seats.filter(s => s.id !== "c").every(s => s.placeable && s.weekRatio !== null)).toBe(true);

      for (let i = 0; i < 5; i++) expect((await send(r.base, `sess-${i}`)).status).toBe(200);
      const firstC = f.served.indexOf("c");
      expect(firstC).toBeGreaterThanOrEqual(0);
      expect(firstC).toBeLessThan(4);
      // Its response gave it a reading: from here it is judged on its week like any seat.
      const h1 = await (await fetch(`${r.base}/cc-router/health`)).json() as Health;
      const c1 = h1.balance.seats.find(s => s.id === "c")!;
      expect(c1.weekRatio).not.toBeNull();
      expect(c1).toMatchObject({ placeable: true, tier: "on-pace" });
      // The measured seats kept taking sessions too: c did not take them all.
      expect(new Set(f.served).size).toBeGreaterThanOrEqual(2);
    } finally {
      await r.stop();
      await new Promise<void>(res => f.upstream.close(() => res()));
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 60_000);
});
