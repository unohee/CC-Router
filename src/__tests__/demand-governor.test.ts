import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  DEFAULT_GOVERNOR, DemandGovernor, governedSpill, governedThrottleUtil, governedWeeklyPace, isLowPriority,
  pickStage, pressureOf, resolveGovernorConfig, type GovernorChange, type GovernorConfig,
} from "../proxy/demand-governor.js";
import { decideOllamaFallback, resolveOllamaFallbackConfig } from "../providers/ollama/fallback-policy.js";
import { SessionRouter, type SessionTarget, type TargetMetrics } from "../proxy/session-router.js";
import { DEFAULT_WEEKLY_PACE, type WeeklyPaceConfig } from "../proxy/weekly-pace.js";
import { waitForListening } from "./helpers/router-process.js";

// The demand governor compares spend with the supply model's budget and
// tightens in stages. Off by default, observe-only without enforce, and under
// enforce it never refuses a request and never delays anything opus-tier.

const cfg = (over: Partial<GovernorConfig> = {}): GovernorConfig => ({ ...DEFAULT_GOVERNOR, enabled: true, ...over });

describe("pressure and stages", () => {
  it("is demand over budget, the larger of the last and the next 24 hours", () => {
    expect(pressureOf(900, 1200, 1000)).toBeCloseTo(1.2);
    expect(pressureOf(1500, null, 1000)).toBeCloseTo(1.5);
    expect(pressureOf(-5, null, 1000)).toBe(0);
    expect(pressureOf(900, 900, null)).toBeNull();
    expect(pressureOf(900, 900, 0)).toBeNull();
  });

  it("climbs at once, through every threshold", () => {
    const c = cfg();
    expect(pickStage(null, 3, c)).toBe(0);
    expect(pickStage(0.5, 0, c)).toBe(0);
    expect(pickStage(0.9, 0, c)).toBe(1);
    expect(pickStage(1.0, 0, c)).toBe(2);
    expect(pickStage(1.2, 0, c)).toBe(3);
    expect(pickStage(1.31, 0, c)).toBe(4);
  });

  it("comes down only past the hysteresis, so a wobble does not flap the stage", () => {
    const c = cfg();
    expect(pickStage(1.27, 4, c)).toBe(4); // under 1.3, not under 1.25
    expect(pickStage(1.2, 4, c)).toBe(3); // under 1.25, not under 1.10
    expect(pickStage(0.5, 4, c)).toBe(0);
    expect(pickStage(0.87, 1, c)).toBe(1);
    expect(pickStage(0.84, 1, c)).toBe(0);
  });
});

