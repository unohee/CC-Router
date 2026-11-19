import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DAY_MS, HOUR_MS, type UsageBucket } from "../proxy/usage-history.js";
import { QuotaHistory, type QuotaReading } from "../proxy/quota-history.js";
import { measureWeeklySize, seatSizes } from "../proxy/seat-size.js";
import {
  COST_WEIGHTS, DEFAULT_SUPPLY_OPTIONS, capacityFromSeatSize, computeSupply, costWeighted, demandProfile, estimateCapacity,
  forecastDemand, projectExhaustion, type LiveAccount,
} from "../proxy/supply-model.js";
import { renderDashboardHtml } from "../proxy/web-dashboard.js";
import { waitForListening } from "./helpers/router-process.js";

// The supply model turns quota readings and hourly usage into: what one
// percent of each window buys per account, what the pool is expected to ask
// for, today's pool budget, and when an account runs out. Pure functions,
// tested on synthetic data with known answers.

const T0 = Date.UTC(2026, 10, 4, 0, 0);
const FIVE_RESET = Math.floor((T0 + 5 * HOUR_MS) / 1000);
const WEEK_RESET = Math.floor((T0 + 5 * DAY_MS) / 1000);

/** A reading at `h` hours after T0. */
function reading(h: number, five: number, seven: number, spentAt: number | null, over: Partial<{ fiveReset: number; sevenReset: number; id: string }> = {}): QuotaReading {
  const at = T0 + h * HOUR_MS + 5 * 60_000;
  return {
    hour: Math.floor(at / HOUR_MS) * HOUR_MS, accountId: over.id ?? "lyra", sampledAt: at,
    fiveHour: { util: five, resetAt: over.fiveReset ?? FIVE_RESET },
    sevenDay: { util: seven, resetAt: over.sevenReset ?? WEEK_RESET },
    spentAt,
  };
}

/** n hourly readings in one 7-day window, each 1% further, 1M tokens apart. */
function steadyWeek(n: number, perPercent = 1_000_000, id = "lyra"): QuotaReading[] {
  return Array.from({ length: n }, (_, i) => reading(i, 0, 0.1 + i * 0.01, i * perPercent, { id }));
}

describe("cost weighting", () => {
  it("weights by the API price ratios and ignores bad numbers", () => {
    expect(costWeighted({ input: 100, output: 10, cacheRead: 1000, cacheCreation: 40 })).toBe(100 + 50 + 100 + 50);
    expect(costWeighted({ input: -5, output: Number.NaN })).toBe(0);
    expect(COST_WEIGHTS.output / COST_WEIGHTS.input).toBe(5);
  });
});

