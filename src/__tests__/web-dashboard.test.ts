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
async function boot(respond: () => Promise<unknown>, usage: () => Promise<unknown> = ok(usageSummary())): Promise<Booted> {
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
      createTextNode: (t: string) => new FakeText(t),
      addEventListener() {},
    },
    window: { getSelection: () => ({ isCollapsed: true }) },
    fetch: (url: string) => {
      urls.push(String(url));
      return String(url).startsWith(USAGE_HISTORY_PATH) ? usage() : respond();
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
    accounts, recentLogs: [], ...over,
  };
  // The router sends its own verdict with health; the fixture asks the real module for it, so the
  // page is exercised against what a router would really send.
  return { severity: computeSeverity(doc.accounts as never, doc.recentLogs as never, Date.now()), ...doc };
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
    expect(html).not.toMatch(/https?:\/\//);
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

  it("shows the four rolling totals, with a request count and the share served from cache", async () => {
    const page = await boot(ok(health([account()])));
    const tiles = page.rows("wintiles");
    expect(tiles).toHaveLength(4);
    expect(tiles[0]).toContain("Last 24 hours");
    expect(tiles[0]).toContain("1.2M");
    expect(tiles[0]).toContain("12 requests");
    expect(tiles[0]).toContain("cache read 99%");
    expect(tiles.map(t => t.split(" ").slice(0, 2).join(" "))).toEqual(["Last 24", "Last 7", "Last 14", "Last 30"]);
  });

  it("puts the four-way breakdown and the rolling rule in each tile's tooltip", async () => {
    const page = await boot(ok(health([account()])));
    const [first] = page.el("wintiles").children as FakeEl[];
    expect(first.title).toContain("input 1K");
    expect(first.title).toContain("output 2K");
    expect(first.title).toContain("cache read 1.2M");
    expect(first.title).toContain("cache write 7K");
    expect(first.title).toContain("rolling window");
  });

  it("says which windows are not yet a full window, and only those", async () => {
    const page = await boot(ok(health([account()])));
    const tiles = page.rows("wintiles");
    expect(tiles[0]).not.toContain("recording since");
    expect(tiles[1]).not.toContain("recording since");
    expect(tiles[2]).toContain("recording since");
    expect(tiles[3]).toContain("recording since");
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
    for (const t of page.rows("wintiles")) {
      expect(t).toContain("–");
      expect(t).toContain("nothing recorded yet");
      expect(t).not.toMatch(/\b0\b/);
    }
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
      const page = await boot(ok(health([acct])));
      const server = windowReading(rateLimits as never, "fiveHour", Date.now());
      const shown = /\b\d+%/.test(page.rows("accbody")[0] ?? "");
      expect(shown, JSON.stringify(rateLimits)).toBe(server.ok);
      const rung = computeSeverity([acct] as never, [], Date.now()).accounts[0].rung;
      expect(rung === "ok", JSON.stringify(rateLimits)).toBe(!(server.ok && server.util >= 0.8));
    }
  });
});
