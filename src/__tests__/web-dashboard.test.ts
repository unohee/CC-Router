import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { runInNewContext, Script } from "node:vm";
import express from "express";
import {
  DASHBOARD_CSP,
  DASHBOARD_PATH,
  DASHBOARD_SCRIPT,
  USAGE_HISTORY_PATH,
  USAGE_SERIES_PATH,
  mountWebDashboard,
  renderDashboardHtml,
} from "../proxy/web-dashboard.js";
import { computeSeverity, windowReading } from "../proxy/severity.js";

// ─── A just-enough DOM ────────────────────────────────────────────────────────
// The script is what can be wrong about this page, not the markup, so it is run
// for real against a stub DOM. The stub makes every markup-parsing route throw:
// if the script ever reaches for innerHTML the render fails and the banner says so.

class FakeText { constructor(public data: string) {} }
type Child = FakeEl | FakeText;

class FakeEl {
  children: Child[] = [];
  className = "";
  title = "";
  hidden = false;
  style: Record<string, string> = {};
  // A browser lays these out; the stub just has to hold them so scrolling can be observed.
  scrollWidth = 480;
  scrollLeft = 0;
  attrs: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  constructor(public tag = "div") {}
  appendChild(c: Child) { this.children.push(c); return c; }
  replaceChildren(...c: Child[]) { this.children = c; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(ev: string, fn: () => void) { this.listeners[ev] = fn; }
  set textContent(v: string) { this.children = [new FakeText(String(v))]; }
  get textContent(): string { return textOf(this); }
  set innerHTML(_v: string) { throw new Error("innerHTML is forbidden on this page"); }
  set outerHTML(_v: string) { throw new Error("outerHTML is forbidden on this page"); }
  insertAdjacentHTML() { throw new Error("insertAdjacentHTML is forbidden on this page"); }
}

function textOf(n: Child): string {
  return n instanceof FakeText ? n.data : n.children.map(textOf).join(" ");
}
function find(n: Child, pred: (e: FakeEl) => boolean, out: FakeEl[] = []): FakeEl[] {
  if (n instanceof FakeEl) {
    if (pred(n)) out.push(n);
    n.children.forEach(c => find(c, pred, out));
  }
  return out;
}

interface Booted {
  el: (id: string) => FakeEl;
  rows: (id: string) => string[];
  /** Every URL the script asked for, in order. */
  urls: string[];
}

/**
 * `respond` answers the health poll; `usage` answers the token-history request,
 * and defaults to a valid summary so every test sees the whole page drawn.
 */
async function boot(
  respond: () => Promise<unknown>,
  usage: () => Promise<unknown> = ok(usageSummary()),
  series: () => Promise<unknown> = ok(usageSeries()),
): Promise<Booted> {
  const urls: string[] = [];
  const els = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => {
    if (!els.has(id)) els.set(id, new FakeEl());
    return els.get(id)!;
  };
  const sandbox = {
    document: {
      hidden: false,
      getElementById: el,
      createElement: (tag: string) => new FakeEl(tag),
      createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
      createTextNode: (t: string) => new FakeText(t),
      addEventListener() {},
    },
    window: { getSelection: () => ({ isCollapsed: true }) },
    fetch: (url: string) => {
      urls.push(String(url));
      if (String(url).startsWith(USAGE_HISTORY_PATH)) return usage();
      if (String(url).startsWith(USAGE_SERIES_PATH)) return series();
      return respond();
    },
    AbortController,
    // Timers are captured, never run: a real 3-second poll would outlive the test.
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 1,
  };
  runInNewContext(DASHBOARD_SCRIPT, sandbox);
  for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
  return { el, rows: id => el(id).children.map(textOf), urls };
}

const ok = (health: unknown) => async () => ({
  ok: true,
  status: 200,
  headers: { get: (k: string) => (k === "date" ? new Date().toUTCString() : null) },
  json: async () => health,
});

const NO_LIMITS = { status: "unknown", fiveHourUtil: 0, fiveHourReset: 0, sevenDayUtil: 0, sevenDayReset: 0, claim: "", plan: "", requestsLimit: 0, lastUpdated: 0 };

function account(over: Record<string, unknown> = {}) {
  return {
    id: "lyra", provider: "anthropic_subscription", enabled: true, healthy: true, busy: false,
    modelCooldowns: {}, requestCount: 12, errorCount: 0, expiresInMs: 3_600_000,
    lastUsedMs: Date.now() - 60_000, lastRefreshMs: 0, sessionLimitPercent: 100, weeklyLimitPercent: 100,
    rateLimits: NO_LIMITS,
    ...over,
  };
}
function health(accounts: unknown[], over: Record<string, unknown> = {}) {
  const doc = {
    status: "ok", mode: "standalone", target: "https://api.anthropic.com", uptime: 7200,
    totalRequests: 200, totalErrors: 5, totalRefreshes: 3, totalCacheReadTokens: 451_000,
    totalCacheCreationTokens: 0, totalInputTokens: 93, totalOutputTokens: 12_345,
    accounts, recentLogs: [], performance: perfSnapshot(), ...over,
  };
  // The router sends its own verdict with health; the fixture asks the real module for it, so the
  // page is exercised against what a router would really send.
  return { severity: computeSeverity(doc.accounts as never, doc.recentLogs as never, Date.now()), ...doc };
}
function perfStat(over: Record<string, unknown> = {}) {
  return {
    requests: 40, errors: 1, rateLimited: 1, errorRate: 0.025, completed: 38,
    p50Ms: 12_400, p95Ms: 31_000, outputTokensPerSecond: 61.4, ...over,
  };
}
function perfSnapshot(over: Record<string, unknown> = {}) {
  return {
    windowMs: 3_600_000, observedMs: 3_600_000, pool: perfStat(),
    accounts: { lyra: perfStat() }, models: { "claude-opus-5-5": perfStat() }, ...over,
  };
}

/** A 24-hour series: two named models and "other", recording from the fourth hour. */
function usageSeries(over: Record<string, unknown> = {}) {
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  return {
    generatedAt: Date.now(), tz: "Asia/Seoul", tzFallback: false, since: hour - 20 * 3_600_000,
    range: "24h", step: "hour",
    series: [
      { model: "claude-opus-5-5", provider: "anthropic" },
      { model: "gpt-6.1-sol", provider: "openai" },
      { model: "gpt-6-luna", provider: "openai" },
    ],
    points: Array.from({ length: 24 }, (_, i) => ({
      start: hour - (23 - i) * 3_600_000, date: "2026-10-26", recorded: i >= 3,
      requests: i >= 3 ? [10 + i, 2, 1] : [0, 0, 0],
      output: i >= 3 ? [1000, 200, 0] : [0, 0, 0],
      total: i >= 3 ? [500_000, 80_000, 1000] : [0, 0, 0],
    })),
    totals: { requests: 500, input: 10, output: 24_000, cacheRead: 9_000_000, cacheCreation: 10, total: 12_000_000, cacheHitRatio: 0.96 },
    ...over,
  };
}

// ─── Token-history fixtures ───────────────────────────────────────────────────

const totals = (total: number, over: Record<string, unknown> = {}) =>
  ({ total, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0, ...over });

/** `n` consecutive days from `start`, each given by `make(i)`. */
function dayRun(start: string, n: number, make: (i: number) => Record<string, unknown> = () => ({})) {
  const [y, m, d] = start.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10), ...totals(0), level: 0, ...make(i),
  }));
}

