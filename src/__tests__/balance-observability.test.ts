import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { SessionRouter, type SessionTarget, type TargetMetrics } from "../proxy/session-router.js";
import { balanceView } from "../proxy/balance-view.js";
import { paceRatio, WEEK_SEC, FIVE_HOUR_SEC } from "../proxy/weekly-pace.js";
import { emptyPlacementCounts } from "../proxy/seat-metrics.js";
import type { SeatSize } from "../proxy/seat-size.js";
import type { Account } from "../proxy/types.js";
import { accountLine } from "../ui/status-frame.js";
import { computeSeverity, windowReading } from "../proxy/severity.js";
import { extractRateLimits } from "../proxy/rate-limit-headers.js";
import { waitForListening } from "./helpers/router-process.js";

// The balance block of health, and the two dashboards that read it. Its
// figures must be the ones placement ranks by: the explanation comes from the
// router itself, the pace ratio from the function the router uses.

const NOW = Date.UTC(2026, 10, 19, 4, 29);
const nowSec = NOW / 1000;
const H = 3600;
const T = (accountId: string): SessionTarget => ({ provider: "anthropic", accountId });

interface Win { util: number; hoursLeft: number }
function seat(week: Win, five: Win = { util: 0, hoursLeft: 0 }, size = 1): TargetMetrics {
  const w = { util: week.util, resetAtSec: nowSec + week.hoursLeft * H };
  const f = five.hoursLeft > 0 ? { util: five.util, resetAtSec: nowSec + five.hoursLeft * H } : { util: 0, resetAtSec: 0 };
  const bind = w.util > f.util ? w : f;
  return { util: bind.util, resetAtSec: bind.resetAtSec, pace: f, weekly: w, fiveHour: f, size };
}
const PACE = { slack: 0.1, migrateAhead: 0.15, fiveHour: true, fiveHourSlack: 0.2 };
const LIVE = { softCapUtil: 0.98, weeklyPace: PACE };

/** The live pool on 2026-11-19, kyte measured at 2.03x. */
const POOL: Record<string, TargetMetrics> = {
  rigel: seat({ util: 0.98, hoursLeft: 17.5 }, { util: 0.01, hoursLeft: 3.6 }),
  lyra: seat({ util: 0.95, hoursLeft: 27.5 }, { util: 0.13, hoursLeft: 3.6 }),
  heewon: seat({ util: 0.65, hoursLeft: 86.5 }, { util: 0.03, hoursLeft: 4.1 }),
  vega: seat({ util: 0.53, hoursLeft: 99.5 }, { util: 0.16, hoursLeft: 3.6 }),
  kyte: seat({ util: 0.19, hoursLeft: 147.5 }, undefined, 2.03),
};
const IDS = Object.keys(POOL);
const metrics = (t: SessionTarget) => POOL[t.accountId]!;

function acct(id: string): Account {
  const m = POOL[id]!;
  return {
    id, enabled: true, healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0, consecutiveErrors: 0,
    tokens: { accessToken: "x", refreshToken: "x", expiresAt: NOW + 3_600_000, scopes: [] },
    sessionLimitPercent: 100, weeklyLimitPercent: 100,
    rateLimits: {
      status: "allowed", claim: "", plan: "", requestsLimit: 0, lastUpdated: NOW,
      fiveHourUtil: m.fiveHour!.util, fiveHourReset: m.fiveHour!.resetAtSec ?? 0,
      sevenDayUtil: m.weekly!.util, sevenDayReset: m.weekly!.resetAtSec ?? 0,
    },
  };
}

