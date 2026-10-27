import { createHash } from "node:crypto";
import type { Express, Request, Response } from "express";

/**
 * A read-only usage page for the router, served from the router itself.
 *
 * It is one static document that polls `/cc-router/health` — the same JSON the
 * terminal dashboard reads, including the last hour's latency and error figures
 * (perf-window.ts) — and, once a minute, `/cc-router/usage-history` and
 * `/cc-router/usage-series`, the token history the router keeps (see
 * usage-history.ts) as a summary and as a time series by model. Those two are
 * endpoints of their own, so what they return is held to the same rule as
 * health: readable without the proxy secret, which is why they carry aggregates
 * only.
 * Everything is inlined (no build step reaches non-TS files, and nothing is
 * fetched from a CDN), and the CSP pins that: the only script and style allowed
 * are these two exact blocks, by hash.
 *
 * Upstream error text lands in the activity log, so it is attacker-influenced.
 * The client therefore builds every node with `textContent` and never parses
 * markup; the CSP is the second line, not the first.
 */

export const DASHBOARD_PATH = "/cc-router/dashboard";
/** The page's script hard-codes this string; a test keeps the two in step. */
export const USAGE_HISTORY_PATH = "/cc-router/usage-history";
/** The activity chart's time series; hard-coded in the script the same way. */
export const USAGE_SERIES_PATH = "/cc-router/usage-series";

