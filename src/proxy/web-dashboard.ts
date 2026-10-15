import { createHash } from "node:crypto";
import type { Express, Request, Response } from "express";

/**
 * A read-only usage page for the router, served from the router itself.
 *
 * It is one static document that polls `/cc-router/health` — the same JSON the
 * terminal dashboard reads — so it adds no data of its own and no new endpoint
 * that returns any. Everything is inlined (no build step reaches non-TS files,
 * and nothing is fetched from a CDN), and the CSP pins that: the only script and
 * style allowed are these two exact blocks, by hash.
 *
 * Upstream error text lands in the activity log, so it is attacker-influenced.
 * The client therefore builds every node with `textContent` and never parses
 * markup; the CSP is the second line, not the first.
 */

export const DASHBOARD_PATH = "/cc-router/dashboard";

const STYLE = String.raw`
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
--hair:rgba(11,11,11,.10);--accent:#2a78d6;--track:#cde2fb;--good:#006300;--warn:#fab219;--crit:#d03b3b}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;
--hair:rgba(255,255,255,.10);--accent:#3987e5;--track:#0d366b;--good:#0ca30c}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline;justify-content:space-between}
h1{margin:0;font-size:20px;font-weight:600}
h2{margin:0;font-size:14px;font-weight:600}
.meta,.sum,.note,.foot,.sub,.label{color:var(--ink2)}
.meta{margin:2px 0 0;font-size:13px}
.updated{font-size:12px;color:var(--ink2)}
.banner{margin-top:16px;padding:10px 12px;border:1px solid var(--hair);border-left:3px solid var(--crit);border-radius:6px;background:var(--surface);font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:16px}
.tile,.card{background:var(--surface);border:1px solid var(--hair);border-radius:8px}
.tile{padding:12px 14px}
.label{font-size:12px}
.value{font-size:28px;font-weight:600;line-height:1.2;margin-top:4px}
.sub{font-size:12px;margin-top:2px}
.card{margin-top:16px;padding:16px}
.cardhead{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:baseline;justify-content:space-between;margin-bottom:8px}
.sum{font-size:12px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:12px;font-weight:500;color:var(--ink2);padding:0 12px 8px 0;border-bottom:1px solid var(--hair);white-space:nowrap}
td{padding:10px 12px 10px 0;border-bottom:1px solid var(--hair);vertical-align:top}
tr:last-child td{border-bottom:0}
th:last-child,td:last-child{padding-right:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.acct{font-weight:600}
.plan{display:block;font-size:12px;font-weight:400;color:var(--ink2)}
.win{min-width:176px}
.meter{position:relative;height:8px;border-radius:4px;background:var(--track);overflow:hidden}
.meter.na{opacity:.4}
.fill{height:100%;border-radius:4px;background:var(--accent)}
.fill.warn{background:var(--warn)}
.fill.crit{background:var(--crit)}
.tick{position:absolute;top:0;bottom:0;width:2px;background:var(--surface)}
.wtext{margin-top:6px;font-size:12px;display:flex;flex-wrap:wrap;gap:0 8px;align-items:baseline}
.pct{font-size:13px;font-weight:600}
.g-good{color:var(--good)}.g-warn{color:var(--warn)}.g-crit{color:var(--crit)}.g-muted{color:var(--muted)}
.glyph{display:inline-block;width:1.1em}
.dim{color:var(--ink2)}
.clip{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mono{font-variant-numeric:tabular-nums;white-space:nowrap}
button{font:inherit;color:var(--ink);background:transparent;border:1px solid var(--hair);border-radius:6px;padding:4px 10px;cursor:pointer}
button:hover{background:var(--page)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.more{margin-top:10px}
.stale{opacity:.6}
.foot{margin-top:24px;font-size:12px}
@media (max-width:720px){
.scroll{overflow:visible}
table,tbody{display:block}
thead{display:none}
tr{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;padding:12px 0;border-bottom:1px solid var(--hair)}
tr:last-child{border-bottom:0}
td,td:last-child{display:block;padding:0;border:0;min-width:0}
td[data-wide]{grid-column:1 / -1}
td[data-label]::before{content:attr(data-label);display:block;font-size:12px;font-weight:400;color:var(--ink2)}
td.num{text-align:left}
td:empty{display:none}
.win{min-width:0}
.clip{max-width:none;white-space:normal;overflow:visible}
}
@media (forced-colors:active){.meter{background:Canvas;border:1px solid CanvasText}.fill{background:Highlight}.tick{background:CanvasText}}
`;