describe("what each stage changes", () => {
  it("stage 1 turns pace placement on, with the 5-hour window, even when not configured", () => {
    expect(governedWeeklyPace(null, 0)).toBeNull();
    expect(governedWeeklyPace(null, 1)).toEqual({ ...DEFAULT_WEEKLY_PACE, fiveHour: true });
    const mine: WeeklyPaceConfig = { slack: 0.05, migrateAhead: 0.2, fiveHour: false, fiveHourSlack: 0.3 };
    expect(governedWeeklyPace(mine, 0)).toBe(mine);
    expect(governedWeeklyPace(mine, 2)).toEqual({ ...mine, fiveHour: true });
  });

  it("stage 1 reaches placement while the router runs, without a restart", () => {
    let stage: 0 | 1 = 0;
    const now = Date.UTC(2026, 10, 4);
    const r = new SessionRouter({ now: () => now, weeklyPace: () => governedWeeklyPace(null, stage) });
    // a: lower 5-hour utilization but far ahead on its week; b: on pace.
    const metrics = (t: SessionTarget): TargetMetrics => t.accountId === "a"
      ? { util: 0.05, resetAtSec: now / 1000 + 3600, weekly: { util: 0.9, resetAtSec: now / 1000 + 6 * 86400 } }
      : { util: 0.3, resetAtSec: now / 1000 + 3600, weekly: { util: 0.1, resetAtSec: now / 1000 + 6 * 86400 } };
    const all: SessionTarget[] = [{ provider: "anthropic", accountId: "a" }, { provider: "anthropic", accountId: "b" }];
    stage = 1;
    const picked = new Set<string>();
    for (let i = 0; i < 10; i++) picked.add(r.resolve(`s${i}`, all, () => true, metrics)!.accountId);
    expect([...picked]).toEqual(["b"]);
  });

  it("stage 2 makes an ahead-of-pace account look hotter to the throttle, and only that one", () => {
    const c = cfg();
    expect(governedThrottleUtil(0.5, 0.1, 1, c)).toBe(0.5);
    expect(governedThrottleUtil(0.5, 0.1, 2, c)).toBeCloseTo(0.65);
    expect(governedThrottleUtil(0.5, -0.2, 4, c)).toBe(0.5);
    expect(governedThrottleUtil(0.95, 0.3, 2, c)).toBe(1);
  });

  it("stage 3 widens spill for the listed tiers, never adding opus by itself", () => {
    const c = cfg();
    expect(governedSpill(null, 2, c)).toBeNull();
    expect(governedSpill(null, 3, c)).toEqual({ tiers: ["haiku", "sonnet"], poolUtil: 0.75 });
    expect(governedSpill({ tiers: ["haiku"], poolUtil: 0.9 }, 3, c)).toEqual({ tiers: ["haiku"], poolUtil: 0.75 });
    expect(governedSpill({ tiers: ["sonnet"], poolUtil: 0.6 }, 4, c)).toEqual({ tiers: ["sonnet"], poolUtil: 0.6 });
  });

  it("stage 3's spill is honoured by the Ollama decision, still not for opus", () => {
    const base = resolveOllamaFallbackConfig({ enabled: true, model: "deepseek-v4.1-flash" })!;
    expect(base.spill).toBeNull();
    const at = (stage: 0 | 3, model: string, poolUtil: number) => decideOllamaFallback({
      config: { ...base, spill: governedSpill(base.spill, stage, cfg()) },
      claudeModel: model,
      anthropicAvailable: () => true,
      poolWaitSeconds: () => 0,
      estimatedPromptTokens: 1000,
      apiKey: () => "fixture-key",
      poolTight: () => { const s = governedSpill(base.spill, stage, cfg()); return s !== null && poolUtil >= s.poolUtil; },
    });
    expect(at(0, "claude-sonnet-4-6", 0.8).use).toBe(false);
    const spilled = at(3, "claude-sonnet-4-6", 0.8);
    expect(spilled).toMatchObject({ use: true, spill: true });
    expect(at(3, "claude-opus-4-7", 0.8).use).toBe(false);
    expect(at(3, "claude-sonnet-4-6", 0.7).use).toBe(false);
  });

  it("stage 4's low priority never includes anything opus-tier", () => {
    const shortBody = { max_tokens: 2068, messages: [{ role: "user", content: "x" }] };
    const turn = { stream: true, max_tokens: 32000, tools: [{ name: "Bash" }], messages: [{ role: "user", content: "x" }] };
    expect(isLowPriority(shortBody, "claude-sonnet-4-6", undefined)).toBe(true);
    expect(isLowPriority(turn, "claude-haiku-4-5", undefined)).toBe(true);
    expect(isLowPriority(turn, "claude-sonnet-4-6", "low")).toBe(true);
    expect(isLowPriority(turn, "claude-sonnet-4-6", undefined)).toBe(false);
    expect(isLowPriority(shortBody, "claude-opus-4-7", undefined)).toBe(false);
    expect(isLowPriority(turn, "claude-opus-4-7", "low")).toBe(false);
    expect(isLowPriority(turn, "claude-fable-5-1", "low")).toBe(false);
  });
});