describe("SessionRouter.explain", () => {
  it("reports the rank a new session is placed by, without placing anything", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const x = r.explain(IDS.map(T), () => true, metrics)!;
    expect(r.size()).toBe(0);
    const byRank = [...x.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([k]) => k.replace("anthropic:", ""));
    // The first-ranked seat is where resolve puts the next session.
    expect(r.resolve("s", IDS.map(T), () => true, metrics)!.accountId).toBe(byRank[0]);
    expect(byRank[0]).toBe("kyte");
    // rigel is over the cap; lyra, heewon and vega are ahead of weekly pace: only kyte is placeable.
    expect(x.get("anthropic:rigel")!.overCap).toBe(true);
    expect(x.get("anthropic:rigel")!.placeable).toBe(false);
    expect(IDS.filter(id => x.get(`anthropic:${id}`)!.placeable)).toEqual(["kyte"]);
    expect(byRank.indexOf("rigel")).toBe(4);
  });

  it("uses the pace ratio the balance rules place by", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const x = r.explain(IDS.map(T), () => true, metrics)!;
    for (const id of IDS) {
      const m = POOL[id]!;
      expect(x.get(`anthropic:${id}`)!.weekRatio).toBeCloseTo(paceRatio(m.weekly!.util, m.weekly!.resetAtSec, NOW, WEEK_SEC)!, 9);
      const five = m.fiveHour!.resetAtSec ? paceRatio(m.fiveHour!.util, m.fiveHour!.resetAtSec, NOW, FIVE_HOUR_SEC) : null;
      if (five === null) expect(x.get(`anthropic:${id}`)!.fiveHourRatio).toBeNull();
      else expect(x.get(`anthropic:${id}`)!.fiveHourRatio).toBeCloseTo(five, 9);
    }
    // 98% used with a tenth of the week left reads 0.19: ahead, where the old line said on pace.
    expect(x.get("anthropic:rigel")!.weekRatio).toBeCloseTo(0.02 / (17.5 / 168), 2);
  });

  it("is null under the legacy rules and with neither key set", () => {
    expect(new SessionRouter({ now: () => NOW, ...LIVE, balance: false }).explain(IDS.map(T), () => true, metrics)).toBeNull();
    expect(new SessionRouter({ now: () => NOW }).explain(IDS.map(T), () => true, metrics)).toBeNull();
  });
});

const NO_OUTCOMES = () => ({ resets: 0, unusedAtReset: null, strandedMinutes: 0 });