const STYLE = String.raw`
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
--hair:rgba(11,11,11,.10);--accent:#2a78d6;--track:#cde2fb;--good:#006300;--warn:#fab219;--warn-ink:#946a00;--crit:#d03b3b}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;
--hair:rgba(255,255,255,.10);--accent:#3987e5;--track:#0d366b;--good:#0ca30c;--warn-ink:#fab219}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline;justify-content:space-between}
h1{margin:0;font-size:20px;font-weight:600}
h2{margin:0;font-size:14px;font-weight:600}
.meta,.sum,.note,.foot,.sub{color:var(--ink2)}
.meta{margin:2px 0 0;font-size:13px}
.updated{font-size:12px;color:var(--ink2)}
.banner{margin-top:16px;padding:10px 12px;border:1px solid var(--crit);border-radius:6px;background:var(--surface);font-size:13px}
.strip{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline;margin-top:16px;padding:10px 14px;border:1px solid var(--hair);border-radius:8px;background:var(--surface)}
.strip .glyph{font-weight:700}
.strip .verdict{font-weight:600}
.strip .reasons{color:var(--ink2)}
.strip[data-level="watch"]{border-color:var(--warn)}
.strip[data-level="problem"]{border-color:var(--crit);background:var(--surface);background:color-mix(in srgb,var(--crit) 7%,var(--surface))}
.strip[data-level="problem"] .reasons{color:var(--ink)}
.since{margin:12px 0 0;font-size:12px;color:var(--ink2)}
.card{background:var(--surface);border:1px solid var(--hair);border-radius:8px}
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
.g-good{color:var(--good)}.g-warn{color:var(--warn-ink)}.g-crit{color:var(--crit)}.g-muted{color:var(--muted)}
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
@media (forced-colors:active){.strip[data-level="problem"]{border:2px solid CanvasText}.strip[data-level="watch"]{border:2px dashed CanvasText}.meter{background:Canvas;border:1px solid CanvasText}.fill{background:Highlight}.tick{background:CanvasText}}
:root{--h0:rgba(11,11,11,.07);--h1:#b6d4f7;--h2:#78b0ec;--h3:#2a78d6;--h4:#14498f;--cell:22px;--gap:4px}
@media (prefers-color-scheme:dark){:root{--h0:rgba(255,255,255,.08);--h1:#0d366b;--h2:#1b5aa8;--h3:#3987e5;--h4:#9cc8f7}}
.usehead{margin-top:24px;margin-bottom:0}
#usestate{margin-top:8px;padding:8px 12px;border:1px solid var(--warn);border-radius:6px;background:var(--surface);font-size:13px}
.hmbody{display:flex;flex-wrap:wrap;gap:16px 32px;align-items:flex-start}
.hmmain{flex:0 1 auto;min-width:0;max-width:100%}
/* Only the squares scroll. The weekday labels stay put at the left edge and the note and legend stay outside. */
.hmscroll{max-width:100%;overflow-x:auto;padding-bottom:2px}
.hm{display:grid;grid-template-columns:auto auto;gap:6px 8px;align-items:start}
.hmmonths,.hmcols{display:grid;grid-auto-flow:column;grid-auto-columns:var(--cell);gap:var(--gap)}
.hmmonths{grid-template-rows:14px}
.hmcols{grid-template-rows:repeat(7,var(--cell))}
.hmdays{position:sticky;left:0;z-index:1;background:var(--surface);display:grid;grid-template-rows:repeat(7,var(--cell));gap:var(--gap);font-size:11px;color:var(--ink2);text-align:right}
.hmdays div{align-self:center}
.hmm{font-size:11px;color:var(--ink2);white-space:nowrap;align-self:end}
.hx{width:var(--cell);height:var(--cell);border-radius:3px;background:var(--h0)}
.hx.hp{visibility:hidden}
.hx.hn{background:transparent;border:1px dashed var(--muted)}
.hx.h1{background:var(--h1)}.hx.h2{background:var(--h2)}.hx.h3{background:var(--h3)}.hx.h4{background:var(--h4)}
.hx.sel{outline:2px solid var(--ink);outline-offset:1px}
.hmfoot{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;margin-top:10px;font-size:12px}
.legend{display:inline-flex;align-items:center;gap:4px;color:var(--ink2)}
.legend .hx{display:inline-block;width:14px;height:14px}
.hmside{flex:1 1 220px;min-width:200px}
dl.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0}
dl.kv dt{color:var(--ink2)}
dl.kv dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.usegrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-top:16px;align-items:start}
.usegrid .card{margin-top:0}
.mlist{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.mrow{display:grid;grid-template-columns:minmax(0,1fr) 120px 9em;gap:4px 12px;align-items:center}
.mname{min-width:0}
.mval{font-size:12px;color:var(--ink2);text-align:right;white-space:nowrap}
.subhead{margin:16px 0 8px;font-size:12px;font-weight:600;color:var(--ink2)}
@media (max-width:720px){
:root{--cell:18px;--gap:3px}
.mrow{grid-template-columns:minmax(0,1fr) auto}
.mrow .meter{grid-column:1 / -1;order:3}
}
/* Activity chart: explicit model colours with indexed textures for additional models. Validated for colour-vision deficiency in both schemes. */
:root{--s0:#2a78d6;--s1:#eb6834;--s2:#1baf7a;--s3:#eda100;--s4:#e87ba4;--s5:#008300;--s6:#6250d6;--s7:#e34948;--so:#c3c2bc;--sel:rgba(11,11,11,.06)}
@media (prefers-color-scheme:dark){:root{--s0:#3987e5;--s1:#d95926;--s2:#199e70;--s3:#c98500;--s4:#d55181;--s5:#008300;--s6:#9085e9;--s7:#e66767;--so:#55544f;--sel:rgba(255,255,255,.07)}}
::selection{background:color-mix(in srgb,var(--accent) 28%,transparent)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px 24px;margin:4px 0 0}
.kpi{min-width:0}
.kpi dt{font-size:12px;color:var(--ink2)}
.kpi dd{margin:2px 0 0;font-size:18px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums}
.kpi dd.na{font-size:14px;font-weight:400;color:var(--ink2)}
.kpi dd.sub{margin-top:0;font-size:12px;font-weight:400;line-height:1.45;color:var(--ink2)}
.lh{display:block;white-space:nowrap;font-variant-numeric:tabular-nums}
.lh+.lh{font-size:12px;color:var(--ink2)}
.subtable{margin-top:16px}
.controls{display:flex;flex-wrap:wrap;gap:8px}
.seg{display:inline-flex;border:1px solid var(--hair);border-radius:6px;overflow:hidden}
.seg button{border:0;border-radius:0;padding:3px 10px;font-size:12px;color:var(--ink2)}
.seg button+button{border-left:1px solid var(--hair)}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--surface)}
.seg button:focus-visible{outline-offset:-2px}
.totline{margin:0 0 12px;font-size:13px;color:var(--ink2);font-variant-numeric:tabular-nums}
.totline strong{color:var(--ink);font-weight:600}
.actbody{display:grid;grid-template-columns:minmax(0,1fr) 248px;gap:16px 28px;align-items:start}
.chartbox{min-width:0;overflow-x:auto}
.chart{display:block;touch-action:pan-x}
.chart:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.chart text{font-size:11px;fill:var(--ink2);font-variant-numeric:tabular-nums}
.chart .grid{stroke:var(--hair);stroke-width:1}
.chart .base{stroke:var(--muted);stroke-width:1}
.chart .selcol{fill:var(--sel)}
.chart .s0,.sw .s0{fill:var(--s0)}.chart .s1,.sw .s1{fill:var(--s1)}.chart .s2,.sw .s2{fill:var(--s2)}.chart .s3,.sw .s3{fill:var(--s3)}
.chart .so:not([fill]),.sw .so:not([fill]){fill:var(--so)}
.chart .s4,.sw .s4{fill:var(--s4)}.chart .s5,.sw .s5{fill:var(--s5)}.chart .s6,.sw .s6{fill:var(--s6)}.chart .s7,.sw .s7{fill:var(--s7)}
.texture-line{stroke:var(--surface)}
.model-name{overflow-wrap:anywhere;min-width:0}
.chart .partial{opacity:1}
.chart .nodata{fill:var(--hair)}
.lgd{gap:8px}
.lrow{display:grid;grid-template-columns:12px minmax(0,1fr) auto;gap:4px 8px;align-items:baseline;font-size:13px}
.lval{font-size:12px;color:var(--ink2);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--so)}
.sw.s0{background:var(--s0)}.sw.s1{background:var(--s1)}.sw.s2{background:var(--s2)}.sw.s3{background:var(--s3)}
.actfoot{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;margin-top:10px;font-size:12px}
.tablewrap{max-height:320px;overflow:auto;margin-top:12px;border-top:1px solid var(--hair)}
.tablewrap th{position:sticky;top:0;background:var(--surface);padding-top:8px}
.filters{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;margin:0 0 10px;font-size:12px;color:var(--ink2)}
.filters label{display:inline-flex;gap:6px;align-items:center}
select{font:inherit;font-size:12px;color:var(--ink);background:var(--surface);border:1px solid var(--hair);border-radius:6px;padding:3px 6px;max-width:220px}
select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
input[type="checkbox"]{accent-color:var(--accent);margin:0}
tr.row{cursor:pointer}
tr.row:hover td{background:var(--sel)}
tr.row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
tr.open .clip{max-width:none;white-space:normal;overflow:visible;overflow-wrap:anywhere}
.logs td{padding-top:8px;padding-bottom:8px}
.logs .nw{white-space:nowrap}
.logs td.clip{min-width:200px;max-width:320px}
@media (max-width:720px){
.actbody{grid-template-columns:1fr}
/* Stacked rows: two columns that may shrink, so one unbreakable figure cannot widen the page. */
tr{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
td.mono,.logs .nw,.lh{white-space:normal}
.logs td.clip{min-width:0;max-width:none}
}
@media (forced-colors:active){.chart,.sw{forced-color-adjust:none}.seg button[aria-pressed="true"]{border:2px solid Highlight}}
@media (forced-colors:active){
.hx{forced-color-adjust:none;border:1px solid CanvasText}
.hx.h0{background:Canvas}
.hx.h1{background:Highlight;opacity:.35}.hx.h2{background:Highlight;opacity:.6}.hx.h3{background:Highlight;opacity:.8}.hx.h4{background:Highlight}
.hx.hn{background:Canvas;border-style:dashed}
.hx.hp{border:0}
.hx.sel{outline-color:Highlight}
}
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
  <section id="strip" class="strip" data-level="unknown" aria-label="Pool status" hidden>
    <span id="stripglyph" class="glyph" aria-hidden="true"></span>
    <span id="stripverdict" class="verdict" role="status"></span>
    <span id="stripreasons" class="reasons"></span>
  </section>
  <noscript><p class="banner">This page reads live data and needs JavaScript.</p></noscript>
  <main id="main" aria-busy="true">
    <section class="card" aria-labelledby="acc-h">
      <div class="cardhead"><h2 id="acc-h">Accounts</h2><span id="accsum" class="sum"></span></div>
      <div class="scroll">
        <table>
          <thead><tr>
            <th scope="col">Account</th><th scope="col">Status</th>
            <th scope="col">5-hour window</th><th scope="col">7-day window</th>
            <th scope="col" class="num">Requests</th><th scope="col" class="num">Errors</th>
            <th scope="col">Last hour</th><th scope="col">Last used</th><th scope="col">Token</th>
          </tr></thead>
          <tbody id="accbody"></tbody>
        </table>
      </div>
    </section>
    <p id="since" class="since"></p>
    <section class="card" aria-labelledby="perf-h">
      <div class="cardhead"><h2 id="perf-h">Last hour</h2><span id="perfsum" class="sum"></span></div>
      <dl id="kpis" class="kpis"></dl>
      <div class="scroll subtable">
        <table>
          <thead><tr>
            <th scope="col">Model</th><th scope="col" class="num">Requests</th><th scope="col" class="num">Errors</th>
            <th scope="col" class="num">Finish p50</th><th scope="col" class="num">Finish p95</th><th scope="col" class="num">Output speed</th>
          </tr></thead>
          <tbody id="perfbody"></tbody>
        </table>
      </div>
    </section>
    <section id="usage" aria-labelledby="use-h">
      <div class="cardhead usehead"><h2 id="use-h">Token usage</h2><span id="usesum" class="sum"></span></div>
      <div id="usestate" role="status" hidden></div>
      <section class="card" aria-labelledby="act-h">
        <div class="cardhead">
          <h2 id="act-h">Activity</h2>
          <div class="controls">
            <div class="seg" role="group" aria-label="Range">
              <button id="r-24h" type="button">24h</button><button id="r-7d" type="button">7d</button><button id="r-30d" type="button">30d</button>
            </div>
            <div class="seg" role="group" aria-label="Measure">
              <button id="m-requests" type="button">Requests</button><button id="m-output" type="button">Output tokens</button><button id="m-total" type="button">All tokens</button>
            </div>
          </div>
        </div>
        <p id="acttot" class="totline"></p>
        <div id="actstate" class="note" role="status" hidden></div>
        <div class="actbody">
          <div id="chartbox" class="chartbox"></div>
          <ul id="actlegend" class="mlist lgd" aria-label="Models, totals for this range"></ul>
        </div>
        <div class="actfoot">
          <span id="actinfo" class="note" aria-live="polite">Hover, tap or use the arrow keys on the chart to read an hour.</span>
          <button id="acttable" type="button" aria-controls="acttablewrap" aria-expanded="false">Show as table</button>
        </div>
        <div id="acttablewrap" class="tablewrap" hidden>
          <table><thead><tr id="acthead"></tr></thead><tbody id="actrows"></tbody></table>
        </div>
      </section>
      <section class="card" aria-labelledby="hm-h">
        <div class="cardhead"><h2 id="hm-h">Daily tokens</h2><span id="hmsum" class="sum"></span></div>
        <div class="hmbody">
          <div class="hmmain">
            <div id="hmscroll" class="hmscroll">
              <div class="hm">
                <div></div>
                <div id="hmmonths" class="hmmonths" aria-hidden="true"></div>
                <div id="hmdays" class="hmdays" aria-hidden="true"></div>
                <div id="hmgrid" class="hmcols" role="group" aria-label="Daily token usage, one square per day, oldest first"></div>
              </div>
            </div>
            <div class="hmfoot">
              <span id="hminfo" class="note" aria-live="polite">Hover or tap a day for its breakdown.</span>
              <span class="legend" aria-hidden="true"><i class="hx hn"></i> no data <i class="hx h0"></i> none &nbsp; Less <i class="hx h1"></i><i class="hx h2"></i><i class="hx h3"></i><i class="hx h4"></i> More</span>
            </div>
          </div>
          <dl id="hmfacts" class="kv hmside"></dl>
        </div>
      </section>
      <div class="usegrid">
        <section class="card" aria-labelledby="mod-h">
          <div class="cardhead"><h2 id="mod-h">Models</h2><span class="sum">last 30 days, by tokens</span></div>
          <ul id="mlist" class="mlist"></ul>
        </section>
        <section class="card" aria-labelledby="det-h">
          <div class="cardhead"><h2 id="det-h">Details</h2><span class="sum">last 30 days</span></div>
          <dl id="detlist" class="kv"></dl>
          <h3 class="subhead">Token mix</h3>
          <ul id="mixlist" class="mlist"></ul>
        </section>
      </div>
      <p class="foot">History is kept by the router from the first run of this version; usage before that was never recorded. Counts cover responses the router could read usage from. Models are as requested. OpenAI rows recorded since 27 Oct 2026 split cached input out; earlier OpenAI rows count it inside input. Because the two cannot be told apart, the cache ratio covers Claude accounts only.</p>
    </section>
    <section class="card" aria-labelledby="log-h">
      <div class="cardhead"><h2 id="log-h">Recent activity</h2><span id="logsum" class="sum"></span></div>
      <div class="filters">
        <label>Account <select id="faccount"></select></label>
        <label>Model <select id="fmodel"></select></label>
        <label><input id="ferr" type="checkbox"> Errors only</label>
        <label><input id="fslow" type="checkbox"> Slower than p95</label>
      </div>
      <div class="scroll">
        <table class="logs">
          <thead><tr>
            <th scope="col">Time</th><th scope="col">Account</th><th scope="col">Event</th>
            <th scope="col">Model</th><th scope="col" class="num">Status</th><th scope="col" class="num">Duration</th>
            <th scope="col" class="num">Speed</th><th scope="col">Tokens</th><th scope="col" class="num">Cache</th>
            <th scope="col">Session</th><th scope="col">Details</th>
          </tr></thead>
          <tbody id="logbody"></tbody>
        </table>
      </div>
      <button id="more" class="more" type="button" hidden></button>
    </section>
  </main>
  <p class="foot">Read-only. Refreshes every few seconds from <code>/cc-router/health</code>, and token history every minute from <code>/cc-router/usage-history</code> and <code>/cc-router/usage-series</code>. Last-hour figures are kept in memory and start over when the router restarts. Finish times run from the request to the end of the response, and output speed divides output tokens by that, so it includes the wait for the first token. Usage is read from upstream response headers, so a window shows no reading until that account has served a request since the router started. This page and both of those endpoints are not behind the proxy secret.</p>
</div>
`;