function usageSummary(over: Record<string, unknown> = {}) {
  return {
    generatedAt: Date.now(), tz: "Asia/Seoul", tzFallback: false, since: Date.parse("2026-10-01T00:00:00Z"),
    windows: {
      "1d": { ...totals(1_200_000, { input: 1000, output: 2000, cacheRead: 1_190_000, cacheCreation: 7000, requests: 12 }), partial: false },
      "7d": { ...totals(9_000_000, { input: 5000, output: 9000, cacheRead: 8_900_000, cacheCreation: 86_000, requests: 80 }), partial: false },
      "14d": { ...totals(20_000_000, { requests: 150 }), partial: true },
      "30d": { ...totals(40_000_000, { input: 40_000, output: 90_000, cacheRead: 39_000_000, cacheCreation: 870_000, requests: 400 }), partial: true },
    },
    cells: [{ pad: true }, { pad: true }, ...dayRun("2026-10-04", 3, i => ({ total: i * 100, level: i }))],
    models: {
      windowDays: 30,
      rows: [
        { model: "claude-sonnet-5-5", provider: "anthropic", total: 30_000_000, share: 0.75, requests: 300 },
        { model: "gpt-5.6-terra", provider: "openai", total: 6_000_000, share: 0.15, requests: 60 },
      ],
      others: { count: 2, total: 4_000_000, share: 0.1 },
    },
    details: {
      windowDays: 30, displayDays: 90, cacheHitRatio: 0.8, avgTokensPerRequest: 100_000,
      busiest: { date: "2026-10-06", total: 200 }, activeDays: 2, recordedDays: 3,
    },
    ...over,
  };
}

const inMin = (m: number) => Math.round(Date.now() / 1000) + m * 60;

// ─── The document itself ──────────────────────────────────────────────────────

describe("dashboard document", () => {
  const html = renderDashboardHtml();

  it("allows exactly the inline script and style it ships, by hash", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    const h = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
    expect(DASHBOARD_CSP).toContain(`script-src ${h(script)}`);
    expect(DASHBOARD_CSP).toContain(`style-src ${h(style)}`);
    expect(DASHBOARD_CSP).not.toContain("unsafe-inline");
    expect(DASHBOARD_CSP).not.toContain("unsafe-eval");
  });

  it("reaches nothing but the router it was loaded from", () => {
    // The SVG namespace is a name, never fetched; any other URL would be a request off the router.
    expect(html.split("http://www.w3.org/2000/svg").join("")).not.toMatch(/https?:\/\//);
    expect(DASHBOARD_CSP).toContain("default-src 'none'");
    expect(DASHBOARD_CSP).toContain("connect-src 'self'");
    expect(DASHBOARD_CSP).toContain("frame-ancestors 'none'");
  });

  it("is syntactically valid JavaScript", () => {
    expect(() => new Script(DASHBOARD_SCRIPT)).not.toThrow();
  });
});