describe("the governor", () => {
  const input = (pressure: number) => ({ spentLast24h: pressure * 1000, forecastNext24h: null, budget: 1000 });

  it("is off by default: stage 0 whatever the pressure", () => {
    const g = new DemandGovernor(resolveGovernorConfig(undefined));
    expect(g.update(input(5))).toBe(0);
    expect(g.snapshot()).toMatchObject({ enabled: false, enforce: false, stage: 0, applied: 0, hours: [] });
    expect(g.delayFor({}, "claude-haiku-4-5", "low")).toBe(0);
  });

  it("observes without enforce: judges and logs the stage, applies nothing", () => {
    const changes: GovernorChange[] = [];
    const g = new DemandGovernor(cfg(), { now: () => Date.UTC(2026, 10, 4, 10), onChange: c => changes.push(c) });
    g.update(input(1.4));
    expect(g.stage).toBe(4);
    expect(g.applied).toBe(0);
    expect(g.delayFor({}, "claude-haiku-4-5", undefined)).toBe(0);
    expect(changes).toEqual([{ from: 0, to: 4, pressure: 1.4, reason: "demand at 140% of today's budget", enforce: false }]);
  });

  it("counts every change per hour and keeps the highest stage of the hour", () => {
    let now = Date.UTC(2026, 10, 4, 10, 5);
    const g = new DemandGovernor(cfg({ enforce: true }), { now: () => now });
    g.update(input(1.0)); // 0 → 2
    g.update(input(1.0)); // no change
    g.update(input(0.5)); // 2 → 0
    now += 60 * 60_000;
    g.update(input(1.2)); // 0 → 3
    g.noteDelayed();
    const s = g.snapshot();
    expect(s.hours.map(h => [h.changes, h.maxStage, h.delayed])).toEqual([[2, 2, 0], [1, 3, 1]]);
    expect(s.applied).toBe(3);
    expect(s.changedAt).toBe(now);
  });

  it("holds stage 0 with no budget yet, and says why", () => {
    const g = new DemandGovernor(cfg({ enforce: true }));
    g.update({ spentLast24h: 1e9, forecastNext24h: 1e9, budget: null });
    expect(g.stage).toBe(0);
    expect(g.snapshot().reason).toMatch(/no budget yet/);
  });

  it("delays only low-priority requests, only under enforce at stage 4", () => {
    const g = new DemandGovernor(cfg({ enforce: true, stageOverride: 4, delayMs: 1234 }));
    g.update(input(0));
    expect(g.delayFor({}, "claude-haiku-4-5", undefined)).toBe(1234);
    expect(g.delayFor({ stream: true, tools: [{}], max_tokens: 9000, messages: [] }, "claude-opus-4-7", "low")).toBe(0);
    const g3 = new DemandGovernor(cfg({ enforce: true, stageOverride: 3 }));
    g3.update(input(0));
    expect(g3.delayFor({}, "claude-haiku-4-5", undefined)).toBe(0);
  });
});

describe("config", () => {
  it("defaults every bad field and stays off unless enabled is true", () => {
    expect(resolveGovernorConfig({ enabled: "yes" }).enabled).toBe(false);
    const c = resolveGovernorConfig({
      enabled: true, enforce: true, stageOverride: 7, thresholds: [1, 0.5, 2, 3], hysteresis: -1,
      delayMs: 999_999, throttleBoost: 3, spillPoolUtil: 0,
    });
    expect(c).toEqual({ ...DEFAULT_GOVERNOR, enabled: true, enforce: true });
    expect(resolveGovernorConfig({ enabled: true, stageOverride: 2, thresholds: [0.5, 0.7, 0.9, 1.1], delayMs: 500 }))
      .toMatchObject({ stageOverride: 2, thresholds: [0.5, 0.7, 0.9, 1.1], delayMs: 500 });
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

interface Router { base: string; logs: () => string; stop: () => Promise<void>; upstream: Server; dir: string }

async function startRouter(governor: object | undefined): Promise<Router> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-governor-"));
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" });
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
    id: "fixture", accessToken: "fixture", refreshToken: "fixture",
    expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }]));
  writeFileSync(join(dir, "config.json"), JSON.stringify(governor ? { routing: { governor } } : {}));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
    ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"),
    SESSIONS_PATH: join(dir, "sessions.json"),
  };
  delete env["QUOTA_HISTORY_PATH"];
  delete env["USAGE_PATH"];
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${(upstream.address() as { port: number }).port}'});`], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout!.on("data", b => { logs += b; });
  child.stderr!.on("data", b => { logs += b; });
  await waitForListening(child, () => logs);
  return {
    base: `http://127.0.0.1:${port}`, logs: () => logs, upstream, dir,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 4000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await new Promise<void>(r => upstream.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const TURN = { stream: false, max_tokens: 32_000, tools: [{ name: "Bash", input_schema: { type: "object" } }] };
const SHORT = { max_tokens: 2068, system: [{ type: "text", text: "classify" }] };

/** Status and how long the router took to answer, in ms. */
async function timed(base: string, model: string, body: object, headers: Record<string, string> = {}): Promise<{ status: number; ms: number }> {
  const t = Date.now();
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "x" }], ...body }),
  });
  await res.text();
  return { status: res.status, ms: Date.now() - t };
}