describe("balanceView", () => {
  const sizes = new Map<string, SeatSize>(IDS.map(id => [id, id === "kyte"
    ? { relative: 2.03, source: "measured", tokensPerWeek: 920e6, samples: 8, spanHours: 52.25, errorBand: 0.0417, moved: 0.24 }
    : id === "vega" ? { relative: 1, source: "measured", tokensPerWeek: 450e6, samples: 12, spanHours: 100, errorBand: 0.02, moved: 0.5 }
      : { relative: 1, source: "equal", tokensPerWeek: null, samples: 1, spanHours: 3, errorBand: null, moved: 0.01 }]));
  const placements = { lastHour: emptyPlacementCounts(), lastDay: { ...emptyPlacementCounts(), placed: 40, "soft-cap": 3 } };

  it("joins the router's explanation, the seat sizes and the placement counts", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const v = balanceView(IDS.map(acct), r.explain(IDS.map(T), () => true, metrics), sizes, placements, NOW, NO_OUTCOMES);
    expect(v.rules).toBe("balance");
    expect(v.placements.lastDay.placed).toBe(40);
    const kyte = v.seats.find(s => s.id === "kyte")!;
    expect(kyte).toMatchObject({ rank: 1, placeable: true, size: { relative: 2.03, source: "measured", samples: 8, spanHours: 52.3, errorBand: 0.042 } });
    expect(kyte.remainingTokens).toBe(Math.round(0.81 * 920e6));
    // Pace deficit: a week's worth per hour, less remaining over hours left.
    // kyte has 81% left with 88% of the week left: a little behind an even spend, so a small deficit.
    expect(kyte.paceDeficitPerHour).toBe(Math.round(920e6 / 168 - 0.81 * 920e6 / 147.5));
    expect(kyte.paceDeficitPerHour).toBeGreaterThan(0);
    expect(kyte.paceDeficitPerHour).toBeLessThan(0.1 * 920e6 / 168);
    // vega has 47% left with 59% of the week left: further behind, a larger deficit.
    const vega = v.seats.find(s => s.id === "vega")!;
    expect(vega.paceDeficitPerHour).toBeGreaterThan(kyte.paceDeficitPerHour!);
    const heewon = v.seats.find(s => s.id === "heewon")!;
    expect(heewon.remainingTokens).toBeNull();
    expect(heewon.paceDeficitPerHour).toBeNull();
    expect(heewon.size.source).toBe("equal");
  });

  it("carries the score the rank orders by, the tier, and whether the seat reports a 5-hour window", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const x = r.explain(IDS.map(T), () => true, metrics)!;
    const v = balanceView(IDS.map(acct), x, sizes, placements, NOW, NO_OUTCOMES);
    const seat = (id: string) => v.seats.find(s => s.id === id)!;
    // rigel is over the cap; kyte is on pace; the rest are ahead on the week.
    expect(seat("rigel").tier).toBe("over-cap");
    expect(seat("kyte").tier).toBe("on-pace");
    expect(["lyra", "heewon", "vega"].map(id => seat(id).tier)).toEqual(["behind", "behind", "behind"]);
    expect(x.get("anthropic:kyte")!.tier).toBe("on-pace");
    // The score is the router's to four significant digits (scores run from 1e-4 down to 1e-7, so
    // decimal places would zero them), and ranks agree with it within a set.
    const raw = (id: string) => x.get(`anthropic:${id}`)!.score;
    expect(seat("kyte").score).toBeCloseTo(raw("kyte"), 7);
    expect(seat("kyte").score).toBe(Number(raw("kyte").toPrecision(4)));
    // Over the cap the score is 0 by construction (cap - util); every other seat keeps a distinct, non-zero one.
    expect(seat("rigel").score).toBe(0);
    const under = IDS.filter(id => id !== "rigel");
    for (const id of under) expect(seat(id).score).toBeGreaterThan(0);
    expect(new Set(under.map(id => seat(id).score)).size).toBe(under.length);
    expect(raw("heewon")).not.toBe(raw("vega"));
    const ranked = [...v.seats].sort((a, b) => a.rank - b.rank);
    expect(ranked[0]!.id).toBe("kyte");
    for (let i = 1; i < ranked.length; i++) {
      if (ranked[i]!.placeable === ranked[i - 1]!.placeable && ranked[i]!.usable === ranked[i - 1]!.usable) expect(ranked[i]!.score).toBeLessThanOrEqual(ranked[i - 1]!.score);
    }
    // kyte reports no 5-hour window (its reading has none): false, and the ratio is null, not 0.
    expect(seat("kyte").fiveHourReported).toBe(false);
    expect(seat("kyte").fiveHourRatio).toBeNull();
    expect(seat("vega").fiveHourReported).toBe(true);
    // The explicit flag from extractRateLimits wins over the inference from the numbers.
    const flagged = IDS.map(id => ({ ...acct(id), rateLimits: { ...acct(id).rateLimits, fiveHourReported: id === "kyte" } }));
    const v2 = balanceView(flagged, x, sizes, placements, NOW, NO_OUTCOMES);
    expect(v2.seats.find(s => s.id === "kyte")!.fiveHourReported).toBe(true);
    expect(v2.seats.find(s => s.id === "vega")!.fiveHourReported).toBe(false);
    // A seat never read has no opinion.
    const unread = IDS.map(id => ({ ...acct(id), rateLimits: { ...acct(id).rateLimits, lastUpdated: 0 } }));
    expect(balanceView(unread, x, sizes, placements, NOW, NO_OUTCOMES).seats.every(s => s.fiveHourReported === null)).toBe(true);
  });

  it("week-ok is a seat ahead on the 5-hour window only, and a seat with no weekly reading is on pace", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const pool: Record<string, TargetMetrics> = {
      burst: seat({ util: 0.3, hoursLeft: 120 }, { util: 0.9, hoursLeft: 4.5 }),
      fresh: { util: 0, resetAtSec: 0, weekly: null, fiveHour: null } as unknown as TargetMetrics,
      even: seat({ util: 0.3, hoursLeft: 120 }, { util: 0.1, hoursLeft: 4 }),
    };
    const x = r.explain(Object.keys(pool).map(T), () => true, t => pool[t.accountId]!)!;
    expect(x.get("anthropic:burst")!.tier).toBe("week-ok");
    expect(x.get("anthropic:fresh")!.tier).toBe("on-pace");
    expect(x.get("anthropic:even")!.tier).toBe("on-pace");
  });

  it("says legacy, with no ranks, when the router has no explanation", () => {
    const v = balanceView(IDS.map(acct), null, sizes, placements, NOW, NO_OUTCOMES);
    expect(v.rules).toBe("legacy");
    expect(v.seats.every(s => s.rank === 0 && !s.placeable)).toBe(true);
    // Sizes are still reported: they do not depend on the rules.
    expect(v.seats.find(s => s.id === "kyte")!.size.relative).toBe(2.03);
  });
});