// Plain strings and concatenation only: this sits inside a template literal, so
// no backticks and no `${`. DOM is built with textContent — never innerHTML.
const SCRIPT = String.raw`
(function () {
  "use strict";
  var POLL_MS = 3000, LOG_ROWS = 20;
  var S = { skew: 0, okAt: 0, data: null, sev: null, verdictText: "", showAll: false, timer: 0, inflight: false, failing: false };
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
  // A response time: milliseconds under a second, then seconds to one place.
  function secs(ms) {
    if (!isNum(ms) || ms < 0) return "";
    if (ms < 1000) return Math.round(ms) + " ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + " s";
    return dur(ms);
  }
  // An error rate keeps one decimal below 10%, where the difference matters.
  function rate(x) { return x < 0.1 && x > 0 ? (x * 100).toFixed(1) + "%" : Math.round(x * 100) + "%"; }
  // SVG nodes take their class through setAttribute: className on one is an
  // SVGAnimatedString, which a plain assignment silently leaves untouched.
  var SVG_NS = "http://www.w3.org/2000/svg";
  function svg(tag, cls, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    if (cls) n.setAttribute("class", cls);
    if (attrs) for (var k in attrs) n.setAttribute(k, String(attrs[k]));
    return n;
  }
  function glyph(tone, ch) { return el("span", "glyph g-" + tone, ch); }
  // On a phone each row stacks into a card and the header row is hidden, so every
  // cell carries its own label (drawn from data-label by CSS) and the wide ones span.
  function lab(td, label, wide) {
    td.setAttribute("data-label", label);
    if (wide) td.setAttribute("data-wide", "1");
    return td;
  }

  // ── the verdict ───────────────────────────────────────────────────────────
  // Decided by the router (severity.ts) and only drawn here, never re-derived:
  // the terminal dashboard reads the same field, so the two cannot disagree about
  // the same pool, and the cut-offs live in one place.
  var RUNGS = { ok: 1, watch: 1, problem: 1, off: 1 };
  var TONE = { ok: "good", watch: "warn", problem: "crit", off: "muted" };
  var MARK = { ok: "✓", watch: "▲", problem: "■", off: "–" };
  var STATE_TEXT = { off: "disabled", expired: "token expired", limited: "rate limited", unhealthy: "unhealthy", hot: "hot", ok: "ok" };

  function isNum(n) { return typeof n === "number" && isFinite(n); }
  function validSeverity(v) {
    if (!v || typeof v !== "object") return false;
    if (v.pool !== "ok" && v.pool !== "watch" && v.pool !== "problem") return false;
    if (typeof v.headline !== "string" || !Array.isArray(v.reasons) || !Array.isArray(v.accounts)) return false;
    if (!v.thresholds || !isNum(v.thresholds.watch) || !isNum(v.thresholds.problem)) return false;
    for (var i = 0; i < v.reasons.length; i++) if (typeof v.reasons[i] !== "string") return false;
    for (var j = 0; j < v.accounts.length; j++) {
      var a = v.accounts[j];
      if (!a || typeof a.id !== "string" || typeof a.state !== "string" || !Object.prototype.hasOwnProperty.call(RUNGS, a.rung)) return false;
      if ((a.until !== undefined && !isNum(a.until)) || (a.util !== undefined && !isNum(a.util)) || (a.age !== undefined && !isNum(a.age))) return false;
    }
    return true;
  }
  function accountSeverity(a) {
    var list = S.sev ? S.sev.accounts : [];
    for (var i = 0; i < list.length; i++) if (list[i].id === a.id) return list[i];
    return null;
  }
  function accountStatus(a) {
    var s = accountSeverity(a);
    if (!s) return { tone: "muted", glyph: "?", text: "no verdict" };
    var text = STATE_TEXT[s.state] || s.state;
    if (s.state === "cooling") text = (s.scope ? s.scope + " " : "") + "cooling" + (isNum(s.until) ? " " + dur(s.until - now()) : "");
    else if (s.state === "near") text = (s.util || 0) >= 1 ? "at limit" : "near limit";
    return { tone: TONE[s.rung], glyph: MARK[s.rung], text: text };
  }

  // The strip answers "is anything wrong right now?" before anything else on the page.
  function renderStrip() {
    var v = S.sev;
    var box = $("strip");
    box.hidden = false;
    box.setAttribute("data-level", v ? v.pool : "unknown");
    var mark = $("stripglyph");
    mark.className = "glyph g-" + (v ? TONE[v.pool] : "muted");
    mark.textContent = v ? MARK[v.pool] : "?";
    var head = v ? v.headline : "Status unknown";
    // The verdict is a live region: write it only when it changes, or every poll is read aloud.
    if (S.verdictText !== head) { $("stripverdict").textContent = head; S.verdictText = head; }
    $("stripreasons").textContent = v ? (v.reasons.join(" · ")) : "The router sent no status verdict.";
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
    // Upstream names a window only for accounts that have one; an account whose responses never
    // mention a 7-day window (a Teams seat has the 5-hour limit alone) has nothing to read there.
    if (key === "sevenDay" && reset <= 0 && util <= 0 && a.weeklyWindow === "not-reported") {
      return { ok: false, note: "no 7d window reported", why: "Upstream has not named a 7-day window in this account's recent responses, so its plan may have no weekly limit. This says what was reported, not what the plan is." };
    }
    if (reset <= 0 && util <= 0) {
      return { ok: false, note: "no reading", why: "No usage is available for this window: upstream did not report one, or it reset and a new window has not opened yet." };
    }
    if (reset > 0 && reset * 1000 <= now()) {
      return { ok: false, note: "reset since last reading", why: "The window reset after the last response, so usage is unknown until the next request." };
    }
    return { ok: true, util: util, reset: reset };
  }
  // The cut-offs come with the verdict, so a meter turns colour where the strip says it should.
  function severity(u) {
    var t = S.sev && S.sev.thresholds;
    if (!t) return "";
    return u >= t.problem ? "crit" : u >= t.watch ? "warn" : "";
  }
  function sevMark(u) {
    var t = S.sev && S.sev.thresholds;
    if (!t || u < t.watch) return null;
    if (u >= 1) return { tone: "crit", glyph: "■", text: "at limit" };
    if (u >= t.problem) return { tone: "crit", glyph: "■", text: "near limit" };
    return { tone: "warn", glyph: "▲", text: "hot" };
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
      // The figure behind a warning can be days old on an idle account; say so beside it.
      var sv = accountSeverity(a);
      if (sv && sv.age && sv.window === (key === "fiveHour" ? "5h" : "7d")) text.appendChild(el("span", "note", "read " + dur(sv.age) + " ago"));
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
  // What the counters since start used to be six tiles for. They reset on every restart,
  // unlike the history below, so they are context for the accounts, not a headline.
  function renderSince(h) {
    var rate = h.totalRequests > 0 ? " (" + (h.totalErrors / h.totalRequests * 100).toFixed(1) + "%)" : "";
    $("since").textContent = "Since the router started: " + num(h.totalRequests) + " requests · " + num(h.totalErrors) + " errors" + rate
      + " · input " + num(h.totalInputTokens) + " · output " + num(h.totalOutputTokens) + " · cache read " + num(h.totalCacheReadTokens)
      + " · " + num(h.totalRefreshes) + (h.totalRefreshes === 1 ? " token refresh" : " token refreshes");
  }

  function renderAccounts(h) {
    var rows = h.accounts.map(function (a) {
      var tr = el("tr");
      var rl = a.rateLimits || {};
      var plan = (rl.plan || "").trim();
      var provider = a.provider === "openai_subscription" ? "Codex" : "Claude";
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
      tr.appendChild(lastHourCell(a.id));
      tr.appendChild(lab(el("td", "dim mono", ago(a.lastUsedMs)), "Last used"));
      tr.appendChild(lab(el("td", "dim mono", a.expiresInMs > 0 ? "expires in " + dur(a.expiresInMs) : "expired"), "Token"));
      return tr;
    });
    if (h.ollamaFallback && h.ollamaFallback.enabled) rows.push(ollamaAccountRow(h.ollamaFallback));
    $("accbody").replaceChildren.apply($("accbody"), rows);
    // Counted by the same rule as the Status column. The server's own healthy
    // flag stays true through a cooldown (that lives in coolingUntil), so counting
    // it would say "5 of 5" over a row that is visibly resting.
    var okCount = h.accounts.filter(function (a) { return accountStatus(a).tone === "good"; }).length;
    $("accsum").textContent = okCount + " of " + h.accounts.length
      + (h.ollamaFallback && h.ollamaFallback.enabled ? " subscription accounts ok" : " ok");
  }

  function ollamaAccountRow(a) {
    var tr = el("tr");
    var idCell = el("td", "acct", "Ollama Cloud");
    idCell.appendChild(el("span", "plan", a.model || "fallback"));
    tr.appendChild(idCell);
    var q = a.quota, b = q && q.balance;
    var reset = q && isNum(q.resetsAt) && q.resetsAt <= now();
    var known = q && q.status === "known" && b && isNum(b.includedUsd) && isNum(b.allowanceUsd) && isNum(b.purchasedUsd) && !reset;
    var exhausted = known && Math.max(0, b.includedUsd) + Math.max(0, b.purchasedUsd) <= 0;
    var state = exhausted ? "credits exhausted" : a.serving ? "serving" : a.ready ? "ready" : a.inactiveReason === "no-api-key" ? "needs API key" : "inactive";
    var stCell = lab(el("td"), "Status");
    stCell.appendChild(glyph(exhausted ? "crit" : a.ready ? "good" : "warn", exhausted ? "■" : a.ready ? "✓" : "▲"));
    stCell.appendChild(document.createTextNode(state));
    tr.appendChild(stCell);

    var quotaCell = lab(el("td"), "Monthly credits", true);
    quotaCell.setAttribute("colspan", "2");
    var box = el("div", "win"), meter = el("div", "meter"), fill = el("div", "fill"), text = el("div", "wtext");
    meter.appendChild(fill);
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", "Ollama Cloud monthly credit usage");
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    if (known) {
      text.appendChild(el("strong", "pct", "$" + b.includedUsd.toFixed(2) + " / $" + b.allowanceUsd.toFixed(2) + " remaining"));
      if (b.allowanceUsd > 0) {
        var util = (b.allowanceUsd - b.includedUsd) / b.allowanceUsd;
        var pct = Math.round(util * 100);
        fill.className = "fill " + severity(util);
        fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
        meter.setAttribute("aria-valuenow", String(Math.max(0, Math.min(100, pct))));
        meter.setAttribute("aria-valuetext", pct + "% of monthly credits used");
        text.appendChild(el("span", "note", "monthly credits · " + pct + "% used"));
      } else {
        meter.className = "meter na";
        meter.setAttribute("aria-valuetext", "No monthly allowance reported");
      }
      text.appendChild(el("span", "note", "prepaid remaining $" + b.purchasedUsd.toFixed(2)));
      text.appendChild(el("span", "note", q.resetsAt > 0 ? "renews in " + dur(q.resetsAt - now()) : "renewal time unknown"));
    } else {
      meter.className = "meter na";
      var unavailable = reset ? "quota reset; refresh pending" : "quota unavailable";
      meter.setAttribute("aria-valuetext", unavailable);
      text.appendChild(el("span", "note", unavailable));
      if (q && q.reason) text.appendChild(el("span", "note", q.reason));
    }
    if (q && q.checkedAt) text.appendChild(el("span", "note", "checked " + ago(q.checkedAt)));
    if (q && q.source) {
      var source = el("span", "note", "Ollama balance API");
      source.title = q.source;
      text.appendChild(source);
    }
    box.appendChild(meter); box.appendChild(text); quotaCell.appendChild(box); tr.appendChild(quotaCell);
    tr.appendChild(lab(el("td", "num", num(a.requests)), "Requests"));
    tr.appendChild(lab(el("td", "num", num(a.errors)), "Errors"));
    tr.appendChild(lastHourCell("ollama"));
    tr.appendChild(lab(el("td", "dim mono", ago(a.lastServedAt)), "Last used"));
    tr.appendChild(lab(el("td", "dim mono", a.keyRequired ? (a.keyPresent ? "API key set" : "API key missing") : "local endpoint"), "Authentication"));
    return tr;
  }

  // ── the last hour ─────────────────────────────────────────────────────────
  // Kept by the router in memory (perf-window.ts) and only drawn here. Null
  // figures are "no reading", never zero: a restart starts the hour empty.
  function validStat(x) {
    if (!x || typeof x !== "object" || !isNum(x.requests) || !isNum(x.errors) || !isNum(x.rateLimited) || !isNum(x.completed)) return false;
    var nullable = ["errorRate", "p50Ms", "p95Ms", "outputTokensPerSecond"];
    for (var i = 0; i < nullable.length; i++) if (x[nullable[i]] !== null && !isNum(x[nullable[i]])) return false;
    return true;
  }
  function validPerf(p) {
    if (!p || typeof p !== "object" || !isNum(p.windowMs) || !isNum(p.observedMs) || !validStat(p.pool)) return false;
    if (!p.accounts || typeof p.accounts !== "object" || !p.models || typeof p.models !== "object") return false;
    for (var a in p.accounts) if (!validStat(p.accounts[a])) return false;
    for (var m in p.models) if (!validStat(p.models[m])) return false;
    return true;
  }
  function perfOf(group, id) {
    var p = S.perf;
    return p && Object.prototype.hasOwnProperty.call(p[group], id) ? p[group][id] : null;
  }

  // A few errors an hour are normal background on a busy pool; marking every
  // one would make a healthy pool look like a failing one. One in twenty is not.
  var ERR_LOUD = 0.05;
  function errMark(x) {
    if (!x.errorRate || x.errorRate < ERR_LOUD) return null;
    return x.errors === x.rateLimited ? { tone: "warn", glyph: "▲" } : { tone: "crit", glyph: "■" };
  }

  function lastHourCell(id) {
    var td = lab(el("td"), "Last hour");
    var x = perfOf("accounts", id);
    if (!S.perf) { td.appendChild(el("span", "note", "no reading")); return td; }
    if (!x || x.requests === 0) { td.appendChild(el("span", "note", "no requests")); return td; }
    td.appendChild(el("span", "lh", num(x.requests) + " req · " + (x.p50Ms === null ? "p50 –" : "p50 " + secs(x.p50Ms))));
    var errLine = el("span", "lh");
    var m = errMark(x);
    if (m) errLine.appendChild(glyph(m.tone, m.glyph));
    errLine.appendChild(document.createTextNode(rate(x.errorRate || 0) + " errors" + (x.rateLimited > 0 ? " · " + num(x.rateLimited) + "× 429" : "")));
    td.appendChild(errLine);
    td.title = num(x.errors) + " errors (" + num(x.rateLimited) + " of them 429) in " + num(x.requests) + " requests over the last hour"
      + (x.p95Ms === null ? "" : "; finish p95 " + secs(x.p95Ms));
    return td;
  }

  function kpi(label, value, sub, tip) {
    var box = el("div", "kpi");
    box.appendChild(el("dt", "", label));
    var dd = el("dd", value === null ? "na" : "", value === null ? "no reading" : value);
    box.appendChild(dd);
    if (sub) box.appendChild(el("dd", "sub", sub));
    if (tip) box.title = tip;
    return box;
  }

  function renderPerf() {
    var p = S.perf;
    var dl = $("kpis");
    if (!p) {
      $("perfsum").textContent = "this router does not report it";
      dl.replaceChildren(kpi("Requests", null, "", ""));
      $("perfbody").replaceChildren();
      return;
    }
    var x = p.pool;
    $("perfsum").textContent = p.observedMs < p.windowMs
      ? "only " + dur(p.observedMs) + " observed — the router restarted within the hour"
      : "rolling, kept in memory";
    var errSub = x.requests === 0 ? "" : num(x.errors) + (x.errors === 1 ? " error" : " errors")
      + (x.rateLimited > 0 ? " · " + num(x.rateLimited) + "× 429" : "");
    dl.replaceChildren(
      kpi("Requests", num(x.requests), x.completed < x.requests ? num(x.completed) + " finished" : "", "Requests that reached an upstream in the last hour."),
      kpi("Error rate", x.errorRate === null ? null : rate(x.errorRate), errSub,
        "Status 400 and above, 429 included, and responses that failed partway. A client that hung up is not counted."),
      kpi("Finish p50", x.p50Ms === null ? null : secs(x.p50Ms), "", "Half of the finished requests took less than this, from request to the end of the response."),
      kpi("Finish p95", x.p95Ms === null ? null : secs(x.p95Ms), "", "One in twenty finished requests took longer than this."),
      kpi("Output speed", x.outputTokensPerSecond === null ? null : Math.round(x.outputTokensPerSecond) + " tok/s", x.outputTokensPerSecond === null ? "" : "median, wait included",
        "Output tokens divided by the whole response time, so the wait for the first token is included.")
    );
    var models = Object.keys(p.models).sort(function (a, b) { return p.models[b].requests - p.models[a].requests || (a < b ? -1 : 1); });
    var rows = models.map(function (m) {
      var r = p.models[m];
      var tr = el("tr");
      tr.appendChild(el("td", "", m));
      tr.appendChild(lab(el("td", "num", num(r.requests)), "Requests"));
      var e = lab(el("td", "num"), "Errors");
      var mk = errMark(r);
      if (mk) e.appendChild(glyph(mk.tone, mk.glyph));
      e.appendChild(document.createTextNode(r.errors > 0 ? num(r.errors) + " · " + rate(r.errorRate || 0) : "0"));
      tr.appendChild(e);
      tr.appendChild(lab(el("td", "num", r.p50Ms === null ? "–" : secs(r.p50Ms)), "Finish p50"));
      tr.appendChild(lab(el("td", "num", r.p95Ms === null ? "–" : secs(r.p95Ms)), "Finish p95"));
      tr.appendChild(lab(el("td", "num", r.outputTokensPerSecond === null ? "–" : Math.round(r.outputTokensPerSecond) + " tok/s"), "Output speed"));
      return tr;
    });
    if (rows.length === 0) {
      var none = el("tr");
      var td = el("td", "note", "No requests in the last hour.");
      td.setAttribute("colspan", "6");
      none.appendChild(td);
      rows.push(none);
    }
    $("perfbody").replaceChildren.apply($("perfbody"), rows);
  }

  // ── recent activity ───────────────────────────────────────────────────────
  var F = { account: "", model: "", errors: false, slow: false, open: {} };

  function tokensText(l) {
    var parts = [];
    if (l.inputTokens !== undefined) parts.push(num(l.inputTokens) + " in");
    if (l.outputTokens !== undefined) parts.push(num(l.outputTokens) + " out");
    if (l.cacheReadTokens) parts.push(num(l.cacheReadTokens) + " cached");
    return parts.join(" · ");
  }
  // Share of the prompt served from cache, when the response said.
  function cacheText(l) {
    var read = l.cacheReadTokens || 0, write = l.cacheCreationTokens || 0, fresh = l.inputTokens || 0;
    var all = read + write + fresh;
    return l.cacheReadTokens === undefined && l.cacheCreationTokens === undefined || all <= 0 ? "" : Math.round(read / all * 100) + "%";
  }
  function isError(l) { return !l.clientClosed && (l.type === "error" || (l.statusCode || 0) >= 400); }
  function logKey(l) { return l.ts + "|" + l.accountId + "|" + (l.sessionId || "") + "|" + (l.path || ""); }

  // Choices come from what is in the buffer; a choice that has scrolled out
  // stays listed, so the filter does not silently reset under the reader.
  function fillSelect(id, label, values, current) {
    var sel = $(id);
    if (current && values.indexOf(current) < 0) values.push(current);
    var opts = [el("option", "", "All")];
    opts[0].value = "";
    values.forEach(function (v) {
      var o = el("option", "", v);
      o.value = v;
      if (v === current) o.selected = true;
      opts.push(o);
    });
    sel.replaceChildren.apply(sel, opts);
    sel.setAttribute("aria-label", label);
  }
  function distinct(list, key) {
    var seen = {}, out = [];
    list.forEach(function (l) { var v = key(l); if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out.sort();
  }

  function renderLogs(h) {
    var all = (h.recentLogs || []).slice().sort(function (a, b) { return b.ts - a.ts; });
    fillSelect("faccount", "Filter by account", distinct(all, function (l) { return l.accountId; }), F.account);
    fillSelect("fmodel", "Filter by model", distinct(all, function (l) { return l.model && l.model !== "-" ? l.model : ""; }), F.model);
    var p95 = S.perf ? S.perf.pool.p95Ms : null;
    var slow = function (l) { return p95 !== null && isNum(l.totalMs) && l.totalMs > p95; };
    var logs = all.filter(function (l) {
      if (F.account && l.accountId !== F.account) return false;
      if (F.model && l.model !== F.model) return false;
      if (F.errors && !isError(l)) return false;
      if (F.slow && !slow(l)) return false;
      return true;
    });
    var shown = S.showAll ? logs : logs.slice(0, LOG_ROWS);
    var rows = shown.map(function (l) {
      var key = logKey(l);
      var tr = el("tr", "row" + (F.open[key] ? " open" : ""));
      tr.setAttribute("tabindex", "0");
      tr.setAttribute("aria-expanded", F.open[key] ? "true" : "false");
      var toggle = function () {
        F.open[key] = !F.open[key];
        tr.className = "row" + (F.open[key] ? " open" : "");
        tr.setAttribute("aria-expanded", F.open[key] ? "true" : "false");
      };
      tr.addEventListener("click", function () { if (!selecting()) toggle(); });
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });

      tr.appendChild(lab(el("td", "dim mono", new Date(l.ts).toLocaleTimeString("en-GB", { hour12: false })), "Time"));
      tr.appendChild(lab(el("td", "nw", l.accountId), "Account"));
      var kind = l.type === "error" ? { tone: "crit", glyph: "■", text: "error" }
        : l.type === "refresh" ? { tone: "muted", glyph: "↻", text: "refresh" }
        : { tone: "good", glyph: "→", text: "route" };
      if (l.clientClosed) kind = { tone: "muted", glyph: "–", text: "client left" };
      var kc = lab(el("td", "nw"), "Event"); kc.appendChild(glyph(kind.tone, kind.glyph)); kc.appendChild(document.createTextNode(kind.text));
      tr.appendChild(kc);
      tr.appendChild(lab(el("td", "dim nw", l.model && l.model !== "-" ? l.model : ""), "Model"));

      var st = lab(el("td", "num mono"), "Status");
      if (isNum(l.statusCode) && l.statusCode > 0) {
        if (l.statusCode === 429) st.appendChild(glyph("warn", "▲"));
        else if (l.statusCode >= 400) st.appendChild(glyph("crit", "■"));
        st.appendChild(document.createTextNode(String(l.statusCode)));
      }
      tr.appendChild(st);

      // The whole response when it has finished; before that, or for a client
      // that left, only the wait for the headers is known, and is named so.
      var du = lab(el("td", "num mono"), "Duration");
      if (isNum(l.totalMs)) {
        if (slow(l)) { du.appendChild(glyph("warn", "▲")); du.title = "Slower than the last hour's p95 (" + secs(p95) + ")"; }
        du.appendChild(document.createTextNode(secs(l.totalMs)));
      } else if (isNum(l.durationMs)) {
        du.appendChild(el("span", "note", "headers " + secs(l.durationMs)));
        du.title = "Time until the response headers arrived; the response had not finished when this was read.";
      }
      tr.appendChild(du);
      tr.appendChild(lab(el("td", "num mono dim", isNum(l.totalMs) && l.totalMs > 0 && l.outputTokens ? Math.round(l.outputTokens / (l.totalMs / 1000)) + " tok/s" : ""), "Speed"));
      tr.appendChild(lab(el("td", "dim mono", tokensText(l)), "Tokens"));
      tr.appendChild(lab(el("td", "num mono dim", cacheText(l)), "Cache"));
      var sess = lab(el("td", "dim mono", l.sessionId ? l.sessionId.slice(0, 8) : ""), "Session");
      if (l.sessionId) sess.title = l.sessionId;
      tr.appendChild(sess);
      var d = lab(el("td", "clip", l.details || ""), "Details", true);
      d.title = l.details || "";
      tr.appendChild(d);
      return tr;
    });
    if (rows.length === 0 && all.length > 0) {
      var none = el("tr");
      var td = el("td", "note", "No events match these filters.");
      td.setAttribute("colspan", "11");
      none.appendChild(td);
      rows.push(none);
    }
    $("logbody").replaceChildren.apply($("logbody"), rows);
    var filtered = F.account || F.model || F.errors || F.slow;
    $("logsum").textContent = all.length === 0 ? "nothing yet"
      : filtered ? logs.length + " of " + all.length + " match · newest first" : "newest first · select a row for its details";
    var more = $("more");
    if (logs.length > LOG_ROWS) {
      more.hidden = false;
      more.textContent = S.showAll ? "Show fewer" : "Show all " + logs.length;
    } else {
      more.hidden = true;
    }
  }

  function renderHeader(h) {
    $("meta").textContent = h.mode + " → " + h.target + " · up " + dur(h.uptime * 1000);
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
    S.sev = validSeverity(h.severity) ? h.severity : null;
    S.perf = validPerf(h.performance) ? h.performance : null;
    renderHeader(h);
    renderStrip();
    renderSince(h);
    if (!selecting() || !S.rendered) {
      renderAccounts(h);
      renderPerf();
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
    // While the router cannot be reached a verdict from the last good poll would
    // read as reassurance, so the strip steps aside for the banner.
    if (msg) $("strip").hidden = true;
    if (msg) {
      b.hidden = false;
      b.textContent = msg + (S.okAt ? " Showing data from " + dur(Date.now() - S.okAt) + " ago." : "");
    } else {
      b.hidden = true;
    }
    $("main").className = msg && S.okAt ? "stale" : "";
  }

  // ── token history ─────────────────────────────────────────────────────────
  // Read from /cc-router/usage-history as a request of its own, with its own
  // failure state. The live view above must not turn into "can't reach the
  // router" because the history is slow or missing, and the reverse holds too.
  // Everything is computed server-side; this only draws it.
  var USAGE_MS = 60000;
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var WINDOWS = [["1d"], ["7d"], ["14d"], ["30d"]];
  var U = { data: null, okAt: 0, inflight: false, picked: "", pickedNode: null, scrolled: false };

  function validTotals(t) {
    return !!t && isNum(t.total) && isNum(t.input) && isNum(t.output) && isNum(t.cacheRead) && isNum(t.cacheCreation) && isNum(t.requests);
  }
  // The response is checked before any of it is drawn: a reply of the wrong shape
  // (a proxy error page, an older router) must land in the history's own error
  // state, not half-render or throw into the main view.
  function validUsage(d) {
    if (!d || typeof d !== "object" || typeof d.tz !== "string") return false;
    if (d.since !== null && !isNum(d.since)) return false;
    var w = d.windows;
    if (!w) return false;
    for (var i = 0; i < WINDOWS.length; i++) if (!validTotals(w[WINDOWS[i][0]])) return false;
    if (!Array.isArray(d.cells)) return false;
    for (var j = 0; j < d.cells.length; j++) {
      var c = d.cells[j];
      if (!c || typeof c !== "object") return false;
      if (c.pad) continue;
      if (typeof c.date !== "string" || !validTotals(c)) return false;
      if (c.level !== null && !(isNum(c.level) && c.level >= 0 && c.level <= 4)) return false;
    }
    var m = d.models;
    if (!m || !Array.isArray(m.rows) || !isNum(m.windowDays)) return false;
    for (var k = 0; k < m.rows.length; k++) {
      var r = m.rows[k];
      if (!r || typeof r.model !== "string" || typeof r.provider !== "string" || !isNum(r.total) || !isNum(r.share)) return false;
    }
    if (m.others !== null && !(m.others && isNum(m.others.count) && isNum(m.others.total) && isNum(m.others.share))) return false;
    var x = d.details;
    if (!x || typeof x !== "object" || !isNum(x.displayDays) || !isNum(x.activeDays) || !isNum(x.recordedDays)) return false;
    return true;
  }

  function pct(x) { return Math.round(x * 100) + "%"; }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function breakdown(t) {
    return "input " + num(t.input) + " · output " + num(t.output) + " · cache read " + num(t.cacheRead) + " · cache write " + num(t.cacheCreation);
  }
  // Dates arrive as YYYY-MM-DD already resolved in the viewer's zone, so they are
  // formatted from their parts, never parsed as an instant that could shift a day.
  function dayLabel(date) {
    var p = date.split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return DAYS[d.getUTCDay()] + ", " + MONTHS[+p[1] - 1] + " " + (+p[2]);
  }
  function sinceLabel(d) {
    try { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: d.tz }).format(d.since); }
    catch (e) { return new Date(d.since).toDateString(); }
  }
  function viewerZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; }
  }

  function kv(dl, rows) {
    var kids = [];
    rows.forEach(function (r) {
      var dt = el("dt", "", r[0]);
      var dd = el("dd", "", r[1]);
      if (r[2]) { dt.title = r[2]; dd.title = r[2]; }
      kids.push(dt, dd);
    });
    dl.replaceChildren.apply(dl, kids);
  }
  function bar(share, label) {
    var meter = el("div", "meter");
    var fill = el("div", "fill");
    var w = Math.min(100, Math.round(share * 100));
    fill.style.width = (share > 0 && w < 2 ? 2 : w) + "%";
    meter.appendChild(fill);
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", label);
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    meter.setAttribute("aria-valuenow", String(w));
    return meter;
  }
  function shareRow(name, share, value, tip) {
    var li = el("li", "mrow");
    var n = el("div", "mname clip", name);
    if (tip) n.title = tip;
    li.appendChild(n);
    li.appendChild(bar(share, name));
    li.appendChild(el("div", "mval", value));
    return li;
  }

  function dayText(c) {
    var label = dayLabel(c.date);
    if (c.level === null) return label + " — no data: recording had not started";
    if (c.total === 0) return label + " — nothing recorded";
    return label + " — " + num(c.total) + " tokens (" + breakdown(c) + "), " + plural(c.requests, "request");
  }
  function pick(node, c) {
    if (U.pickedNode) U.pickedNode.className = U.pickedNode.className.replace(" sel", "");
    U.picked = c.date;
    U.pickedNode = node;
    node.className += " sel";
    $("hminfo").textContent = dayText(c);
  }

  function renderHeatmap(d) {
    var cells = d.cells, nodes = [], shown = 0;
    U.pickedNode = null;
    cells.forEach(function (c) {
      if (c.pad) {
        var gap = el("div", "hx hp");
        gap.setAttribute("aria-hidden", "true");
        nodes.push(gap);
        return;
      }
      shown += c.total;
      var n = el("div", "hx " + (c.level === null ? "hn" : "h" + c.level));
      var text = dayText(c);
      n.title = text;
      n.setAttribute("role", "img");
      n.setAttribute("aria-label", text);
      n.addEventListener("click", function () { pick(n, c); });
      if (c.date === U.picked) pick(n, c);
      nodes.push(n);
    });
    var grid = $("hmgrid");
    grid.replaceChildren.apply(grid, nodes);

    // Month names sit over the column where a new month first appears, and are
    // skipped when they would collide with the previous one.
    var weeks = Math.ceil(cells.length / 7), labels = [], lastCol = -3, lastMonth = -1;
    for (var col = 0; col < weeks; col++) {
      var first = null;
      for (var r = 0; r < 7 && !first; r++) {
        var cc = cells[col * 7 + r];
        if (cc && !cc.pad) first = cc;
      }
      if (!first) continue;
      var mo = +first.date.split("-")[1] - 1;
      if (mo !== lastMonth && col - lastCol >= 2) {
        var lb = el("div", "hmm", MONTHS[mo]);
        lb.style.gridColumnStart = String(col + 1);
        lb.style.gridRowStart = "1";
        labels.push(lb);
        lastCol = col;
        lastMonth = mo;
      }
    }
    var months = $("hmmonths");
    months.replaceChildren.apply(months, labels);

    var names = [[2, "Mon"], [4, "Wed"], [6, "Fri"]].map(function (p) {
      var l = el("div", "", p[1]);
      l.style.gridRowStart = String(p[0]);
      return l;
    });
    var days = $("hmdays");
    days.replaceChildren.apply(days, names);

    // Where the grid is wider than the card (a phone), start at the newest week:
    // the recent days are the ones wanted. Only the first time, so a refresh never
    // drags the view back while someone is scrolling through the past.
    if (!U.scrolled) {
      var sc = $("hmscroll");
      sc.scrollLeft = sc.scrollWidth;
      U.scrolled = true;
    }

    var x = d.details;
    $("hmsum").textContent = "last " + x.displayDays + " days, calendar days in " + d.tz;
    kv($("hmfacts"), [
      ["Total shown", num(shown) + " tokens"],
      ["Busiest day", x.busiest ? dayLabel(x.busiest.date) + " · " + num(x.busiest.total) : "no reading",
        x.busiest ? "" : "No tokens have been recorded on any displayed day."],
      ["Active days", x.recordedDays > 0 ? x.activeDays + " of " + x.recordedDays + " recorded" : "no reading",
        "Days with any usage, out of the days recording was running."]
    ]);
  }

  function renderModels(d) {
    var m = d.models, kids = [];
    if (m.rows.length === 0) kids.push(el("li", "note", "No usage in the last " + m.windowDays + " days."));
    m.rows.forEach(function (r) {
      var name = r.provider === "openai" ? r.model + " (OpenAI)"
        : r.provider === "ollama" ? r.model + " (Ollama)" : r.model;
      kids.push(shareRow(name, r.share, num(r.total) + " · " + pct(r.share), r.model + " · " + plural(r.requests, "request")));
    });
    if (m.others) kids.push(shareRow(plural(m.others.count, "other model"), m.others.share, num(m.others.total) + " · " + pct(m.others.share), ""));
    var list = $("mlist");
    list.replaceChildren.apply(list, kids);
  }

  function renderDetails(d) {
    var x = d.details, t = d.windows["30d"];
    kv($("detlist"), [
      ["Cache hit ratio", x.cacheHitRatio === null ? "no reading" : pct(x.cacheHitRatio),
        "Cache read ÷ (cache read + cache write + uncached input), Claude accounts only. No reading means there is nothing recorded to divide."],
      ["Avg tokens / request", x.avgTokensPerRequest === null ? "no reading" : num(x.avgTokensPerRequest),
        "All tokens divided by metered requests, over the last " + x.windowDays + " days."],
      ["Requests", num(t.requests), "Responses the router could read usage from."]
    ]);
    var mixKids = [];
    if (t.total <= 0) mixKids.push(el("li", "note", "No usage in the last " + x.windowDays + " days."));
    else {
      [["Cache read", t.cacheRead], ["Cache write", t.cacheCreation], ["Input (uncached)", t.input], ["Output", t.output]].forEach(function (p) {
        mixKids.push(shareRow(p[0], p[1] / t.total, num(p[1]) + " · " + pct(p[1] / t.total), ""));
      });
    }
    var mix = $("mixlist");
    mix.replaceChildren.apply(mix, mixKids);
  }

  function renderUsage(d) {
    var none = d.since === null;
    $("usesum").textContent = none
      ? "nothing recorded yet"
      : "recording since " + sinceLabel(d) + (d.tzFallback ? " · your time zone was not recognised, showing UTC" : "");
    renderHeatmap(d);
    renderModels(d);
    renderDetails(d);
  }

  function usageState(msg) {
    var b = $("usestate");
    b.hidden = !msg;
    if (msg) b.textContent = msg;
  }

  function fetchUsage() {
    if (U.inflight) return;
    U.inflight = true;
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 8000);
    var zone = viewerZone();
    fetch("/cc-router/usage-history" + (zone ? "?tz=" + encodeURIComponent(zone) : ""), { cache: "no-store", signal: ctrl.signal })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!validUsage(data)) throw new Error("unexpected response");
        U.data = data;
        U.okAt = Date.now();
        usageState(null);
        renderUsage(data);
      })
      .catch(function (err) {
        usageState("Token history is unavailable (" + err.message + ")." + (U.okAt ? " Showing data from " + dur(Date.now() - U.okAt) + " ago." : ""));
      })
      .then(function () {
        clearTimeout(to);
        U.inflight = false;
      });
  }


  // ── activity over time ───────────────────────────────────────────────────
  // From /cc-router/usage-series, a request of its own like the history above.
  // Every model arrives separately. Style slots follow provider/model identity
  // so a refresh or range change cannot repaint a surviving model.
  var SERIES_PATH = "/cc-router/usage-series";
  var RANGES = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" };
  var METRICS = { requests: "requests", output: "output tokens", total: "tokens" };
  var A = { range: "24h", metric: "requests", data: null, okAt: 0, inflight: 0, sel: -1, table: false, geo: null, drawnWidth: 0 };

  function validSeries(d) {
    if (!d || typeof d !== "object" || !RANGES.hasOwnProperty(d.range) || (d.step !== "hour" && d.step !== "day")) return false;
    if (!Array.isArray(d.series) || !Array.isArray(d.points) || d.points.length > 400) return false;
    for (var i = 0; i < d.series.length; i++) {
      var x = d.series[i];
      if (!x || typeof x.model !== "string" || typeof x.provider !== "string") return false;
    }
    var w = d.series.length;
    for (var j = 0; j < d.points.length; j++) {
      var p = d.points[j];
      if (!p || !isNum(p.start) || typeof p.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || typeof p.recorded !== "boolean") return false;
      var lists = [p.requests, p.output, p.total];
      for (var k = 0; k < 3; k++) {
        if (!Array.isArray(lists[k]) || lists[k].length !== w) return false;
        for (var q = 0; q < w; q++) if (!isNum(lists[k][q]) || lists[k][q] < 0) return false;
      }
    }
    var t = d.totals;
    if (!t || !isNum(t.requests) || !isNum(t.output) || !isNum(t.total) || (t.cacheHitRatio !== null && !isNum(t.cacheHitRatio))) return false;
    return true;
  }

  var modelStyles = new Map();
  function seriesSlot(d, i) {
    var x = d.series[i], key = x.provider + "\u0000" + x.model;
    if (!modelStyles.has(key)) modelStyles.set(key, modelStyles.size);
    return modelStyles.get(key);
  }
  function seriesClass(d, i) {
    var slot = seriesSlot(d, i);
    return d.series[i].other ? "so" : "s" + (slot < 8 ? slot : [0, 2, 4, 6, 1, 3, 5, 7][(slot - 8) % 8]);
  }
  function modelLabel(d, i) { return (seriesSlot(d, i) + 1) + ". " + seriesName(d.series[i]); }
  function patternFill(d, i) { return "url(#model-pattern-" + seriesSlot(d, i) + ")"; }
  function seriesName(x) {
    if (x.other) return "Other models";
    return x.provider === "openai" ? x.model + " (OpenAI)" : x.provider === "ollama" ? x.model + " (Ollama)" : x.model;
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  // Hours are instants, shown in this browser's zone, which is the zone the
  // series was asked for. Days are calendar dates already resolved by the
  // router, so they are read from their parts and never shifted.
  function stepLabel(d, p, long) {
    if (d.step === "day") return dayLabel(p.date);
    var t = new Date(p.start);
    var hh = pad2(t.getHours()) + ":00";
    return long ? DAYS[t.getDay()] + ", " + MONTHS[t.getMonth()] + " " + t.getDate() + " · " + hh : hh;
  }
  function metricValue(v) { return A.metric === "requests" ? num(v) + (v === 1 ? " request" : " requests") : num(v) + " " + METRICS[A.metric]; }
  function stack(p) { var n = 0; p[A.metric].forEach(function (v) { n += v; }); return n; }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * mag >= v) return steps[i] * mag;
    return 10 * mag;
  }

  function pointText(d, i) {
    var p = d.points[i];
    var label = stepLabel(d, p, true);
    if (!p.recorded) return label + " — no data: recording had not started";
    var total = stack(p);
    var partial = i === d.points.length - 1 ? (d.step === "hour" ? " so far this hour" : " so far today") : "";
    if (total === 0) return label + " — nothing recorded" + partial;
    var parts = [];
    d.series.forEach(function (x, k) { if (p[A.metric][k] > 0) parts.push(seriesName(x) + " " + num(p[A.metric][k])); });
    return label + " — " + metricValue(total) + partial + ": " + parts.join(" · ");
  }

  function select(i) {
    var d = A.data;
    if (!d || i < 0 || i >= d.points.length) return;
    A.sel = d.points[i].start;
    $("actinfo").textContent = pointText(d, i);
    var col = $("chartbox").selcol;
    if (col && A.geo) {
      col.setAttribute("x", String(A.geo.left + i * A.geo.slot));
      col.setAttribute("visibility", "visible");
    }
  }
  function selectedIndex(d) {
    for (var i = 0; i < d.points.length; i++) if (d.points[i].start === A.sel) return i;
    return -1;
  }

  function renderChart(d) {
    var box = $("chartbox");
    var n = d.points.length;
    var avail = box.clientWidth || 720;
    var left = 46, right = 4, top = 10, bottom = 24, height = 208;
    // At least 4px per step: 168 hours become a sideways scroll on a phone
    // rather than bars too thin to aim at.
    var width = Math.max(avail, left + right + n * 4, 300);
    var plot = height - top - bottom;
    var slot = (width - left - right) / Math.max(1, n);
    var gap = slot >= 8 ? 2 : 1;
    var peak = 0;
    d.points.forEach(function (p) { if (p.recorded) peak = Math.max(peak, stack(p)); });
    var max = niceMax(peak);
    A.geo = { left: left, slot: slot };
    A.drawnWidth = avail;

    var root = svg("svg", "chart", { width: width, height: height, viewBox: "0 0 " + width + " " + height });
    root.setAttribute("tabindex", "0");
    root.setAttribute("role", "group");
    root.setAttribute("aria-roledescription", "chart");
    root.setAttribute("aria-label", METRICS[A.metric].charAt(0).toUpperCase() + METRICS[A.metric].slice(1) + " per " + d.step + " by model, " + RANGES[d.range]
      + ". Left and right arrow keys read one " + d.step + " at a time; the table view lists them all.");

    // Each model has an opaque colour; textures provide secondary identity.
    var defs = svg("defs", "");
    d.series.forEach(function (x, i) {
      if (seriesSlot(d, i) < 8 || x.other) return;
      var slot = seriesSlot(d, i), size = 6 + slot;
      var pattern = svg("pattern", "", { id: "model-pattern-" + slot, patternUnits: "userSpaceOnUse", width: size, height: size });
      pattern.appendChild(svg("rect", seriesClass(d, i), { width: size, height: size }));
      pattern.appendChild(svg("path", "texture-line", { d: "M0 " + size + "L" + size + " 0", "stroke-width": 1 }));
      defs.appendChild(pattern);
    });
    root.appendChild(defs);

    // Three gridlines, labelled at the left: zero, half and the top.
    [0, 0.5, 1].forEach(function (f) {
      var y = top + plot - f * plot;
      root.appendChild(svg("line", f === 0 ? "base" : "grid", { x1: left, x2: width - right, y1: y, y2: y }));
      var t = svg("text", "", { x: left - 6, y: y + 4, "text-anchor": "end" });
      t.textContent = f === 0 ? "0" : num(max * f);
      root.appendChild(t);
    });

    var col = svg("rect", "selcol", { x: 0, y: top, width: slot, height: plot, visibility: "hidden" });
    root.appendChild(col);
    box.selcol = col;

    d.points.forEach(function (p, i) {
      var x = left + i * slot + gap / 2, w = Math.max(1, slot - gap);
      if (!p.recorded) {
        root.appendChild(svg("rect", "nodata", { x: x, y: top + plot - 2, width: w, height: 2 }));
        return;
      }
      var base = top + plot;
      var segs = [];
      p[A.metric].forEach(function (v, k) { if (v > 0) segs.push([k, v / max * plot]); });
      var partial = i === n - 1 ? " partial" : "";
      segs.forEach(function (sg, j) {
        var h = sg[1];
        // A surface-coloured gap between stacked segments, where there is room for one.
        var drawn = j < segs.length - 1 && h > 3 ? h - 1 : h;
        var mark = svg("rect", seriesClass(d, sg[0]) + partial, { x: x, y: base - h, width: w, height: Math.max(0.5, drawn) });
        if (seriesSlot(d, sg[0]) >= 8 && !d.series[sg[0]].other) {
          mark.setAttribute("class", "textured" + partial);
          mark.setAttribute("fill", patternFill(d, sg[0]));
        }
        var title = svg("title", "");
        title.textContent = modelLabel(d, sg[0]) + " — " + metricValue(p[A.metric][sg[0]]);
        mark.appendChild(title);
        root.appendChild(mark);
        base -= h;
      });
    });

    // Step labels along the bottom, spaced so they never touch.
    var lastX = -1e9;
    d.points.forEach(function (p, i) {
      var want;
      if (d.step === "day") want = (n - 1 - i) % 5 === 0;
      else {
        var hr = new Date(p.start).getHours();
        want = d.range === "24h" ? hr % 3 === 0 : hr === 0;
      }
      if (!want) return;
      var cx = left + i * slot + slot / 2;
      if (cx - lastX < 44) return;
      var text = d.step === "day" ? MONTHS[+p.date.split("-")[1] - 1] + " " + (+p.date.split("-")[2])
        : d.range === "24h" ? stepLabel(d, p, false)
        : DAYS[new Date(p.start).getDay()] + " " + new Date(p.start).getDate();
      var t = svg("text", "", { x: cx, y: height - 6, "text-anchor": i === 0 ? "start" : "middle" });
      t.textContent = text;
      root.appendChild(t);
      lastX = cx;
    });

    var at = function (e) {
      var r = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
      var px = r ? (e.clientX - r.left) * (width / (r.width || width)) : e.offsetX;
      return Math.floor((px - left) / slot);
    };
    root.addEventListener("pointermove", function (e) { select(Math.max(0, Math.min(n - 1, at(e)))); });
    root.addEventListener("click", function (e) { select(Math.max(0, Math.min(n - 1, at(e)))); });
    root.addEventListener("keydown", function (e) {
      var i = selectedIndex(d);
      var next = e.key === "ArrowLeft" ? (i < 0 ? n - 1 : i - 1) : e.key === "ArrowRight" ? (i < 0 ? n - 1 : i + 1)
        : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
      if (next === null) return;
      e.preventDefault();
      select(Math.max(0, Math.min(n - 1, next)));
    });
    box.replaceChildren(root);
  }

  function renderLegend(d) {
    var sums = d.series.map(function () { return 0; }), all = 0;
    d.points.forEach(function (p) { p[A.metric].forEach(function (v, k) { sums[k] += v; all += v; }); });
    var kids = d.series.map(function (x, k) {
      var li = el("li", "lrow");
      var swatch = svg("svg", "sw", { width: 10, height: 10, "aria-hidden": "true" });
      var tile = svg("rect", seriesClass(d, k), { width: 10, height: 10 });
      if (seriesSlot(d, k) >= 8 && !x.other) {
        tile.setAttribute("class", "textured");
        tile.setAttribute("fill", patternFill(d, k));
      }
      swatch.appendChild(tile);
      li.appendChild(swatch);
      var name = el("span", "model-name", modelLabel(d, k));
      name.title = seriesName(x);
      li.appendChild(name);
      li.appendChild(el("span", "lval", num(sums[k]) + (all > 0 ? " · " + pct(sums[k] / all) : "")));
      return li;
    });
    if (kids.length === 0) kids.push(el("li", "note", "No model has been used yet."));
    var list = $("actlegend");
    list.replaceChildren.apply(list, kids);
  }

  function renderSeriesTable(d) {
    var head = [el("th", "", d.step === "day" ? "Day" : "Hour")];
    d.series.forEach(function (x) { head.push(el("th", "num", seriesName(x))); });
    head.push(el("th", "num", "Total"));
    head.forEach(function (th) { th.setAttribute("scope", "col"); });
    $("acthead").replaceChildren.apply($("acthead"), head);
    var rows = d.points.slice().reverse().map(function (p) {
      var tr = el("tr");
      tr.appendChild(el("td", "mono", stepLabel(d, p, true)));
      if (!p.recorded) {
        var td = el("td", "note", "no data");
        td.setAttribute("colspan", String(d.series.length + 1));
        tr.appendChild(td);
        return tr;
      }
      p[A.metric].forEach(function (v) { tr.appendChild(el("td", "num", num(v))); });
      tr.appendChild(el("td", "num", num(stack(p))));
      return tr;
    });
    $("actrows").replaceChildren.apply($("actrows"), rows);
  }

  function renderActivity() {
    ["24h", "7d", "30d"].forEach(function (r) { $("r-" + r).setAttribute("aria-pressed", A.range === r ? "true" : "false"); });
    ["requests", "output", "total"].forEach(function (m) { $("m-" + m).setAttribute("aria-pressed", A.metric === m ? "true" : "false"); });
    var d = A.data;
    if (!d || d.range !== A.range) return;
    var t = d.totals;
    var tot = $("acttot");
    var line = [num(t.requests) + " requests", num(t.output) + " output tokens", num(t.total) + " tokens in all"];
    if (t.cacheHitRatio !== null) line.push("cache hit " + pct(t.cacheHitRatio));
    tot.replaceChildren(el("strong", "", RANGES[d.range].charAt(0).toUpperCase() + RANGES[d.range].slice(1)), document.createTextNode(" · " + line.join(" · ")));
    renderChart(d);
    renderLegend(d);
    if (A.table) renderSeriesTable(d);
    var i = selectedIndex(d);
    if (i >= 0) select(i);
    else $("actinfo").textContent = "Hover, tap or use the arrow keys on the chart to read " + (d.step === "hour" ? "an hour." : "a day.");
  }

  function seriesState(msg) {
    var b = $("actstate");
    b.hidden = !msg;
    if (msg) b.textContent = msg;
  }

  function fetchSeries() {
    var ticket = ++A.inflight;
    var range = A.range;
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 8000);
    var zone = viewerZone();
    fetch(SERIES_PATH + "?range=" + range + (zone ? "&tz=" + encodeURIComponent(zone) : ""), { cache: "no-store", signal: ctrl.signal })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        // A slower answer for a range the viewer has since left is dropped.
        if (ticket !== A.inflight || range !== A.range) return;
        if (!validSeries(data) || data.range !== range) throw new Error("unexpected response");
        A.data = data;
        A.okAt = Date.now();
        seriesState(null);
        renderActivity();
      })
      .catch(function (err) {
        if (ticket !== A.inflight) return;
        seriesState("The activity chart is unavailable (" + err.message + ")." + (A.okAt ? " Showing data from " + dur(Date.now() - A.okAt) + " ago." : ""));
      })
      .then(function () { clearTimeout(to); });
  }

  ["24h", "7d", "30d"].forEach(function (r) {
    $("r-" + r).addEventListener("click", function () {
      if (A.range === r) return;
      A.range = r;
      A.sel = -1;
      renderActivity();
      fetchSeries();
    });
  });
  ["requests", "output", "total"].forEach(function (m) {
    $("m-" + m).addEventListener("click", function () {
      A.metric = m;
      renderActivity();
    });
  });
  $("acttable").addEventListener("click", function () {
    A.table = !A.table;
    $("acttablewrap").hidden = !A.table;
    $("acttable").textContent = A.table ? "Hide table" : "Show as table";
    $("acttable").setAttribute("aria-expanded", A.table ? "true" : "false");
    if (A.table && A.data) renderSeriesTable(A.data);
  });
  if (window.addEventListener) {
    var resizeTimer = 0;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (A.data && $("chartbox").clientWidth !== A.drawnWidth) renderActivity();
      }, 150);
    });
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
  function refilter() {
    F.account = $("faccount").value || "";
    F.model = $("fmodel").value || "";
    F.errors = !!$("ferr").checked;
    F.slow = !!$("fslow").checked;
    if (S.data) renderLogs(S.data);
  }
  ["faccount", "fmodel", "ferr", "fslow"].forEach(function (id) { $(id).addEventListener("change", refilter); });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    poll();
    if (Date.now() - U.okAt > 30000) fetchUsage();
    if (Date.now() - A.okAt > 30000) fetchSeries();
  });
  setInterval(tickUpdated, 1000);
  setInterval(function () { if (!document.hidden) { fetchUsage(); fetchSeries(); } }, USAGE_MS);
  renderActivity();
  poll();
  fetchUsage();
  fetchSeries();
})();
`;