const BODY = String.raw`
<div class="wrap">
  <header>
    <div>
      <h1>CC-Router</h1>
      <p id="meta" class="meta">Connecting…</p>
    </div>
    <div id="updated" class="updated" aria-live="off"></div>
  </header>
  <div id="banner" class="banner" role="status" hidden></div>
  <noscript><p class="banner">This page reads live data and needs JavaScript.</p></noscript>
  <main id="main" aria-busy="true">
    <section id="tiles" class="tiles" aria-label="Totals since the router started"></section>
    <section class="card" aria-labelledby="acc-h">
      <div class="cardhead"><h2 id="acc-h">Accounts</h2><span id="accsum" class="sum"></span></div>
      <div class="scroll">
        <table>
          <thead><tr>
            <th scope="col">Account</th><th scope="col">Status</th>
            <th scope="col">5-hour window</th><th scope="col">7-day window</th>
            <th scope="col" class="num">Requests</th><th scope="col" class="num">Errors</th>
            <th scope="col">Last used</th><th scope="col">Token</th>
          </tr></thead>
          <tbody id="accbody"></tbody>
        </table>
      </div>
    </section>
    <section class="card" aria-labelledby="log-h">
      <div class="cardhead"><h2 id="log-h">Recent activity</h2><span id="logsum" class="sum"></span></div>
      <div class="scroll">
        <table>
          <thead><tr>
            <th scope="col">Time</th><th scope="col">Account</th><th scope="col">Event</th>
            <th scope="col">Model</th><th scope="col">Details</th><th scope="col">Tokens</th>
          </tr></thead>
          <tbody id="logbody"></tbody>
        </table>
      </div>
      <button id="more" class="more" type="button" hidden></button>
    </section>
  </main>
  <p class="foot">Read-only. Refreshes every few seconds from <code>/cc-router/health</code>. Usage is read from upstream response headers, so a window shows no reading until that account has served a request since the router started. This page and the health endpoint are not behind the proxy secret.</p>
</div>
`;