describe("the terminal dashboard", () => {
  it("shows where a new session goes and the weekly pace ratio on each account row", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const v = balanceView(IDS.map(acct), r.explain(IDS.map(T), () => true, metrics), new Map(), { lastHour: emptyPlacementCounts(), lastDay: emptyPlacementCounts() }, NOW, NO_OUTCOMES);
    const accounts = IDS.map(id => ({ ...acct(id), provider: "anthropic_subscription" as const, expiresInMs: 3_600_000, lastUsedMs: NOW - 60_000, lastRefreshMs: 0 }));
    const sev = computeSeverity(accounts as never, [], NOW);
    const text = (segs: Array<{ text: string }>) => segs.map(s => s.text).join("");
    const line = (id: string, width: number) => text(accountLine(accounts.find(a => a.id === id) as never, sev.accounts.find(s => s.id === id)!, { width: "wide", fit: width }, false, NOW, sev.thresholds, v));
    expect(line("kyte", 200)).toMatch(/place #1\s+pace\s+0\.92/);
    expect(line("rigel", 200)).toMatch(/place cap\s+pace\s+0\.19/);
    expect(line("vega", 200)).toMatch(/place wait\s+pace\s+0\.79/);
    // Without a balance block (an older router), the row is as before.
    const bare = text(accountLine(accounts.find(a => a.id === "vega") as never, sev.accounts.find(s => s.id === "vega")!, { width: "wide", fit: 200 }, false, NOW, sev.thresholds, undefined));
    expect(bare).not.toContain("place");
  });
});

describe("the smoke check", () => {
  it("fails when live health has no balance block, and prints the placement summary", () => {
    const src = readFileSync(fileURLToPath(new URL("../../scripts/smoke-remote.sh", import.meta.url)), "utf8");
    expect(src).toMatch(/health has no balance block/);
    expect(src).toMatch(/\[smoke\] balance:/);
  });
});

// ─── Through a real router ──────────────────────────────────────────────────

const SECRET = "s3cret-for-the-balance-observability-test";

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

function reply(res: ServerResponse, seat: string): void {
  // Two seats: "full" at 97% of its week, "fresh" at 20%. "full" reports no
  // 5-hour window at all (as a plan without one does).
  const util = seat === "full" ? "0.97" : "0.20";
  res.writeHead(200, {
    "content-type": "application/json",
    "anthropic-ratelimit-unified-status": "allowed",
    ...(seat === "full" ? {} : {
      "anthropic-ratelimit-unified-5h-utilization": "0.10",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3 * 3600),
    }),
    "anthropic-ratelimit-unified-7d-utilization": util,
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 4 * 86_400),
  });
  res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 1, output_tokens: 1 } }));
}