const sha256 = (s: string): string => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

/**
 * Only these two inline blocks may run or style anything, and nothing may be
 * fetched except from the router itself (its health and usage-history JSON).
 * `img-src data:` is for the empty favicon, which stops the browser asking the
 * proxy for /favicon.ico.
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

export interface WebDashboardOptions {
  /** Summary of recorded token usage for a viewer's time zone. Omit to leave the endpoint unmounted. */
  usage?: (tz: string | undefined) => unknown;
  /** Usage over time by model, for a range and a viewer's time zone. Omit to leave the endpoint unmounted. */
  series?: (range: string | undefined, tz: string | undefined) => unknown;
}

/** Serve a JSON aggregate on an open route; the failure says nothing about why. */
function sendAggregate(res: Response, build: () => unknown, failure: string): void {
  res.set({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  try {
    res.send(JSON.stringify(build()));
  } catch {
    // Say nothing about why: the caller is unauthenticated.
    res.status(500).send(JSON.stringify({ error: failure }));
  }
}

/**
 * Mount the page. Call this BEFORE the proxy-secret middleware: a browser
 * navigation cannot carry an Authorization header, and the page holds no data —
 * what it shows comes from `/cc-router/health`, which is already exempt from the
 * secret for monitoring, and from `/cc-router/usage-history`, mounted here for
 * the same reason. Mounting them later would not protect anything: it would only
 * make the page unusable.
 *
 * That makes the usage-history and usage-series responses public on the router's
 * port, exactly as health is. They are therefore aggregates only — totals per
 * window, day, hour and model — with no account ids, session ids or credentials.
 */
export function mountWebDashboard(app: Express, opts: WebDashboardOptions = {}): void {
  const html = renderDashboardHtml();
  const { usage, series } = opts;
  // `?tz=a&tz=b` parses to an array; only a single string is a value.
  const one = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  if (usage) {
    app.get(USAGE_HISTORY_PATH, (req: Request, res: Response) => {
      sendAggregate(res, () => usage(one(req.query["tz"])), "usage history is unavailable");
    });
  }
  if (series) {
    app.get(USAGE_SERIES_PATH, (req: Request, res: Response) => {
      sendAggregate(res, () => series(one(req.query["range"]), one(req.query["tz"])), "usage series is unavailable");
    });
  }
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
