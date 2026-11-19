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
import { computeSeverity } from "../proxy/severity.js";
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

describe("balanceView", () => {
  const sizes = new Map<string, SeatSize>(IDS.map(id => [id, id === "kyte"
    ? { relative: 2.03, source: "measured", tokensPerWeek: 920e6, samples: 8 }
    : id === "vega" ? { relative: 1, source: "measured", tokensPerWeek: 450e6, samples: 12 }
      : { relative: 1, source: "equal", tokensPerWeek: null, samples: 1 }]));
  const placements = { lastHour: emptyPlacementCounts(), lastDay: { ...emptyPlacementCounts(), placed: 40, "soft-cap": 3 } };

  it("joins the router's explanation, the seat sizes and the placement counts", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const v = balanceView(IDS.map(acct), r.explain(IDS.map(T), () => true, metrics), sizes, placements, NOW);
    expect(v.rules).toBe("balance");
    expect(v.placements.lastDay.placed).toBe(40);
    const kyte = v.seats.find(s => s.id === "kyte")!;
    expect(kyte).toMatchObject({ rank: 1, placeable: true, size: { relative: 2.03, source: "measured", samples: 8 } });
    expect(kyte.remainingTokens).toBe(Math.round(0.81 * 920e6));
    // Surplus: remaining over hours left, against a week's worth per hour.
    // kyte has 81% left with 88% of the week left: a little under an even spend.
    expect(kyte.surplusPerHour).toBe(Math.round(0.81 * 920e6 / 147.5 - 920e6 / 168));
    expect(kyte.surplusPerHour).toBeLessThan(0);
    expect(kyte.surplusPerHour).toBeGreaterThan(-0.1 * 920e6 / 168);
    // vega has 47% left with 59% of the week left: further behind.
    const vega = v.seats.find(s => s.id === "vega")!;
    expect(vega.surplusPerHour).toBeLessThan(kyte.surplusPerHour!);
    const heewon = v.seats.find(s => s.id === "heewon")!;
    expect(heewon.remainingTokens).toBeNull();
    expect(heewon.surplusPerHour).toBeNull();
    expect(heewon.size.source).toBe("equal");
  });

  it("says legacy, with no ranks, when the router has no explanation", () => {
    const v = balanceView(IDS.map(acct), null, sizes, placements, NOW);
    expect(v.rules).toBe("legacy");
    expect(v.seats.every(s => s.rank === 0 && !s.placeable)).toBe(true);
    // Sizes are still reported: they do not depend on the rules.
    expect(v.seats.find(s => s.id === "kyte")!.size.relative).toBe(2.03);
  });
});

describe("the terminal dashboard", () => {
  it("shows where a new session goes and the weekly pace ratio on each account row", () => {
    const r = new SessionRouter({ now: () => NOW, ...LIVE });
    const v = balanceView(IDS.map(acct), r.explain(IDS.map(T), () => true, metrics), new Map(), { lastHour: emptyPlacementCounts(), lastDay: emptyPlacementCounts() }, NOW);
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
  // Two seats: "full" at 97% of its week, "fresh" at 20%.
  const util = seat === "full" ? "0.97" : "0.20";
  res.writeHead(200, {
    "content-type": "application/json",
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.10",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3 * 3600),
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
    seats: Array<{ id: string; rank: number; placeable: boolean; weekRatio: number | null; size: { source: string; relative: number }; load: number }>;
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
      expect(fresh.size).toMatchObject({ source: "weight", relative: 3 });
      expect(full.size.source).toBe("equal");
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