describe("capacity", () => {
  // The 7-day capacity is the seat-size measurement (3 pairs, 0.08 moved, 14-day
  // window); the 5-hour one keeps the 24-pair pairing. `now` is the readings'
  // end: measureWeeklySize drops readings older than 14 days.
  const NOW = T0 + 2 * DAY_MS;

  it("7-day: is unknown until 3 pairs inside one window have moved 0.08, and says what it has against each gate", () => {
    // 3 readings, 2 pairs, moved 0.02.
    const few = estimateCapacity(steadyWeek(3), "sevenDay", undefined, NOW);
    expect(few).toMatchObject({ status: "unknown", tokensPerPercent: null, errorBand: null, samples: 2, minSamples: 3, minMoved: 0.08, reason: "too few samples" });
    expect(few.moved).toBeCloseTo(0.02, 6);
    // 5 readings, 4 pairs, moved 0.04: enough pairs, too little movement.
    expect(estimateCapacity(steadyWeek(5), "sevenDay", undefined, NOW)).toMatchObject({ status: "unknown", samples: 4, reason: "too little movement" });
  });

  it("7-day: is the ratio of spend to utilization moved once the gates pass, with the error band 0.01 / moved", () => {
    // 10 readings, 9 pairs, moved 0.09.
    const c = estimateCapacity(steadyWeek(10), "sevenDay", undefined, NOW);
    expect(c.status).toBe("ok");
    expect(c.samples).toBe(9);
    expect(c.tokensPerPercent).toBeCloseTo(1_000_000, 0);
    expect(c.errorBand).toBeCloseTo(0.01 / 0.09, 6);
    // The same figure placement sizes the seat by.
    const m = measureWeeklySize(steadyWeek(10), NOW);
    expect(c.tokensPerPercent! * 100).toBeCloseTo(m.tokensPerWeek!, 6);
    expect(c.errorBand).toBe(m.errorBand);
  });

  it("7-day: read from the seat sizes placement holds when they are given, so the two views cannot drift between refreshes", () => {
    const rs = steadyWeek(10);
    const sizes = seatSizes(["lyra"], rs, NOW);
    const s = computeSupply({ now: NOW, readings: [], buckets: [], since: null, live: [live(0, 0.4, NOW - 60_000, { id: "lyra", sevenReset: Math.floor((NOW + DAY_MS) / 1000) })], seatSizes: sizes });
    const cap = s.accounts[0]!.sevenDay.capacity;
    expect(cap).toMatchObject({ status: "ok", samples: 9 });
    expect(cap.tokensPerPercent).toBeCloseTo(sizes.get("lyra")!.tokensPerWeek! / 100, 6);
    expect(cap.errorBand).toBe(sizes.get("lyra")!.errorBand);
    // Without the sizes, measured from the readings: the same figure.
    const fromReadings = estimateCapacity(rs, "sevenDay", undefined, NOW);
    expect(cap.tokensPerPercent).toBeCloseTo(fromReadings.tokensPerPercent!, 6);
    // A size that is a configured weight or equal is not a capacity.
    const weight = capacityFromSeatSize({ relative: 2, source: "weight", tokensPerWeek: null, samples: 1, spanHours: 1, errorBand: null, moved: 0.02 });
    expect(weight).toMatchObject({ status: "unknown", reason: "too few samples", samples: 1 });
  });

  it("7-day: readings older than 14 days are left out, as the seat-size measurement leaves them out", () => {
    expect(estimateCapacity(steadyWeek(10), "sevenDay", undefined, T0 + 15 * DAY_MS)).toMatchObject({ status: "unknown", samples: 0 });
    expect(estimateCapacity(steadyWeek(10), "sevenDay", undefined, T0 + 13 * DAY_MS).status).toBe("ok");
  });

  it("leaves out pairs across a reset, a lost counter, a falling utilization and readings without spend", () => {
    const rs = steadyWeek(10);
    // Clean pairs give 1M per percent; add pairs that would wreck it if counted.
    rs.push(reading(30, 0, 0.05, 99e9, { sevenReset: WEEK_RESET + 7 * 86400 })); // new window
    rs.push(reading(31, 0, 0.06, 1)); // counter went backwards (a crash), and the reset is back
    rs.push(reading(32, 0, 0.01, 2e9)); // utilization fell without a reset change
    rs.push(reading(33, 0, 0.9, null)); // from before spend was kept
    const c = estimateCapacity(rs, "sevenDay", undefined, NOW);
    expect(c.samples).toBe(9);
    expect(c.tokensPerPercent).toBeCloseTo(1_000_000, 0);
  });

  it("5-hour: keeps its own pairing: unknown until 24 pairs, and until they moved 0.02", () => {
    const rs = Array.from({ length: 30 }, (_, i) => reading(i, 0.02 * i, 0.002 * i, i * 400_000));
    expect(estimateCapacity(rs.slice(0, 24), "fiveHour", undefined, NOW)).toMatchObject({ status: "unknown", samples: 23, minSamples: 24, minMoved: 0.02, reason: "too few samples" });
    const flat = Array.from({ length: 30 }, (_, i) => reading(i, 0.0005 * i, 0.1, i * 1000));
    expect(estimateCapacity(flat, "fiveHour", undefined, NOW)).toMatchObject({ status: "unknown", reason: "too little movement", samples: 29 });
    const five = estimateCapacity(rs, "fiveHour", undefined, NOW);
    expect(five.tokensPerPercent).toBeCloseTo(200_000, 0);
    expect(five.errorBand).toBeCloseTo(0.01 / 0.58, 6);
  });

  it("estimates each window on its own: a week that moved 0.058 is unknown while its 5-hour window is known", () => {
    const rs = Array.from({ length: 30 }, (_, i) => reading(i, 0.02 * i, 0.002 * i, i * 400_000));
    expect(estimateCapacity(rs, "fiveHour", undefined, NOW).status).toBe("ok");
    expect(estimateCapacity(rs, "sevenDay", undefined, NOW)).toMatchObject({ status: "unknown", reason: "too little movement" });
    const wide = Array.from({ length: 30 }, (_, i) => reading(i, 0.02 * i, 0.004 * i, i * 400_000));
    expect(estimateCapacity(wide, "sevenDay", undefined, NOW).tokensPerPercent).toBeCloseTo(1_000_000, 0);
  });
});