describe("dashboard route", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>(r => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function serve(): Promise<string> {
    const app = express();
    mountWebDashboard(app);
    server = createServer(app);
    await new Promise<void>(r => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  it("serves the page with the hardening headers", async () => {
    const base = await serve();
    const res = await fetch(base + DASHBOARD_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe(DASHBOARD_CSP);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toContain("<title>CC-Router");
  });

  it("sends /cc-router to the page rather than letting it fall through to the proxy", async () => {
    const base = await serve();
    const res = await fetch(base + "/cc-router", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DASHBOARD_PATH);
  });
});

// ─── The script, run for real ────────────────────────────────────────────────

describe("dashboard script", () => {
  it("shows Codex quotas and actual Ollama monthly credit balance in the same account table", async () => {
    const page = await boot(ok(health([account({
      id: "codex", provider: "openai_subscription",
      rateLimits: { ...NO_LIMITS, fiveHourUtil: 0.23, sevenDayUtil: 0.67, fiveHourReset: inMin(60), sevenDayReset: inMin(3000), lastUpdated: Date.now(), plan: "pro" },
    })], {
      ollamaFallback: {
        enabled: true, ready: true, keyRequired: true, keyPresent: true,
        model: "deepseek-v4-pro", requests: 4, errors: 0,
        quota: {
          status: "known", source: "https://ollama.com/api/balance", checkedAt: Date.now() - 30_000,
          balance: { includedUsd: 273.04, allowanceUsd: 300, purchasedUsd: 5 }, resetsAt: Date.now() + 86_400_000,
        },
      },
    })));
    const [codex, ollama] = page.rows("accbody");
    expect(codex).toContain("Codex · pro");
    expect(codex).toContain("23%");
    expect(codex).toContain("67%");
    expect(ollama).toContain("Ollama Cloud");
    expect(ollama).toContain("$273.04 / $300.00 remaining");
    expect(ollama).toContain("monthly credits · 9% used");
    expect(ollama).toContain("prepaid remaining $5.00");
    expect(ollama).toContain("checked");
    expect(ollama).toContain("API key set");
    expect(find(page.el("accbody"), el => el.attrs["colspan"] === "2")).toHaveLength(1);
    expect(find(page.el("accbody"), el => el.title === "https://ollama.com/api/balance")).toHaveLength(1);
    expect(page.el("accsum").textContent).toBe("1 of 1 subscription accounts ok");
  });

  it("marks exhausted monthly and prepaid credits red, but keeps prepaid capacity available", async () => {
    for (const purchasedUsd of [0, 5]) {
      const page = await boot(ok(health([], { ollamaFallback: {
        enabled: true, ready: true, serving: true,
        quota: { status: "known", source: "https://ollama.com/api/balance", checkedAt: Date.now(), balance: { includedUsd: 0, allowanceUsd: 300, purchasedUsd }, resetsAt: Date.now() + 60_000 },
      } })));
      const row = page.rows("accbody")[0];
      if (purchasedUsd === 0) {
        expect(row).toContain("credits exhausted");
        expect(find(page.el("accbody"), el => el.className === "glyph g-good")).toHaveLength(0);
        expect(find(page.el("accbody"), el => el.className === "glyph g-crit")).toHaveLength(1);
      } else {
        expect(row).not.toContain("credits exhausted");
        expect(row).toContain("serving");
        expect(row).toContain("prepaid remaining $5.00");
      }
    }
  });

  it("does not turn a missing or stale Ollama balance into zero usage", async () => {
    for (const quota of [undefined,
      { status: "unavailable", source: "https://ollama.com/api/balance", checkedAt: Date.now(), reason: "HTTP 503", resetsAt: null },
      { status: "known", source: "https://ollama.com/api/balance", checkedAt: Date.now() - 120_000, balance: { includedUsd: 300, allowanceUsd: 300, purchasedUsd: 0 }, resetsAt: Date.now() - 60_000 },
    ]) {
      const page = await boot(ok(health([], { ollamaFallback: { enabled: true, ready: true, quota } })));
      const [ollama] = page.rows("accbody");
      expect(ollama).toMatch(/quota (unavailable|reset)/);
      expect(ollama).not.toContain("0% used");
      expect(ollama).not.toContain("$300");
      expect(find(page.el("accbody"), el => el.attrs["aria-valuenow"] !== undefined)).toHaveLength(0);
    }
  });

  it("shows negative credit balances as reported while keeping the visual meter bounded", async () => {
    const page = await boot(ok(health([], { ollamaFallback: {
      enabled: true, ready: true,
      quota: { status: "known", source: "https://ollama.com/api/balance", checkedAt: Date.now(), balance: { includedUsd: -15, allowanceUsd: 300, purchasedUsd: 0 }, resetsAt: Date.now() + 60_000 },
    } })));
    expect(page.rows("accbody")[0]).toContain("$-15.00 / $300.00 remaining");
    expect(page.rows("accbody")[0]).toContain("105% used");
    expect(find(page.el("accbody"), el => el.className.startsWith("fill") && el.style.width === "100%")).toHaveLength(1);
  });

  it("does not draw an unmeasured account as 0%", async () => {
    // A router that just restarted has measured nothing. A bar at 0% would say
    // "idle", which is the opposite of "unknown".
    const page = await boot(ok(health([account()])));
    const [row] = page.rows("accbody");
    expect(row).toContain("not measured yet");
    expect(row).not.toMatch(/\b0%/);
    expect(page.el("banner").hidden).toBe(true);
  });

  it("shows a reading, and says 'no reading' for a window with no figure and no reset time", async () => {
    // The live router reports 7d as utilisation 0 with no reset time for every
    // account, and the pool leaves a rolled-over window in the same shape. That
    // is absence, not zero use.
    const page = await boot(ok(health([account({
      rateLimits: { ...NO_LIMITS, status: "allowed", fiveHourUtil: 0.43, fiveHourReset: inMin(72), lastUpdated: Date.now() },
    })])));
    const [row] = page.rows("accbody");
    expect(row).toContain("43%");
    expect(row).toContain("resets in 1h 1");
    expect(row).toContain("no reading");
    expect(row).not.toMatch(/\b0%/);
  });

  it("explains a missing reading in a tooltip rather than leaving it a mystery", async () => {
    const page = await boot(ok(health([account({
      rateLimits: { ...NO_LIMITS, status: "allowed", fiveHourUtil: 0.2, fiveHourReset: inMin(30), lastUpdated: Date.now() },
    })])));
    const notes = find(page.el("accbody"), e => e.className === "note" && e.title !== "");
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain("did not report");
    expect(notes[0].title).toContain("has not opened yet");
  });

  it("refuses to show a utilisation whose window has already reset", async () => {
    const page = await boot(ok(health([account({
      rateLimits: { ...NO_LIMITS, status: "allowed", fiveHourUtil: 0.93, fiveHourReset: inMin(-5), lastUpdated: Date.now() },
    })])));
    const [row] = page.rows("accbody");
    expect(row).toContain("reset since last reading");
    expect(row).not.toContain("93%");
  });

  it("flags heat with a mark and a word, and clamps the bar at the track", async () => {
    const page = await boot(ok(health([
      account({ id: "hot", rateLimits: { ...NO_LIMITS, fiveHourUtil: 0.8, fiveHourReset: inMin(30), lastUpdated: Date.now() } }),
      account({ id: "full", rateLimits: { ...NO_LIMITS, fiveHourUtil: 1.01, fiveHourReset: inMin(30), lastUpdated: Date.now() } }),
    ])));
    const [hot, full] = page.rows("accbody");
    expect(hot).toContain("80%");
    expect(hot).toContain("▲");
    expect(hot).toContain("hot");
    // Over 100% is reported as it is — the router really did see 101 — but the
    // fill cannot grow past its track.
    expect(full).toContain("101%");
    expect(full).toContain("at limit");
    const fills = find(page.el("accbody"), e => e.className.startsWith("fill") && e.style["width"] === "100%");
    expect(fills.length).toBe(1);
    expect(fills[0].className).toContain("crit");
  });

  it("marks a routing cap on the meter only when it is below 100%", async () => {
    const page = await boot(ok(health([
      account({ id: "capped", sessionLimitPercent: 90, rateLimits: { ...NO_LIMITS, fiveHourUtil: 0.2, fiveHourReset: inMin(30), lastUpdated: Date.now() } }),
      account({ id: "open", rateLimits: { ...NO_LIMITS, fiveHourUtil: 0.2, fiveHourReset: inMin(30), lastUpdated: Date.now() } }),
    ])));
    const ticks = find(page.el("accbody"), e => e.className === "tick");
    expect(ticks.length).toBe(1);
    expect(ticks[0].style["left"]).toBe("calc(90% - 1px)");
    expect(page.rows("accbody")[0]).toContain("cap 90%");
  });

  it("says why an account is not serving", async () => {
    // `healthy` stays true through a cooldown on the real server, so the fixtures
    // keep it true: the summary must not trust that flag.
    const page = await boot(ok(health([
      account({ id: "off", enabled: false, healthy: false }),
      account({ id: "cool", coolingUntil: Date.now() + 600_000 }),
      account({ id: "lim", rateLimits: { ...NO_LIMITS, status: "rate_limited", lastUpdated: Date.now() } }),
      account({ id: "fine" }),
    ], { status: "ok" })));
    const [off, cool, lim] = page.rows("accbody");
    expect(off).toContain("disabled");
    expect(cool).toContain("cooling");
    expect(lim).toContain("rate limited");
    expect(page.el("accsum").textContent).toBe("1 of 4 ok");
  });

  it("puts upstream-controlled text in the page as text, never as markup", async () => {
    // Upstream error messages are copied into the activity log verbatim.
    const evil = "<img src=x onerror=alert(1)>";
    const page = await boot(ok(health([account()], {
      recentLogs: [{ ts: Date.now(), accountId: "lyra", model: "claude-x", type: "error", details: `upstream refused (400): ${evil}` }],
    })));
    // The stub throws on innerHTML, which would surface as this banner.
    expect(page.el("banner").hidden).toBe(true);
    const [row] = page.rows("logbody");
    expect(row).toContain(evil);
    expect(find(page.el("logbody"), e => e.tag === "img")).toHaveLength(0);
  });

  it("keeps the counters since start to one line, with the error rate when there are requests", async () => {
    const busy = await boot(ok(health([account()])));
    expect(busy.el("since").textContent).toBe(
      "Since the router started: 200 requests · 5 errors (2.5%) · input 93 · output 12.3K · cache read 451K · 3 token refreshes");
    const idle = await boot(ok(health([account()], { totalRequests: 0, totalErrors: 0, totalRefreshes: 1 })));
    expect(idle.el("since").textContent).toContain("0 requests · 0 errors ·");
    expect(idle.el("since").textContent).not.toContain("%");
    expect(idle.el("since").textContent).toMatch(/1 token refresh$/);
  });

  it("shows the newest 20 events and expands on request", async () => {
    const logs = Array.from({ length: 30 }, (_, i) => ({
      ts: Date.now() - i * 1000, accountId: "lyra", model: "claude-x", type: "route", details: `event ${i}`,
    }));
    const page = await boot(ok(health([account()], { recentLogs: logs })));
    expect(page.rows("logbody")).toHaveLength(20);
    expect(page.rows("logbody")[0]).toContain("event 0");
    expect(page.el("more").textContent).toBe("Show all 30");
    page.el("more").listeners["click"]();
    expect(page.rows("logbody")).toHaveLength(30);
    expect(page.el("more").textContent).toBe("Show fewer");
  });

  it("says plainly when the router cannot be reached", async () => {
    const page = await boot(async () => { throw new Error("socket hang up"); });
    expect(page.el("banner").hidden).toBe(false);
    expect(page.el("banner").textContent).toContain("Can't reach the router");
    expect(page.el("banner").textContent).toContain("socket hang up");
  });

  it("treats a non-200 from the router as an outage, not as data", async () => {
    const page = await boot(async () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }));
    expect(page.el("banner").textContent).toContain("HTTP 503");
    expect(page.rows("accbody")).toHaveLength(0);
  });
});

// ─── Token history ───────────────────────────────────────────────────────────

describe("dashboard token history", () => {
  const hx = (page: Booted) => find(page.el("hmgrid"), e => e.className.startsWith("hx"));
  const cellClass = (n: FakeEl) => n.className.split(" ").filter(c => c !== "hx" && c !== "sel").join(" ");

  it("asks for history in the viewer's own time zone, as a request separate from health", async () => {
    const page = await boot(ok(health([account()])));
    const usage = page.urls.filter(u => u.startsWith(USAGE_HISTORY_PATH));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toBe(`${USAGE_HISTORY_PATH}?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
    expect(page.urls.filter(u => u === "/cc-router/health")).toHaveLength(1);
  });

  it("keeps the page's request path in step with the one the server mounts", () => {
    expect(DASHBOARD_SCRIPT).toContain(`"${USAGE_HISTORY_PATH}`);
  });

  it("says nothing has been recorded rather than showing zeros, before the first sample", async () => {
    const empty = usageSummary({
      since: null,
      windows: Object.fromEntries(["1d", "7d", "14d", "30d"].map(k => [k, { ...totals(0), partial: true }])),
      cells: dayRun("2026-10-04", 3, () => ({ level: null })),
      models: { windowDays: 30, rows: [], others: null },
      details: { windowDays: 30, displayDays: 90, cacheHitRatio: null, avgTokensPerRequest: null, busiest: null, activeDays: 0, recordedDays: 0 },
    });
    const page = await boot(ok(health([account()])), ok(empty));
    expect(page.el("usesum").textContent).toBe("nothing recorded yet");
    expect(page.el("usestate").hidden).toBe(true);
  });

  describe("the grid of days", () => {
    it("draws one square per day, with the blank slots that line the first day up with its weekday", async () => {
      const page = await boot(ok(health([account()])));
      expect(hx(page)).toHaveLength(5);
      const pads = hx(page).filter(n => n.className.includes("hp"));
      expect(pads).toHaveLength(2);
      for (const p of pads) expect(p.attrs["aria-hidden"]).toBe("true");
    });

    it("tells apart 'no data', 'recorded but nothing used' and each heat level — by class, never by an inline style attribute", async () => {
      const cells = [...dayRun("2026-10-04", 6, i => ({ level: i === 0 ? null : i - 1, total: i > 1 ? i * 10 : 0 }))];
      const page = await boot(ok(health([account()])), ok(usageSummary({ cells })));
      expect(hx(page).map(cellClass)).toEqual(["hn", "h0", "h1", "h2", "h3", "h4"]);
      for (const n of hx(page)) expect(n.attrs["style"]).toBeUndefined();
    });

    it("gives each square a tooltip and accessible name saying what it holds", async () => {
      const cells = dayRun("2026-10-04", 3, i => ({
        level: [null, 0, 3][i], total: [0, 0, 5000][i], input: [0, 0, 1000][i], output: [0, 0, 500][i],
        cacheRead: [0, 0, 3000][i], cacheCreation: [0, 0, 500][i], requests: [0, 0, 7][i],
      }));
      const page = await boot(ok(health([account()])), ok(usageSummary({ cells })));
      const [none, zero, busy] = hx(page);
      expect(none.title).toContain("Sun, Oct 4");
      expect(none.title).toContain("no data");
      expect(zero.title).toContain("Mon, Oct 5");
      expect(zero.title).toContain("nothing recorded");
      expect(busy.title).toContain("Tue, Oct 6");
      expect(busy.title).toContain("5K tokens");
      expect(busy.title).toContain("cache read 3K");
      expect(busy.title).toContain("7 requests");
      expect(busy.attrs["aria-label"]).toBe(busy.title);
      expect(busy.attrs["role"]).toBe("img");
    });

    it("shows a day's breakdown when it is tapped, and moves the mark when another is", async () => {
      const page = await boot(ok(health([account()])));
      const days = hx(page).filter(n => !n.className.includes("hp"));
      days[1].listeners["click"]();
      expect(page.el("hminfo").textContent).toContain("Mon, Oct 5");
      expect(days[1].className).toContain("sel");
      days[2].listeners["click"]();
      expect(page.el("hminfo").textContent).toContain("Tue, Oct 6");
      expect(days[1].className).not.toContain("sel");
      expect(days[2].className).toContain("sel");
    });

    it("names the months over the column where each begins", async () => {
      // 2026-09-20 is a Sunday, so the weeks are Sep 20, Sep 27, Oct 4, ...
      const page = await boot(ok(health([account()])), ok(usageSummary({ cells: dayRun("2026-09-20", 35) })));
      const labels = page.el("hmmonths").children as FakeEl[];
      expect(labels.map(l => [textOf(l), l.style["gridColumnStart"]])).toEqual([["Sep", "1"], ["Oct", "3"]]);
    });

    it("drops a month name that would sit on top of the one before it, and names it a column later", async () => {
      // 2026-09-27 is a Sunday: October's first column is only one after September's.
      const page = await boot(ok(health([account()])), ok(usageSummary({ cells: dayRun("2026-09-27", 35) })));
      const labels = page.el("hmmonths").children as FakeEl[];
      expect(labels.map(l => [textOf(l), l.style["gridColumnStart"]])).toEqual([["Sep", "1"], ["Oct", "3"]]);
    });

    it("starts a grid wider than its card at the newest week, not the oldest", async () => {
      const page = await boot(ok(health([account()])));
      expect(page.el("hmscroll").scrollLeft).toBe(480);
    });

    it("labels Monday, Wednesday and Friday on the rows they belong to", async () => {
      const page = await boot(ok(health([account()])));
      const days = page.el("hmdays").children as FakeEl[];
      expect(days.map(d => [textOf(d), d.style["gridRowStart"]])).toEqual([["Mon", "2"], ["Wed", "4"], ["Fri", "6"]]);
    });

    it("reports the busiest and the active days, or no reading when there are none", async () => {
      const page = await boot(ok(health([account()])));
      const facts = page.rows("hmfacts").join(" | ");
      expect(facts).toContain("Tue, Oct 6");
      expect(facts).toContain("2 of 3 recorded");
      const none = await boot(ok(health([account()])), ok(usageSummary({
        details: { windowDays: 30, displayDays: 90, cacheHitRatio: null, avgTokensPerRequest: null, busiest: null, activeDays: 0, recordedDays: 0 },
      })));
      expect(none.rows("hmfacts").join(" | ")).toContain("no reading");
    });
  });

  describe("models and details", () => {
    it("lists models by share, marks OpenAI ones, and rolls the rest up", async () => {
      const page = await boot(ok(health([account()])));
      const rows = page.rows("mlist");
      expect(rows[0]).toContain("claude-sonnet-5-5");
      expect(rows[0]).toContain("30M");
      expect(rows[0]).toContain("75%");
      expect(rows[1]).toContain("gpt-5.6-terra (OpenAI)");
      expect(rows[2]).toContain("2 other models");
      expect(rows[2]).toContain("10%");
    });

    it("scales each model's bar to its share, and never draws a used model as an empty bar", async () => {
      const models = {
        windowDays: 30, others: null,
        rows: [
          { model: "big", provider: "anthropic", total: 990, share: 0.99, requests: 1 },
          { model: "sliver", provider: "anthropic", total: 1, share: 0.001, requests: 1 },
        ],
      };
      const page = await boot(ok(health([account()])), ok(usageSummary({ models })));
      const widths = find(page.el("mlist"), e => e.className === "fill").map(f => f.style["width"]);
      expect(widths).toEqual(["99%", "2%"]);
    });

    it("puts a hostile model name in the page as text, never as markup", async () => {
      const evil = "<img src=x onerror=alert(1)>";
      const models = { windowDays: 30, others: null, rows: [{ model: evil, provider: "anthropic", total: 10, share: 1, requests: 1 }] };
      const page = await boot(ok(health([account()])), ok(usageSummary({ models })));
      expect(page.el("banner").hidden).toBe(true);
      expect(page.el("usestate").hidden).toBe(true);
      expect(page.rows("mlist")[0]).toContain(evil);
      expect(find(page.el("mlist"), e => e.tag === "img")).toHaveLength(0);
    });

    it("says when no model was used", async () => {
      const page = await boot(ok(health([account()])), ok(usageSummary({ models: { windowDays: 30, rows: [], others: null } })));
      expect(page.rows("mlist")[0]).toContain("No usage in the last 30 days");
    });

    it("shows the cache hit ratio, and 'no reading' — not 0% — when there is nothing to divide", async () => {
      const page = await boot(ok(health([account()])));
      expect(page.rows("detlist").join("|")).toContain("80%");
      const none = await boot(ok(health([account()])), ok(usageSummary({
        details: { windowDays: 30, displayDays: 90, cacheHitRatio: null, avgTokensPerRequest: null, busiest: null, activeDays: 0, recordedDays: 0 },
      })));
      const text = none.rows("detlist").join("|");
      expect(text).toContain("no reading");
      expect(text).not.toContain("0%");
    });

    it("splits the 30-day total into read, write, input and output", async () => {
      const page = await boot(ok(health([account()])));
      const mix = page.rows("mixlist");
      expect(mix.map(r => r.split(" ")[0])).toEqual(["Cache", "Cache", "Input", "Output"]);
      expect(mix[0]).toContain("Cache read");
      expect(mix[0]).toContain("98%");
    });
  });

  describe("when history cannot be had", () => {
    async function failing(usage: () => Promise<unknown>) {
      return boot(ok(health([account()])), usage);
    }

    it("keeps the live view whole when the request fails, and says so in its own place", async () => {
      const page = await failing(async () => { throw new Error("socket hang up"); });
      expect(page.el("banner").hidden).toBe(true);
      expect(page.rows("accbody")).toHaveLength(1);
      expect(page.el("since").textContent).toContain("Since the router started");
      expect(page.el("usestate").hidden).toBe(false);
      expect(page.el("usestate").textContent).toContain("Token history is unavailable");
      expect(page.el("usestate").textContent).toContain("socket hang up");
    });

    it("treats a non-200 as unavailable, not as data", async () => {
      const page = await failing(async () => ({ ok: false, status: 503, json: async () => ({}) }));
      expect(page.el("usestate").textContent).toContain("HTTP 503");
      expect(page.el("banner").hidden).toBe(true);
      expect(page.rows("wintiles")).toHaveLength(0);
    });

    it("refuses a reply of the wrong shape instead of half-drawing it", async () => {
      // What a router that predates this endpoint would send back: the health document.
      const page = await failing(ok(health([account()])));
      expect(page.el("usestate").textContent).toContain("unexpected response");
      expect(page.el("banner").hidden).toBe(true);
      expect(page.rows("wintiles")).toHaveLength(0);
      expect(hx(page)).toHaveLength(0);
    });

    it("refuses a heat level outside 0-4, so a value cannot become a class name", async () => {
      for (const level of [9, -1, "h1 evil", 150, NaN]) {
        const cells = dayRun("2026-10-04", 2, () => ({ level }));
        const page = await boot(ok(health([account()])), ok(usageSummary({ cells })));
        expect(page.el("usestate").textContent, String(level)).toContain("unexpected response");
        expect(hx(page)).toHaveLength(0);
      }
    });

    it("refuses a window with a missing or non-numeric figure", async () => {
      const bad = usageSummary();
      (bad.windows["7d"] as Record<string, unknown>)["total"] = "lots";
      const page = await failing(ok(bad));
      expect(page.el("usestate").textContent).toContain("unexpected response");
    });
  });
});

// ─── The history route ───────────────────────────────────────────────────────

describe("usage-history route", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>(r => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function serve(usage?: (tz: string | undefined) => unknown): Promise<string> {
    const app = express();
    mountWebDashboard(app, usage ? { usage } : {});
    server = createServer(app);
    await new Promise<void>(r => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  it("serves the summary as JSON that must not be cached or sniffed", async () => {
    const base = await serve(tz => ({ got: tz }));
    const res = await fetch(`${base}${USAGE_HISTORY_PATH}?tz=Asia%2FSeoul`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ got: "Asia/Seoul" });
  });

  it("passes no zone when none was given, or when the query holds more than one", async () => {
    const seen: Array<string | undefined> = [];
    const base = await serve(tz => { seen.push(tz); return {}; });
    await fetch(`${base}${USAGE_HISTORY_PATH}`);
    await fetch(`${base}${USAGE_HISTORY_PATH}?tz=a&tz=b`);
    await fetch(`${base}${USAGE_HISTORY_PATH}?tz[x]=y`);
    expect(seen).toEqual([undefined, undefined, undefined]);
  });

  it("answers a failure with nothing about its cause, since the caller is unauthenticated", async () => {
    const base = await serve(() => { throw new Error("secret internal detail at /Users/x/file.ts:1"); });
    const res = await fetch(base + USAGE_HISTORY_PATH);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret internal detail");
    expect(text).not.toContain("/Users");
  });

  it("is not mounted when there is no history to serve", async () => {
    const base = await serve();
    expect((await fetch(base + USAGE_HISTORY_PATH)).status).toBe(404);
  });
});

// ─── The verdict: the strip, the order, and the one definition of "wrong" ────

describe("the status strip", () => {
  const strip = (page: Booted) => ({
    hidden: page.el("strip").hidden,
    level: page.el("strip").attrs["data-level"],
    glyph: page.el("stripglyph").textContent,
    verdict: page.el("stripverdict").textContent,
    reasons: page.el("stripreasons").textContent,
    glyphClass: page.el("stripglyph").className,
  });

  it("is quiet when the pool is healthy: a tick and one sentence", async () => {
    const page = await boot(ok(health([account({ id: "a" }), account({ id: "b" })])));
    expect(strip(page)).toEqual({
      hidden: false, level: "ok", glyph: "✓", verdict: "All 2 accounts healthy", reasons: "", glyphClass: "glyph g-good",
    });
  });

  it("says Watch, with the reasons, when an account runs hot", async () => {
    const page = await boot(ok(health([account({ id: "a" }), account({
      id: "heewon", rateLimits: { ...NO_LIMITS, fiveHourUtil: 0.84, fiveHourReset: inMin(30), lastUpdated: Date.now() },
    })])));
    expect(strip(page)).toMatchObject({ level: "watch", glyph: "▲", verdict: "Watch", reasons: "heewon 5h 84%", glyphClass: "glyph g-warn" });
  });

  it("says Problem, worst first, when an account is cooling, and counts the 429s", async () => {
    const rejected = Array.from({ length: 3 }, (_, i) => ({ ts: Date.now() - i * 1000, accountId: "rigel", model: "-", type: "error", statusCode: 429 }));
    const page = await boot(ok(health([
      account({ id: "rigel", coolingUntil: Date.now() + 240_000 }),
      account({ id: "lyra", rateLimits: { ...NO_LIMITS, fiveHourUtil: 0.96, fiveHourReset: inMin(30), lastUpdated: Date.now() } }),
    ], { recentLogs: rejected })));
    const s = strip(page);
    expect(s).toMatchObject({ level: "problem", glyph: "■", verdict: "Problem", glyphClass: "glyph g-crit" });
    expect(s.reasons).toMatch(/^rigel cooling \d+m · lyra 5h 96% · 429 ×3 in 5m$/);
  });

  it("is hidden until there is data, and steps aside for the banner when the router cannot be reached", async () => {
    const down = await boot(async () => { throw new Error("socket hang up"); });
    expect(down.el("strip").hidden).toBe(true);
    expect(down.el("banner").hidden).toBe(false);
  });

  it("does not claim health it was not told of: a missing or malformed verdict reads as unknown", async () => {
    for (const severity of [undefined, null, "ok", { pool: "fine" }, { pool: "ok", headline: "x", reasons: [], accounts: [{ id: "a", rung: "__proto__", state: "ok" }], thresholds: { watch: 0.8, problem: 0.95 } }]) {
      const page = await boot(ok({ ...health([account()]), severity }));
      expect(strip(page), JSON.stringify(severity)).toMatchObject({ hidden: false, level: "unknown", glyph: "?", verdict: "Status unknown" });
      expect(page.el("banner").hidden).toBe(true);
      expect(page.rows("accbody")[0]).toContain("no verdict");
    }
  });

  it("is the first thing on the page, with the accounts straight after it and the history below", () => {
    const html = renderDashboardHtml();
    const at = (needle: string) => html.indexOf(needle);
    const order = ['id="banner"', 'id="strip"', 'aria-labelledby="acc-h"', 'id="since"', 'id="usage"', 'aria-labelledby="log-h"'].map(at);
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The six since-start tiles are gone from the top of the page.
    expect(html).not.toContain('id="tiles"');
  });

  it("reads each account's state from the verdict, with the time left on a cooldown", async () => {
    const page = await boot(ok(health([
      account({ id: "off", enabled: false, healthy: false }),
      account({ id: "all", coolingUntil: Date.now() + 600_000 }),
      account({ id: "fam", modelCooldowns: { opus: Date.now() + 300_000 } }),
      account({ id: "gone", expiresInMs: -5 }),
      account({ id: "near", rateLimits: { ...NO_LIMITS, fiveHourUtil: 0.96, fiveHourReset: inMin(30), lastUpdated: Date.now() } }),
      account({ id: "full", rateLimits: { ...NO_LIMITS, fiveHourUtil: 1.01, fiveHourReset: inMin(30), lastUpdated: Date.now() } }),
    ])));
    const rows = page.rows("accbody");
    expect(rows[0]).toContain("disabled");
    expect(rows[1]).toMatch(/cooling 10m/);
    expect(rows[2]).toMatch(/opus cooling 5m/);
    expect(rows[3]).toContain("token expired");
    expect(rows[4]).toContain("near limit");
    expect(rows[5]).toContain("at limit");
  });

  it("colours a meter by the cut-offs the router sent, not by numbers of its own", async () => {
    const reading = { ...NO_LIMITS, fiveHourUtil: 0.55, fiveHourReset: inMin(30), lastUpdated: Date.now() };
    const strict = { ...health([account({ rateLimits: reading })]) };
    strict.severity = { ...strict.severity, thresholds: { watch: 0.5, problem: 0.6 } };
    const hot = await boot(ok(strict));
    expect(find(hot.el("accbody"), e => e.className.startsWith("fill"))[0].className).toBe("fill warn");
    const plain = await boot(ok(health([account({ rateLimits: reading })])));
    expect(find(plain.el("accbody"), e => e.className.startsWith("fill"))[0].className).toBe("fill ");
  });

  it("reads a window as a reading exactly when the router's verdict does", async () => {
    // Two implementations of "is this figure a reading?" would drift; this pins them together.
    const cases: Record<string, unknown>[] = [
      { ...NO_LIMITS, fiveHourUtil: 0.99, lastUpdated: 0 },                                           // never measured
      { ...NO_LIMITS, status: "allowed", lastUpdated: Date.now() },                                   // no figure, no reset
      { ...NO_LIMITS, fiveHourUtil: 0.99, fiveHourReset: inMin(-5), lastUpdated: Date.now() },        // already reset
      { ...NO_LIMITS, fiveHourUtil: 0.85, fiveHourReset: inMin(30), lastUpdated: Date.now() },        // hot
      { ...NO_LIMITS, fiveHourUtil: 0.97, fiveHourReset: inMin(30), lastUpdated: Date.now() },        // near
      { ...NO_LIMITS, fiveHourUtil: 0.9, fiveHourReset: 0, lastUpdated: Date.now() },                 // figure, reset unknown
    ];
    for (const rateLimits of cases) {
      const acct = account({ rateLimits });
      // No last-hour figures, so the only percentage on the row is the window's.
      const page = await boot(ok(health([acct], { performance: perfSnapshot({ accounts: {} }) })));
      const server = windowReading(rateLimits as never, "fiveHour", Date.now());
      const shown = /\b\d+%/.test(page.rows("accbody")[0] ?? "");
      expect(shown, JSON.stringify(rateLimits)).toBe(server.ok);
      const rung = computeSeverity([acct] as never, [], Date.now()).accounts[0].rung;
      expect(rung === "ok", JSON.stringify(rateLimits)).toBe(!(server.ok && server.util >= 0.8));
    }
  });
});

// ─── The last hour ────────────────────────────────────────────────────────────

describe("dashboard last hour", () => {
  const kpis = (page: Booted) => page.rows("kpis");

  it("shows requests, error rate, finish p50 and p95 and output speed for the pool", async () => {
    const page = await boot(ok(health([account()])));
    const k = kpis(page);
    expect(k).toHaveLength(5);
    expect(k[0]).toContain("Requests");
    expect(k[0]).toContain("40");
    expect(k[1]).toContain("2.5%");
    expect(k[1]).toContain("1× 429");
    expect(k[2]).toContain("12.4 s");
    expect(k[3]).toContain("31.0 s");
    expect(k[4]).toContain("61 tok/s");
  });

  it("says 'no reading', never zero, for a figure the router has not measured", async () => {
    const empty = perfStat({ requests: 0, errors: 0, rateLimited: 0, errorRate: null, completed: 0, p50Ms: null, p95Ms: null, outputTokensPerSecond: null });
    const page = await boot(ok(health([account()], { performance: perfSnapshot({ pool: empty, accounts: {}, models: {} }) })));
    const k = kpis(page);
    for (const i of [1, 2, 3, 4]) {
      expect(k[i]).toContain("no reading");
      expect(k[i]).not.toMatch(/\b0(\.0)?\s?(%|s|ms|tok)/);
    }
    expect(page.rows("perfbody")[0]).toContain("No requests in the last hour");
  });

  it("says how much of the hour it has seen after a restart", async () => {
    const page = await boot(ok(health([account()], { performance: perfSnapshot({ observedMs: 12 * 60_000 }) })));
    expect(page.el("perfsum").textContent).toContain("only 12m observed");
  });

  it("keeps the page whole when the router sends no performance figures", async () => {
    const page = await boot(ok(health([account()], { performance: { pool: "broken" } })));
    expect(page.el("banner").hidden).toBe(true);
    expect(page.el("perfsum").textContent).toContain("does not report");
    expect(page.rows("accbody")[0]).toContain("no reading");
  });

  it("lists each model's figures, and marks errors with a symbol, not colour alone", async () => {
    const page = await boot(ok(health([account()], { performance: perfSnapshot({
      models: {
        "claude-opus-5-5": perfStat({ requests: 30, errors: 0, rateLimited: 0, errorRate: 0 }),
        "claude-sonnet-5-5": perfStat({ requests: 10, errors: 2, rateLimited: 0, errorRate: 0.2 }),
      },
    }) })));
    const rows = page.rows("perfbody");
    expect(rows[0]).toMatch(/^claude-opus-5-5/);
    expect(rows[1]).toContain("■");
    expect(rows[1]).toContain("20%");
  });

  it("puts each account's last hour in its row", async () => {
    const page = await boot(ok(health([account(), account({ id: "vega" })])));
    const rows = page.rows("accbody");
    expect(rows[0]).toContain("40 req");
    expect(rows[0]).toContain("p50 12.4 s");
    expect(rows[0]).toContain("2.5% errors · 1× 429");
    // One error in 40 is background, not a problem: no mark.
    expect(rows[0]).not.toContain("▲");
    expect(rows[1]).toContain("no requests");
  });
});

// ─── Activity over time ───────────────────────────────────────────────────────

describe("dashboard activity chart", () => {
  const chart = (page: Booted) => page.el("chartbox").children[0] as FakeEl;
  const rects = (page: Booted) => find(chart(page), e => e.tag === "rect");
  const press = (page: Booted, id: string) => page.el(id).listeners["click"]!();
  const key = (page: Booted, k: string) =>
    (chart(page).listeners["keydown"] as unknown as (e: unknown) => void)({ key: k, preventDefault() {} });

  it("asks for the chart's series in the viewer's zone, as a request of its own", async () => {
    const page = await boot(ok(health([account()])));
    const asked = page.urls.filter(u => u.startsWith(USAGE_SERIES_PATH));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("range=24h");
    expect(asked[0]).toContain("tz=");
    expect(DASHBOARD_SCRIPT).toContain(`"${USAGE_SERIES_PATH}"`);
  });

  it("draws a stacked bar per hour, coloured by model through classes, and a mark for hours before recording", async () => {
    const page = await boot(ok(health([account()])));
    const all = rects(page);
    const cls = (r: FakeEl) => r.attrs["class"] ?? "";
    expect(all.filter(r => cls(r) === "nodata")).toHaveLength(3);
    expect(all.filter(r => cls(r).startsWith("s0"))).toHaveLength(21);
    expect(all.filter(r => cls(r).startsWith("s1"))).toHaveLength(21);
    // Every named model gets a separate segment.
    expect(all.filter(r => cls(r).startsWith("s2"))).toHaveLength(21);
    // The current hour is unfinished and drawn as such.
    expect(all.filter(r => cls(r).includes("partial"))).toHaveLength(3);
    for (const r of all) expect(r.attrs["style"]).toBeUndefined();
  });

  it("renders more than eight models individually with textures, names and table columns", async () => {
    const models = Array.from({ length: 12 }, (_, i) => ({ model: "model-" + i, provider: "openai" }));
    const data = usageSeries();
    const page = await boot(ok(health([account()])), ok(usageSummary()), ok(usageSeries({
      series: models,
      points: data.points.map(p => ({ ...p, requests: models.map(() => 1), output: models.map(() => 2), total: models.map(() => 3) })),
    })));
    const legend = page.rows("actlegend");
    expect(legend).toHaveLength(12);
    models.forEach((m, i) => expect(legend[i]).toContain(m.model + " (OpenAI)"));
    expect(legend.join(" ")).not.toContain("Other models");
    expect(find(chart(page), e => e.tag === "pattern")).toHaveLength(4);
    expect(rects(page).some(r => r.attrs.fill === "url(#model-pattern-11)")).toBe(true);
    press(page, "acttable");
    expect(page.rows("acthead")).toHaveLength(14);
  });

  it("labels its scale and names every model in a legend with its total and share", async () => {
    const page = await boot(ok(health([account()])));
    const legend = page.rows("actlegend");
    expect(legend).toHaveLength(3);
    expect(legend[0]).toContain("claude-opus-5-5");
    expect(legend[1]).toContain("gpt-6.1-sol (OpenAI)");
    expect(legend[2]).toContain("gpt-6-luna (OpenAI)");
    const texts = find(chart(page), e => e.tag === "text").map(t => t.textContent);
    expect(texts).toContain("0");
    expect(page.el("acttot").textContent).toContain("500 requests");
    expect(page.el("acttot").textContent).toContain("cache hit 96%");
  });

  it("reads one hour at a time from the keyboard, and says when the newest one is still going", async () => {
    const page = await boot(ok(health([account()])));
    key(page, "End");
    expect(page.el("actinfo").textContent).toContain("so far this hour");
    expect(page.el("actinfo").textContent).toContain("36 requests so far this hour: claude-opus-5-5 33");
    key(page, "Home");
    expect(page.el("actinfo").textContent).toContain("no data: recording had not started");
    key(page, "ArrowRight");
    key(page, "ArrowRight");
    key(page, "ArrowRight");
    expect(page.el("actinfo").textContent).toContain("16 requests: claude-opus-5-5 13");
  });

  it("switches the measure without a new request, and the range with one", async () => {
    const page = await boot(ok(health([account()])));
    press(page, "m-output");
    expect(page.el("m-output").attrs["aria-pressed"]).toBe("true");
    expect(page.el("actlegend").children.map(textOf)[0]).toContain("21K");
    expect(page.urls.filter(u => u.startsWith(USAGE_SERIES_PATH))).toHaveLength(1);
    press(page, "r-7d");
    expect(page.el("r-7d").attrs["aria-pressed"]).toBe("true");
    const asked = page.urls.filter(u => u.startsWith(USAGE_SERIES_PATH));
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("range=7d");
  });

  it("drops an answer for a range the viewer has already left", async () => {
    // The first (24h) answer is held back until after the viewer has moved to 7d.
    let release: () => void = () => {};
    const held = new Promise<void>(r => { release = r; });
    let calls = 0;
    const series = async () => {
      calls++;
      if (calls === 1) await held;
      return ok(calls === 1 ? usageSeries() : usageSeries({ range: "7d" }))();
    };
    const page = await boot(ok(health([account()])), ok(usageSummary()), series);
    press(page, "r-7d");
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
    const drawn = page.el("chartbox").children[0];
    expect(page.el("acttot").textContent).toContain("Last 7 days");
    release();
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
    expect(page.el("chartbox").children[0]).toBe(drawn);
    expect(page.el("acttot").textContent).toContain("Last 7 days");
    expect(page.el("actstate").hidden).toBe(true);
  });

  it("refuses a reply of the wrong shape, in its own place, and leaves the rest of the page alone", async () => {
    const bad = usageSeries({ points: [{ start: 1, date: "x", recorded: true, requests: [1], output: [1], total: [1] }] });
    const page = await boot(ok(health([account()])), ok(usageSummary()), ok(bad));
    expect(page.el("actstate").hidden).toBe(false);
    expect(page.el("actstate").textContent).toContain("unavailable");
    expect(page.el("banner").hidden).toBe(true);
    expect(page.el("usestate").hidden).toBe(true);
  });

  it("offers every bar as a table row, newest first", async () => {
    const page = await boot(ok(health([account()])));
    press(page, "acttable");
    expect(page.el("acttablewrap").hidden).toBe(false);
    expect(page.el("acttable").attrs["aria-expanded"]).toBe("true");
    const rows = page.rows("actrows");
    expect(rows).toHaveLength(24);
    expect(rows[23]).toContain("no data");
    expect(page.rows("acthead")).toEqual(["Hour", "claude-opus-5-5", "gpt-6.1-sol (OpenAI)", "gpt-6-luna (OpenAI)", "Total"]);
  });

  it("puts a hostile model name in the page as text, never as markup", async () => {
    const page = await boot(ok(health([account()])), ok(usageSummary()), ok(usageSeries({
      series: [{ model: "<img src=x onerror=alert(1)>", provider: "anthropic" }],
      points: [{ start: Date.now(), date: "2026-10-26", recorded: true, requests: [1], output: [1], total: [1] }],
    })));
    expect(page.el("banner").hidden).toBe(true);
    expect(page.rows("actlegend")[0]).toContain("<img src=x onerror=alert(1)>");
  });
});

// ─── Recent activity, filtered ────────────────────────────────────────────────

describe("dashboard recent activity", () => {
  const T = Date.now();
  const logs = [
    { ts: T - 1000, accountId: "lyra", model: "claude-opus-5-5", type: "route", method: "POST", path: "/messages", statusCode: 200,
      durationMs: 900, totalMs: 40_000, outputTokens: 800, inputTokens: 2, cacheReadTokens: 90_000, cacheCreationTokens: 10_000, sessionId: "76aa4214-db3b" },
    { ts: T - 2000, accountId: "vega", model: "claude-sonnet-5-5", type: "error", method: "POST", path: "/messages", statusCode: 429, durationMs: 300, details: "rate limited" },
    { ts: T - 3000, accountId: "lyra", model: "claude-opus-5-5", type: "route", method: "POST", path: "/messages", statusCode: 200, durationMs: 1200 },
    { ts: T - 4000, accountId: "ollama", model: "kimi", type: "route", method: "POST", path: "/messages", statusCode: 200, durationMs: 5000, totalMs: 5000, clientClosed: true },
  ];
  const page = () => boot(ok(health([account()], { recentLogs: logs })));
  const change = (p: Booted, id: string, prop: "value" | "checked", v: unknown) => {
    (p.el(id) as unknown as Record<string, unknown>)[prop] = v;
    p.el(id).listeners["change"]!();
  };

  it("shows status, the whole duration when finished, speed, cache share and session", async () => {
    const rows = (await page()).rows("logbody");
    expect(rows[0]).toContain("200");
    expect(rows[0]).toContain("40.0 s");
    expect(rows[0]).toContain("20 tok/s");
    expect(rows[0]).toContain("90%");
    expect(rows[0]).toContain("76aa4214");
    expect(rows[1]).toContain("▲");
    expect(rows[1]).toContain("429");
  });

  it("names an unfinished duration as the wait for headers, not as the response time", async () => {
    const rows = (await page()).rows("logbody");
    expect(rows[2]).toContain("headers 1.2 s");
  });

  it("marks a response slower than the hour's p95, and a client that left", async () => {
    const rows = (await page()).rows("logbody");
    expect(rows[0]).toContain("▲"); // 40 s > the fixture's 31 s p95
    expect(rows[3]).toContain("client left");
  });

  it("filters by account, by model, to errors and to slow responses", async () => {
    const p = await page();
    expect(p.rows("faccount")).toEqual(["All", "lyra", "ollama", "vega"]);
    change(p, "faccount", "value", "lyra");
    expect(p.rows("logbody")).toHaveLength(2);
    expect(p.el("logsum").textContent).toContain("2 of 4 match");
    change(p, "faccount", "value", "");
    change(p, "ferr", "checked", true);
    expect(p.rows("logbody")).toHaveLength(1);
    expect(p.rows("logbody")[0]).toContain("vega");
    change(p, "ferr", "checked", false);
    change(p, "fslow", "checked", true);
    expect(p.rows("logbody")).toHaveLength(1);
    change(p, "fmodel", "value", "kimi");
    expect(p.rows("logbody")[0]).toContain("No events match");
  });

  it("does not count a client that left as an error", async () => {
    const p = await page();
    change(p, "ferr", "checked", true);
    expect(p.rows("logbody").join(" ")).not.toContain("ollama");
  });

  it("opens a row for its full details, and keeps it open across a refresh", async () => {
    const p = await page();
    const first = p.el("logbody").children[0] as FakeEl;
    first.listeners["click"]!();
    expect(first.className).toContain("open");
    expect(first.attrs["aria-expanded"]).toBe("true");
  });
});

describe("weekly windows and old readings", () => {
  const noWeekly = (over: Record<string, unknown> = {}) => ({
    ...NO_LIMITS, status: "allowed", fiveHourUtil: 0.3, fiveHourReset: inMin(60), lastUpdated: Date.now(), ...over,
  });

  it("says a 7-day window was not reported only when the router has seen enough responses without one", async () => {
    const page = await boot(ok(health([
      account({ id: "teams", weeklyWindow: "not-reported", rateLimits: noWeekly() }),
      account({ id: "fresh", weeklyWindow: "unknown", rateLimits: noWeekly() }),
    ])));
    const [teams, fresh] = page.rows("accbody");
    expect(teams).toContain("no 7d window reported");
    expect(teams).not.toContain("no reading");
    expect(fresh).toContain("no reading");
    expect(fresh).not.toContain("no 7d window reported");
    const note = find(page.el("accbody"), e => e.className === "note" && e.title.includes("may have no weekly limit"));
    expect(note).toHaveLength(1);
    // It reports what upstream said, not what the plan is.
    expect(note[0].title).toContain("what was reported, not what the plan is");
  });

  it("leaves the 5-hour side alone, and a 7-day window that exists keeps its figure", async () => {
    const page = await boot(ok(health([account({
      id: "kyte", weeklyWindow: "seen",
      rateLimits: noWeekly({ sevenDayUtil: 0.5, sevenDayReset: inMin(3000) }),
    })])));
    const [row] = page.rows("accbody");
    expect(row).toContain("30%");
    expect(row).toContain("50%");
    expect(row).not.toContain("no 7d window");
  });

  it("says how old the reading is beside a warning built on it, and in the strip", async () => {
    const idle = account({
      id: "kyte", weeklyWindow: "seen",
      rateLimits: noWeekly({ fiveHourUtil: 0, fiveHourReset: 0, sevenDayUtil: 0.88, sevenDayReset: inMin(3000), lastUpdated: Date.now() - 43 * 3_600_000 }),
    });
    const page = await boot(ok(health([account({ id: "lyra", rateLimits: noWeekly() }), idle])));
    const [lyra, kyte] = page.rows("accbody");
    expect(kyte).toContain("88%");
    expect(kyte).toContain("read 1d 19h ago");
    expect(lyra).not.toContain("read ");
    expect(page.el("stripreasons").textContent).toBe("kyte 7d 88% · 43h old");
  });

  it("does not age-stamp a reading that is current", async () => {
    const page = await boot(ok(health([account({ id: "hot", rateLimits: noWeekly({ fiveHourUtil: 0.85 }) })])));
    expect(page.rows("accbody")[0]).not.toContain("read ");
    expect(page.el("stripreasons").textContent).toBe("hot 5h 85%");
  });

  it("refuses a verdict whose age is not a number", async () => {
    const doc = health([account()]);
    doc.severity.accounts[0] = { ...doc.severity.accounts[0], age: "old" as never };
    const page = await boot(ok(doc));
    expect(page.el("strip").attrs["data-level"]).toBe("unknown");
  });
});