// Plain strings and concatenation only: this sits inside a template literal, so
// no backticks and no `${`. DOM is built with textContent — never innerHTML.
const SCRIPT = String.raw`
(function () {
  "use strict";
  var POLL_MS = 3000, WARN = 0.75, CRIT = 0.9, LOG_ROWS = 20;
  var S = { skew: 0, okAt: 0, data: null, showAll: false, timer: 0, inflight: false, failing: false };
  var nf = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function now() { return Date.now() + S.skew; }
  function num(n) { return nf.format(n || 0); }
  function dur(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m";
    return s + "s";
  }
  function ago(ts) { return ts > 0 ? dur(now() - ts) + " ago" : "never"; }
  function glyph(tone, ch) { return el("span", "glyph g-" + tone, ch); }
  // On a phone each row stacks into a card and the header row is hidden, so every
  // cell carries its own label (drawn from data-label by CSS) and the wide ones span.
  function lab(td, label, wide) {
    td.setAttribute("data-label", label);
    if (wide) td.setAttribute("data-wide", "1");
    return td;
  }

  // ── status ────────────────────────────────────────────────────────────────
  function accountStatus(a) {
    var t = now(), rl = a.rateLimits || {};
    if (a.enabled === false) return { tone: "muted", glyph: "–", text: "disabled" };
    if (a.expiresInMs <= 0) return { tone: "crit", glyph: "■", text: "token expired" };
    if (a.coolingUntil && a.coolingUntil > t) return { tone: "warn", glyph: "▲", text: "cooling " + dur(a.coolingUntil - t) };
    if (rl.status === "rate_limited") return { tone: "crit", glyph: "■", text: "rate limited" };
    if (!a.healthy) return { tone: "crit", glyph: "■", text: "unhealthy" };
    var cd = a.modelCooldowns || {};
    var fams = Object.keys(cd).filter(function (k) { return cd[k] > t; });
    if (fams.length) return { tone: "warn", glyph: "▲", text: fams.join(", ") + " cooling" };
    return { tone: "good", glyph: "✓", text: "ok" };
  }

  // ── usage windows ─────────────────────────────────────────────────────────
  // A reading is only a reading if there is a usage figure AND a window it
  // belongs to. Three states look like "0%" and are not:
  //  - never measured: the account has served nothing since the router started;
  //  - no figure and no reset time: either upstream never sent this window, or the
  //    router already rolled the window over (the pool zeroes util and clears the
  //    reset time once it passes), so "reported nothing" and "reset, new window not
  //    open yet" arrive here identically and neither is zero use;
  //  - a reset time already in the past: caught between that roll-over and a poll.
  // Drawing any of them as a number would be a confident wrong answer.
  function reading(a, key) {
    var rl = a.rateLimits;
    if (!rl || !rl.lastUpdated) {
      return { ok: false, note: "not measured yet", why: "This account has not served a request since the router started, and usage is read from response headers." };
    }
    var util = rl[key + "Util"] || 0, reset = rl[key + "Reset"] || 0;
    if (reset <= 0 && util <= 0) {
      return { ok: false, note: "no reading", why: "No usage is available for this window: upstream did not report one, or it reset and a new window has not opened yet." };
    }
    if (reset > 0 && reset * 1000 <= now()) {
      return { ok: false, note: "reset since last reading", why: "The window reset after the last response, so usage is unknown until the next request." };
    }
    return { ok: true, util: util, reset: reset };
  }
  function severity(u) { return u >= CRIT ? "crit" : u >= WARN ? "warn" : ""; }
  function sevMark(u) {
    if (u >= 1) return { tone: "crit", glyph: "■", text: "at limit" };
    if (u >= CRIT) return { tone: "crit", glyph: "■", text: "near limit" };
    if (u >= WARN) return { tone: "warn", glyph: "▲", text: "hot" };
    return null;
  }

  function windowCell(a, key, cap) {
    var r = reading(a, key);
    var label = key === "fiveHour" ? "5-hour" : "7-day";
    var cell = el("div", "win");
    var meter = el("div", "meter");
    var fill = el("div", "fill");
    var text = el("div", "wtext");
    meter.appendChild(fill);
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", a.id + " " + label + " usage");
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    if (!r.ok) {
      fill.style.width = "0%";
      meter.className = "meter na";
      meter.setAttribute("aria-valuetext", r.note);
      var why = el("span", "note", r.note);
      why.title = r.why;
      text.appendChild(why);
    } else {
      var pct = Math.round(r.util * 100);
      fill.className = "fill " + severity(r.util);
      fill.style.width = Math.min(100, pct) + "%";
      meter.setAttribute("aria-valuenow", String(pct));
      text.appendChild(el("strong", "pct", pct + "%"));
      var m = sevMark(r.util);
      if (m) {
        var sev = el("span", "dim");
        sev.appendChild(glyph(m.tone, m.glyph));
        sev.appendChild(document.createTextNode(m.text));
        text.appendChild(sev);
      }
      text.appendChild(el("span", "note", r.reset > 0 ? "resets in " + dur(r.reset * 1000 - now()) : "reset time unknown"));
    }
    if (cap > 0 && cap < 100) {
      var tick = el("div", "tick");
      tick.style.left = "calc(" + cap + "% - 1px)";
      tick.title = "routing cap " + cap + "%";
      meter.appendChild(tick);
      text.appendChild(el("span", "note", "cap " + cap + "%"));
    }
    cell.appendChild(meter);
    cell.appendChild(text);
    return cell;
  }

  // ── sections ──────────────────────────────────────────────────────────────
  function tile(label, value, sub) {
    var t = el("div", "tile");
    t.appendChild(el("div", "label", label));
    t.appendChild(el("div", "value", value));
    if (sub) t.appendChild(el("div", "sub", sub));
    return t;
  }

  function renderTiles(h) {
    var rate = h.totalRequests > 0 ? (h.totalErrors / h.totalRequests * 100).toFixed(1) + "% of requests" : "no requests yet";
    $("tiles").replaceChildren(
      tile("Requests", num(h.totalRequests), "since start"),
      tile("Errors", num(h.totalErrors), rate),
      tile("Input tokens", num(h.totalInputTokens), "uncached"),
      tile("Output tokens", num(h.totalOutputTokens), "since start"),
      tile("Cache read tokens", num(h.totalCacheReadTokens), "warm prompt cache"),
      tile("Token refreshes", num(h.totalRefreshes), "OAuth")
    );
  }

  function renderAccounts(h) {
    var rows = h.accounts.map(function (a) {
      var tr = el("tr");
      var rl = a.rateLimits || {};
      var plan = (rl.plan || "").trim();
      var provider = a.provider === "openai_subscription" ? "OpenAI" : "Claude";
      var idCell = el("td", "acct", a.id);
      idCell.appendChild(el("span", "plan", plan ? provider + " · " + plan : provider));
      tr.appendChild(idCell);

      var st = accountStatus(a);
      var stCell = lab(el("td"), "Status");
      stCell.appendChild(glyph(st.tone, st.glyph));
      stCell.appendChild(document.createTextNode(st.text));
      tr.appendChild(stCell);

      var w5 = lab(el("td"), "5-hour window", true); w5.appendChild(windowCell(a, "fiveHour", a.sessionLimitPercent)); tr.appendChild(w5);
      var w7 = lab(el("td"), "7-day window", true); w7.appendChild(windowCell(a, "sevenDay", a.weeklyLimitPercent)); tr.appendChild(w7);
      tr.appendChild(lab(el("td", "num", num(a.requestCount)), "Requests"));
      tr.appendChild(lab(el("td", "num", num(a.errorCount)), "Errors"));
      tr.appendChild(lab(el("td", "dim mono", ago(a.lastUsedMs)), "Last used"));
      tr.appendChild(lab(el("td", "dim mono", a.expiresInMs > 0 ? "expires in " + dur(a.expiresInMs) : "expired"), "Token"));
      return tr;
    });
    $("accbody").replaceChildren.apply($("accbody"), rows);
    // Counted by the same rule as the Status column. The server's own healthy
    // flag stays true through a cooldown (that lives in coolingUntil), so counting
    // it would say "5 of 5" over a row that is visibly resting.
    var okCount = h.accounts.filter(function (a) { return accountStatus(a).tone === "good"; }).length;
    $("accsum").textContent = okCount + " of " + h.accounts.length + " ok";
  }

  function tokensText(l) {
    var parts = [];
    if (l.inputTokens !== undefined) parts.push(num(l.inputTokens) + " in");
    if (l.outputTokens !== undefined) parts.push(num(l.outputTokens) + " out");
    if (l.cacheReadTokens) parts.push(num(l.cacheReadTokens) + " cached");
    return parts.join(" · ");
  }

  function renderLogs(h) {
    var logs = (h.recentLogs || []).slice().sort(function (a, b) { return b.ts - a.ts; });
    var shown = S.showAll ? logs : logs.slice(0, LOG_ROWS);
    var rows = shown.map(function (l) {
      var tr = el("tr");
      tr.appendChild(lab(el("td", "dim mono", new Date(l.ts).toLocaleTimeString("en-GB", { hour12: false })), "Time"));
      tr.appendChild(lab(el("td", "", l.accountId), "Account"));
      var kind = l.type === "error" ? { tone: "crit", glyph: "■", text: "error" }
        : l.type === "refresh" ? { tone: "muted", glyph: "↻", text: "refresh" }
        : { tone: "good", glyph: "→", text: "route" };
      var kc = lab(el("td"), "Event"); kc.appendChild(glyph(kind.tone, kind.glyph)); kc.appendChild(document.createTextNode(kind.text));
      tr.appendChild(kc);
      tr.appendChild(lab(el("td", "dim", l.model && l.model !== "-" ? l.model : ""), "Model"));
      var d = lab(el("td", "clip", l.details || ""), "Details", true);
      d.title = (l.details || "") + (l.sessionId ? "  [session " + l.sessionId.slice(0, 8) + "]" : "");
      tr.appendChild(d);
      tr.appendChild(lab(el("td", "dim mono", tokensText(l)), "Tokens", true));
      return tr;
    });
    $("logbody").replaceChildren.apply($("logbody"), rows);
    $("logsum").textContent = logs.length ? "newest first" : "nothing yet";
    var more = $("more");
    if (logs.length > LOG_ROWS) {
      more.hidden = false;
      more.textContent = S.showAll ? "Show fewer" : "Show all " + logs.length;
    } else {
      more.hidden = true;
    }
  }

  function renderHeader(h) {
    var ok = h.status === "ok";
    var meta = $("meta");
    meta.replaceChildren(
      glyph(ok ? "good" : "crit", ok ? "✓" : "■"),
      document.createTextNode((ok ? "ok" : "degraded — no healthy account") + " · " + h.mode + " → " + h.target + " · up " + dur(h.uptime * 1000))
    );
  }

  // A drag-selection is wiped by a table rebuild, so while one exists the tables
  // wait for the next poll. Header, tiles and the banner still update.
  function selecting() {
    var s = window.getSelection && window.getSelection();
    return !!(s && !s.isCollapsed && String(s));
  }

  function render() {
    var h = S.data;
    if (!h) return;
    renderHeader(h);
    renderTiles(h);
    if (!selecting() || !S.rendered) {
      renderAccounts(h);
      renderLogs(h);
      S.rendered = true;
    }
    $("main").setAttribute("aria-busy", "false");
  }

  function tickUpdated() {
    var u = $("updated");
    u.textContent = S.okAt ? "updated " + dur(Date.now() - S.okAt) + " ago" : "";
  }

  function setBanner(msg) {
    var b = $("banner");
    S.failing = !!msg;
    if (msg) {
      b.hidden = false;
      b.textContent = msg + (S.okAt ? " Showing data from " + dur(Date.now() - S.okAt) + " ago." : "");
    } else {
      b.hidden = true;
    }
    $("main").className = msg && S.okAt ? "stale" : "";
  }

  // ── polling ───────────────────────────────────────────────────────────────
  function schedule() {
    clearTimeout(S.timer);
    if (!document.hidden) S.timer = setTimeout(poll, POLL_MS);
  }

  function poll() {
    if (S.inflight) return;
    S.inflight = true;
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 4000);
    fetch("/cc-router/health", { cache: "no-store", signal: ctrl.signal })
      .then(function (res) {
        if (!res.ok) throw new Error("the router answered HTTP " + res.status);
        // The server's own clock, so countdowns do not drift with this machine's.
        var d = Date.parse(res.headers.get("date") || "");
        if (!isNaN(d)) S.skew = d - Date.now();
        return res.json();
      })
      .then(function (data) {
        S.data = data;
        S.okAt = Date.now();
        setBanner(null);
        try { render(); }
        catch (err) { setBanner("The page could not draw the data (" + err.message + ")."); }
      }, function (err) {
        setBanner("Can't reach the router (" + err.message + ").");
      })
      .then(function () {
        clearTimeout(to);
        S.inflight = false;
        schedule();
      });
  }

  $("more").addEventListener("click", function () {
    S.showAll = !S.showAll;
    if (S.data) renderLogs(S.data);
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
  setInterval(tickUpdated, 1000);
  poll();
})();
`;