function bucket(hour: number, input: number): UsageBucket {
  return { hour, provider: "anthropic", model: "m", input, output: 0, cacheRead: 0, cacheCreation: 0, requests: 1 };
}

describe("demand forecast", () => {
  it("averages each hour of day over the recorded history, counting quiet hours as zero", () => {
    const now = T0 + 3 * DAY_MS + 30 * 60_000;
    const bs: UsageBucket[] = [];
    for (let d = 0; d < 3; d++) bs.push(bucket(T0 + d * DAY_MS + 9 * HOUR_MS, 300)); // 09:00 every day
    bs.push(bucket(T0 + 14 * HOUR_MS, 600)); // 14:00 once in three days
    const p = demandProfile(bs, T0, now)!;
    expect(p.hours).toBe(72);
    expect(p.perHour[9]).toBe(300);
    expect(p.perHour[14]).toBe(200);
    expect(p.perHour[3]).toBe(0);
    // The current hour is still filling and is not part of the profile.
    expect(demandProfile([...bs, bucket(Math.floor(now / HOUR_MS) * HOUR_MS, 1e9)], T0, now)!.perHour[0]).toBe(0);
    expect(forecastDemand(p, now, now + DAY_MS)).toBeCloseTo(500, 6);
    // Partial hours count pro rata.
    expect(forecastDemand(p, T0 + 9 * HOUR_MS + 30 * 60_000, T0 + 10 * HOUR_MS)).toBeCloseTo(150, 6);
    expect(forecastDemand(p, now, now)).toBe(0);
  });

  it("uses only the last profileDays and has no forecast before recording began", () => {
    const now = T0 + 30 * DAY_MS;
    const old = bucket(T0 + 9 * HOUR_MS, 1e9);
    const p = demandProfile([old], T0, now)!;
    expect(p.hours).toBe(DEFAULT_SUPPLY_OPTIONS.profileDays * 24);
    expect(p.perHour[9]).toBe(0);
    expect(demandProfile([], null, now)).toBeNull();
    expect(demandProfile([], now, now)).toBeNull();
  });
});

function live(five: number, seven: number, readAt: number, over: Partial<{ fiveReset: number; sevenReset: number; id: string }> = {}): LiveAccount {
  return {
    id: over.id ?? "lyra", readAt,
    fiveHour: { util: five, resetAt: over.fiveReset ?? FIVE_RESET },
    sevenDay: { util: seven, resetAt: over.sevenReset ?? WEEK_RESET },
  };
}