interface Fixture { dir: string; upstream: Server; upstreamPort: number }

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-balance-obs-"));
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => reply(res, String(req.headers["authorization"] ?? "").replace(/^Bearer fixture-/, "")));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  writeFileSync(join(dir, "accounts.json"), JSON.stringify(["full", "fresh"].map(id => ({
    id, accessToken: `fixture-${id}`, refreshToken: "fixture",
    expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }))));
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    proxySecret: SECRET,
    routing: { softCapUtil: 0.98, weeklyPace: { enabled: true, fiveHour: true }, balance: { capacityWeight: { fresh: 3 } } },
  }));
  return { dir, upstream, upstreamPort: (upstream.address() as { port: number }).port };
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

const send = (base: string, session: string) => fetch(`${base}/v1/messages`, {
  method: "POST", signal: AbortSignal.timeout(8000),
  headers: {
    "content-type": "application/json", "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/2.1.327 (external, cli)",
    ...(session ? { "x-claude-code-session-id": session } : {}), authorization: `Bearer ${SECRET}`,
  },
  body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
});

interface HealthBalance {
  balance: {
    rules: string;
    seats: Array<{
      id: string; rank: number; placeable: boolean; weekRatio: number | null; fiveHourRatio: number | null;
      size: { source: string; relative: number; spanHours: number; errorBand: number | null }; load: number;
      tier: string; score: number; fiveHourReported: boolean | null; paceDeficitPerHour: number | null;
    }>;
    placements: { lastDay: Record<string, number> };
  };
}