const sha256 = (s: string): string => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

/**
 * Only these two inline blocks may run or style anything, and nothing may be
 * fetched except the router's own health JSON. `img-src data:` is for the empty
 * favicon, which stops the browser asking the proxy for /favicon.ico.
 */
export const DASHBOARD_CSP = [
  "default-src 'none'",
  `script-src ${sha256(SCRIPT)}`,
  `style-src ${sha256(STYLE)}`,
  "connect-src 'self'",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const DASHBOARD_SCRIPT = SCRIPT;
export const DASHBOARD_STYLE = STYLE;

export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>CC-Router · usage</title>
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>${BODY}<script>${SCRIPT}</script>
</body>
</html>
`;
}

/**
 * Mount the page. Call this BEFORE the proxy-secret middleware: a browser
 * navigation cannot carry an Authorization header, and the page holds no data —
 * what it shows comes from `/cc-router/health`, which is already exempt from the
 * secret for monitoring. Mounting it later would not protect anything that health
 * does not already expose; it would only make the page unusable.
 */
export function mountWebDashboard(app: Express): void {
  const html = renderDashboardHtml();
  app.get(DASHBOARD_PATH, (_req: Request, res: Response) => {
    res.set({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": DASHBOARD_CSP,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    });
    res.send(html);
  });
  app.get("/cc-router", (_req: Request, res: Response) => {
    res.redirect(302, DASHBOARD_PATH);
  });
}