describe("projected exhaustion", () => {
  it("extrapolates the window's recent slope and reports it when it lands before the reset", () => {
    // 5-hour window: 10% at 00:05, 50% at 02:05 → 20%/h → 100% at 04:35, before the 05:00 reset.
    const rs = [reading(0, 0.1, 0.1, 0)];
    const now = T0 + 2 * HOUR_MS + 5 * 60_000;
    const ex = projectExhaustion(rs, live(0.5, 0.2, now), "fiveHour", now);
    expect(ex.beforeReset).toBe(true);
    expect(ex.at).toBe(T0 + 4 * HOUR_MS + 35 * 60_000);
  });

  it("is null when the account lasts to the reset, is not burning, or has no reading", () => {
    const rs = [reading(0, 0.1, 0.1, 0)];
    const now = T0 + 2 * HOUR_MS + 5 * 60_000;
    expect(projectExhaustion(rs, live(0.2, 0.2, now), "fiveHour", now)).toEqual({ at: null, beforeReset: false });
    expect(projectExhaustion(rs, live(0.1, 0.1, now), "fiveHour", now)).toEqual({ at: null, beforeReset: false });
    expect(projectExhaustion(rs, live(0.5, 0.2, 0), "fiveHour", now)).toEqual({ at: null, beforeReset: false });
    // A reading from another window is no starting point.
    expect(projectExhaustion([reading(0, 0.1, 0.1, 0, { fiveReset: FIVE_RESET - 5 * 3600 })], live(0.5, 0.2, now), "fiveHour", now))
      .toEqual({ at: null, beforeReset: false });
  });
});

describe("the pool picture", () => {
  it("adds remaining supply, the budget for today and the forecast, and counts accounts it cannot know", () => {
    const now = T0 + 25 * HOUR_MS;
    const readings = [...steadyWeek(25, 1_000_000, "lyra"), reading(0, 0, 0.5, 0, { id: "vega" })];
    const buckets = Array.from({ length: 25 }, (_, i) => bucket(T0 + i * HOUR_MS, 1000));
    const s = computeSupply({
      now, readings, buckets, since: T0,
      live: [
        live(0.2, 0.4, now - 60_000, { id: "lyra", sevenReset: Math.floor((now + 3 * DAY_MS) / 1000) }),
        live(0.1, 0.5, now - 60_000, { id: "vega" }),
      ],
    });
    const lyra = s.accounts.find(a => a.id === "lyra")!;
    expect(lyra.sevenDay.capacity.status).toBe("ok");
    // 60% left at 1M per percent.
    expect(lyra.sevenDay.remaining).toBeCloseTo(60_000_000, -2);
    expect(lyra.fiveHour.capacity.status).toBe("unknown");
    expect(lyra.fiveHour.remaining).toBeNull();
    // Spread over the three days to its weekly reset.
    expect(s.budget.today).toBeCloseTo(20_000_000, -2);
    expect(s.budget).toMatchObject({ known: 1, unknown: 1 });
    expect(s.demand.next24h).toBeCloseTo(24_000, 6);
    expect(s.demand.profileHours).toBe(25);
    expect(lyra.sevenDay.poolDemandToReset).toBeCloseTo(3 * 24_000, 0);
  });

  it("has no budget and no forecast with nothing recorded", () => {
    const s = computeSupply({ now: T0, readings: [], buckets: [], since: null, live: [live(0, 0, 0)] });
    expect(s.budget).toEqual({ today: null, known: 0, unknown: 1 });
    expect(s.demand).toEqual({ profileHours: 0, next24h: null });
    expect(s.accounts[0].sevenDay.poolDemandToReset).toBeNull();
  });
});