describe("health through a real router", () => {
  it("carries the balance block, with the configured weight, the pace ratio and the rank placement uses", async () => {
    const f = await fixture();
    const r = await startRouter(f);
    try {
      // A seat the router has never read from looks like a fresh week, and is
      // meant to take work so that it produces a reading. Two requests without
      // a session id go round-robin and give both seats one; then sessions.
      for (let i = 0; i < 2; i++) expect((await send(r.base, "")).status).toBe(200);
      for (const s of ["sess-a", "sess-b", "sess-c"]) expect((await send(r.base, s)).status).toBe(200);
      const h = await (await fetch(`${r.base}/cc-router/health`)).json() as HealthBalance;
      expect(h.balance.rules).toBe("balance");
      const full = h.balance.seats.find(s => s.id === "full")!;
      const fresh = h.balance.seats.find(s => s.id === "fresh")!;
      expect(fresh.size).toMatchObject({ source: "weight", relative: 3, spanHours: 0, errorBand: null });
      expect(full.size.source).toBe("equal");
      // full: 97% used with 4/7 of the week left is ahead of pace; fresh is on pace.
      expect(full.tier).toBe("behind");
      expect(fresh.tier).toBe("on-pace");
      expect(fresh.score).toBeGreaterThan(0);
      expect(full.score).toBeGreaterThan(0);
      expect(fresh.score).toBeGreaterThan(full.score);
      // full never named a 5-hour window: not reported, and its ratio is null rather than 0.
      expect(full.fiveHourReported).toBe(false);
      expect(full.fiveHourRatio).toBeNull();
      expect(fresh.fiveHourReported).toBe(true);
      expect(fresh.fiveHourRatio).not.toBeNull();
      // Neither seat is measured, so the deficit (which needs a size in tokens) is null.
      expect(full.paceDeficitPerHour).toBeNull();
      expect(fresh.paceDeficitPerHour).toBeNull();
      expect(fresh.rank).toBe(1);
      expect(fresh.placeable).toBe(true);
      // full: 3% left with 4/7 of the week left: ratio 0.05, ahead.
      expect(full.weekRatio).toBeCloseTo(0.03 / (4 / 7), 1);
      expect(full.placeable).toBe(false);
      expect(fresh.load).toBeGreaterThan(0);
      expect(h.balance.placements.lastDay["placed"]).toBe(3);
    } finally {
      await r.stop();
      await new Promise<void>(res => f.upstream.close(() => res()));
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 45_000);
});

describe("extractRateLimits", () => {
  const base = { "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-7d-utilization": "0.42", "anthropic-ratelimit-unified-7d-reset": "1800000000" };

  it("keeps an absent 5-hour header apart from a reported zero", () => {
    const none = extractRateLimits(base)!;
    expect(none.fiveHourReported).toBe(false);
    expect(none.fiveHourUtil).toBe(0);
    expect(none.sevenDayUtil).toBe(0.42);
    const zero = extractRateLimits({ ...base, "anthropic-ratelimit-unified-5h-utilization": "0", "anthropic-ratelimit-unified-5h-reset": "1700000000" })!;
    expect(zero.fiveHourReported).toBe(true);
    expect(zero.fiveHourUtil).toBe(0);
    const some = extractRateLimits({ ...base, "anthropic-ratelimit-unified-5h-utilization": "0.37" })!;
    expect(some).toMatchObject({ fiveHourReported: true, fiveHourUtil: 0.37 });
    // A 429 blaming the 5-hour window carries its reset and claim but no utilization: reported all the same.
    const refused = extractRateLimits({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "five_hour", "anthropic-ratelimit-unified-5h-reset": "1700000000" })!;
    expect(refused.fiveHourReported).toBe(true);
    expect(extractRateLimits({ ...base, "anthropic-ratelimit-unified-representative-claim": "five_hour" })!.fiveHourReported).toBe(true);
    // Garbage in the header is not a reading either.
    expect(extractRateLimits({ ...base, "anthropic-ratelimit-unified-5h-utilization": "n/a" })!.fiveHourReported).toBe(false);
    // No unified headers at all: no reading.
    expect(extractRateLimits({})).toBeNull();
  });

  it("reaches the window reading the dashboards draw: 'not reported', never 0%", () => {
    const rl = { ...extractRateLimits(base)!, lastUpdated: NOW };
    expect(windowReading(rl, "fiveHour", NOW)).toEqual({ ok: false, note: "not reported" });
    expect(windowReading(rl, "sevenDay", NOW)).toMatchObject({ ok: true, util: 0.42 });
    // A reading from before the flag was kept still reads as before.
    const { fiveHourReported: _f, ...old } = rl;
    void _f;
    expect(windowReading(old, "fiveHour", NOW)).toEqual({ ok: false, note: "no reading" });
  });
});

describe("the documentation", () => {
  const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
  const trouble = readFileSync(fileURLToPath(new URL("../../docs/troubleshooting.md", import.meta.url)), "utf8");

  it("states what slack means under the balance rules, that migrateAhead is legacy-only, and the measured seat size with its error band", () => {
    expect(readme).toMatch(/under the balance rules `slack` is the tolerance on the \*\*ratio\*\*/);
    expect(readme).toMatch(/`migrateAhead` is legacy-only/);
    expect(readme).toMatch(/\*\*Legacy-only\.\*\* Under the legacy rules a pinned session moves/);
    expect(readme).toMatch(/measured 2\.03× a Team seat, not the 4×/);
    expect(readme).toMatch(/within ±12\.5% at worst/);
    expect(readme).toMatch(/`size\.errorBand`/);
    expect(readme).toMatch(/`paceDeficitPerHour` \(cost-weighted tokens per hour by which an even spend/);
    expect(readme).toMatch(/replaces `surplusPerHour`/);
    expect(readme).toMatch(/`tier` \(`on-pace`, `week-ok`, `behind` or `over-cap`/);
    expect(readme).toMatch(/`fiveHourReported` \(false for a seat whose plan reports no 5-hour window/);
  });

  it("explains the every-seat-behind-pace state in troubleshooting", () => {
    expect(trouble).toMatch(/### Every seat is behind pace/);
    expect(trouble).toMatch(/all of them compete on the balance `score` with\nthe weekly pace ratio as a factor \(the score is multiplied by `weekRatio`\)/);
    expect(trouble).toMatch(/`paceDeficitPerHour` is how far behind/);
    expect(trouble).toMatch(/`unusedAtReset`/);
    expect(trouble).toMatch(/`strandedMinutes`/);
  });
});
