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
  mountWebDashboard,
  renderDashboardHtml,
} from "../proxy/web-dashboard.js";

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
}

async function boot(respond: () => Promise<unknown>): Promise<Booted> {
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
    fetch: respond,
    AbortController,
    // Timers are captured, never run: a real 3-second poll would outlive the test.
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 1,
  };
  runInNewContext(DASHBOARD_SCRIPT, sandbox);
  for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
  return { el, rows: id => el(id).children.map(textOf) };
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
  return {
    status: "ok", mode: "standalone", target: "https://api.anthropic.com", uptime: 7200,
    totalRequests: 200, totalErrors: 5, totalRefreshes: 3, totalCacheReadTokens: 451_000,
    totalCacheCreationTokens: 0, totalInputTokens: 93, totalOutputTokens: 12_345,
    accounts, recentLogs: [], ...over,
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

  it("reports the error rate against requests, and says so when there are none", async () => {
    const busy = await boot(ok(health([account()])));
    expect(busy.rows("tiles").join("|")).toContain("2.5% of requests");
    const idle = await boot(ok(health([account()], { totalRequests: 0, totalErrors: 0 })));
    expect(idle.rows("tiles").join("|")).toContain("no requests yet");
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