describe("per-account spend in the quota history", () => {
  it("stamps each reading with the account's cumulative spend, and keeps it across a restart", () => {
    let now = T0;
    const q = new QuotaHistory({ now: () => now });
    q.addSpend("lyra", 500);
    q.addSpend("lyra", Number.NaN);
    q.addSpend("lyra", -3);
    q.sample("lyra", { fiveHourUtil: 0.1, fiveHourReset: FIVE_RESET, sevenDayUtil: 0.1, sevenDayReset: WEEK_RESET });
    q.addSpend("lyra", 250);
    now += HOUR_MS;
    q.sample("lyra", { fiveHourUtil: 0.2, fiveHourReset: FIVE_RESET, sevenDayUtil: 0.11, sevenDayReset: WEEK_RESET });
    expect(q.readings().map(r => r.spentAt)).toEqual([500, 750]);
    q.addSpend("lyra", 50);
    expect(q.dirty).toBe(true);
    q.markClean();
    q.touch();
    expect(q.dirty).toBe(true);

    const file = JSON.parse(JSON.stringify(q.toFile()));
    expect(file.rows[0]).toHaveLength(8);
    expect(file.spent).toEqual({ lyra: 800 });
    const after = new QuotaHistory({ now: () => now });
    expect(after.restore(file)).toBe(true);
    expect(after.spentOf("lyra")).toBe(800);
    expect(after.readings().map(r => r.spentAt)).toEqual([500, 750]);
  });

  it("loads seven-field rows from before spend was kept with spentAt null", () => {
    const q = new QuotaHistory({ now: () => T0 });
    expect(q.restore({ version: 1, rows: [[T0 / 1000, "lyra", T0 / 1000, 0.1, 1, 0.2, 2]] })).toBe(true);
    expect(q.readings()[0].spentAt).toBeNull();
    expect(q.restore({ version: 1, rows: [], spent: { lyra: "x", "bad id": 5, vega: -1 } })).toBe(true);
    expect(q.spentOf("lyra")).toBe(0);
    expect(q.spentOf("vega")).toBe(0);
  });
});

describe("the dashboard", () => {
  it("has a Supply card drawn from health and validated first", () => {
    const html = renderDashboardHtml();
    expect(html).toContain('id="supcard"');
    expect(html).toContain("function renderSupply");
    expect(html).toContain("renderSupply(h)");
    expect(html).toContain("validSupply(x)");
    expect(html).toContain("Today's pool budget");
    expect(html).toContain("Runs out");
    for (const src of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])) {
      expect(() => new Function(src)).not.toThrow();
    }
  });
});

// ─── Through a real router, against a fake upstream ─────────────────────────

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

interface Router { base: string; child: ChildProcess; stop: () => Promise<void> }

async function startRouter(dir: string, upstreamPort: number): Promise<Router> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
    ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"),
    SESSIONS_PATH: join(dir, "sessions.json"),
  };
  env["QUOTA_HISTORY_PATH"] = join(dir, "quota-history.json");
  env["ACCOUNT_STATE_PATH"] = join(dir, "account-state.json");
  delete env["USAGE_PATH"];
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${upstreamPort}'});`], {
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