interface GovernorView { enabled: boolean; enforce: boolean; stage: number; applied: number; reason: string; hours: Array<{ changes: number; delayed: number; maxStage: number }> }
const health = async (base: string) =>
  (await (await fetch(`${base}/cc-router/health`, { signal: AbortSignal.timeout(5000) })).json()) as { governor: GovernorView };

const DELAY = 1500;

describe("the governor through a real router", () => {
  it("is off by default and shows so in health", async () => {
    const r = await startRouter(undefined);
    try {
      const h = await health(r.base);
      expect(h.governor).toMatchObject({ enabled: false, enforce: false, stage: 0, applied: 0 });
      expect((await timed(r.base, "claude-haiku-4-5", SHORT)).ms).toBeLessThan(DELAY);
    } finally {
      await r.stop();
    }
  }, 30_000);

  it("under enforce at stage 4 delays low-priority requests, never opus, and refuses nothing", async () => {
    const r = await startRouter({ enabled: true, enforce: true, stageOverride: 4, delayMs: DELAY });
    try {
      const haiku = await timed(r.base, "claude-haiku-4-5", TURN);
      const classify = await timed(r.base, "claude-sonnet-4-6", SHORT);
      const marked = await timed(r.base, "claude-sonnet-4-6", TURN, { "x-cc-router-priority": "low" });
      const sonnetTurn = await timed(r.base, "claude-sonnet-4-6", TURN);
      const opusTurn = await timed(r.base, "claude-opus-4-7", TURN, { "x-cc-router-priority": "low" });
      const opusShort = await timed(r.base, "claude-opus-4-7", SHORT);
      for (const x of [haiku, classify, marked, sonnetTurn, opusTurn, opusShort]) expect(x.status).toBe(200);
      for (const x of [haiku, classify, marked]) expect(x.ms).toBeGreaterThanOrEqual(DELAY - 50);
      for (const x of [sonnetTurn, opusTurn, opusShort]) expect(x.ms).toBeLessThan(DELAY - 100);

      const h = await health(r.base);
      expect(h.governor).toMatchObject({ enabled: true, enforce: true, stage: 4, applied: 4 });
      expect(h.governor.hours.reduce((n, x) => n + x.changes, 0)).toBe(1);
      expect(h.governor.hours.reduce((n, x) => n + x.delayed, 0)).toBe(3);
      expect(r.logs()).toMatch(/governor stage 0 → 4 — stage pinned/);
    } finally {
      await r.stop();
    }
  }, 30_000);

  it("observe-only judges and logs the stage but delays nothing", async () => {
    const r = await startRouter({ enabled: true, enforce: false, stageOverride: 4, delayMs: DELAY });
    try {
      const haiku = await timed(r.base, "claude-haiku-4-5", SHORT);
      expect(haiku.status).toBe(200);
      expect(haiku.ms).toBeLessThan(DELAY - 100);
      const h = await health(r.base);
      expect(h.governor).toMatchObject({ enabled: true, enforce: false, stage: 4, applied: 0 });
      expect(h.governor.hours.reduce((n, x) => n + x.delayed, 0)).toBe(0);
      expect(r.logs()).toMatch(/governor stage 0 → 4 \(observe only\)/);
    } finally {
      await r.stop();
    }
  }, 30_000);
});