describe("supply in health through a real router", () => {
  it("reports each account's supply, unknown while readings are thin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-supply-http-"));
    const upstream: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "0.2",
          "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3600),
          "anthropic-ratelimit-unified-7d-utilization": "0.4",
          "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 3 * 86400),
        });
        res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 100, output_tokens: 10 } }));
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
      id: "fixture", accessToken: "fixture", refreshToken: "fixture",
      expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
    }]));
    writeFileSync(join(dir, "config.json"), "{}");
    const r = await startRouter(dir, (upstream.address() as { port: number }).port);
    try {
      const sent = await fetch(`${r.base}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(8000),
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(sent.status).toBe(200);
      await sent.text();
      const h = await (await fetch(`${r.base}/cc-router/health`, { signal: AbortSignal.timeout(5000) })).json() as {
        supply: { accounts: Array<{ id: string; sevenDay: { capacity: { status: string; samples: number }; remaining: number | null } }>; budget: { today: number | null; known: number; unknown: number }; demand: { next24h: number | null } };
      };
      expect(h.supply.accounts).toHaveLength(1);
      expect(h.supply.accounts[0].id).toBe("fixture");
      expect(h.supply.accounts[0].sevenDay.capacity).toMatchObject({ status: "unknown", samples: 0 });
      expect(h.supply.accounts[0].sevenDay.remaining).toBeNull();
      expect(h.supply.budget).toEqual({ today: null, known: 0, unknown: 1 });
    } finally {
      await r.stop();
      await new Promise<void>(res => upstream.close(() => res()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("knows a seat's 7-day capacity from four hourly readings, and its remaining supply is the figure the balance block shows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-supply-http-"));
    const nowMs = Date.now();
    const nowS = Math.floor(nowMs / 1000);
    const reset = nowS + 4 * 86_400;
    // Four hourly readings in the current week: utilization 0.40 -> 0.52 (moved 0.12, 3 pairs) on 1.2M cost-weighted tokens per point.
    const hour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    const rows = [3, 2, 1, 0].map((k, i) => {
      const h = hour - k * HOUR_MS;
      return [h / 1000, "fixture", h / 1000 + 300, 0.1, nowS + 3600, 0.4 + 0.04 * i, reset, 1_200_000 * 4 * i];
    });
    writeFileSync(join(dir, "quota-history.json"), JSON.stringify({ version: 1, rows, spent: { fixture: 1_200_000 * 12 } }));
    // The pool's last reading, so health has a live utilization before any request.
    writeFileSync(join(dir, "account-state.json"), JSON.stringify({ version: 1, savedAt: nowMs, accounts: { fixture: {
      rateLimits: { status: "allowed", fiveHourUtil: 0.1, fiveHourReset: nowS + 3600, sevenDayUtil: 0.52, sevenDayReset: reset, claim: "", plan: "", requestsLimit: 0, lastUpdated: nowMs - 60_000 },
      sevenDayWindowSeen: true,
    } } }));
    const upstream: Server = createServer((req: IncomingMessage, res: ServerResponse) => { req.resume(); req.on("end", () => { res.writeHead(500); res.end(); }); });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    writeFileSync(join(dir, "accounts.json"), JSON.stringify([{ id: "fixture", accessToken: "fixture", refreshToken: "fixture", expiresAt: nowMs + 86_400_000, scopes: [], enabled: true }]));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ routing: { softCapUtil: 0.98, weeklyPace: { enabled: true } } }));
    const r = await startRouter(dir, (upstream.address() as { port: number }).port);
    try {
      const h = await (await fetch(`${r.base}/cc-router/health`, { signal: AbortSignal.timeout(5000) })).json() as {
        supply: { accounts: Array<{ id: string; sevenDay: { capacity: { status: string; samples: number; tokensPerPercent: number | null; errorBand: number | null; minSamples: number }; remaining: number | null } }>; budget: { today: number | null; known: number; unknown: number } };
        balance: { seats: Array<{ id: string; remainingTokens: number | null; size: { source: string; tokensPerWeek: number | null; errorBand: number | null; samples: number } }> };
      };
      const sup = h.supply.accounts.find(a => a.id === "fixture")!.sevenDay;
      const bal = h.balance.seats.find(s => s.id === "fixture")!;
      expect(sup.capacity).toMatchObject({ status: "ok", samples: 3, minSamples: 3 });
      // 1.2M per point: 120M a week, within 0.01 / 0.12.
      expect(sup.capacity.tokensPerPercent).toBeCloseTo(1_200_000, -3);
      expect(sup.capacity.errorBand).toBeCloseTo(0.01 / 0.12, 4);
      expect(bal.size).toMatchObject({ source: "measured", samples: 3 });
      expect(bal.size.tokensPerWeek).toBe(Math.round(sup.capacity.tokensPerPercent! * 100));
      expect(bal.size.errorBand).toBeCloseTo(sup.capacity.errorBand!, 3);
      // The two views agree: 48% of 120M left.
      expect(sup.remaining).toBe(bal.remainingTokens);
      expect(sup.remaining).toBeCloseTo(0.48 * 120_000_000, -4);
      expect(h.supply.budget.known).toBe(1);
      expect(h.supply.budget.today).toBeCloseTo(sup.remaining! / 4, -4);
    } finally {
      await r.stop();
      await new Promise<void>(res => upstream.close(() => res()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
