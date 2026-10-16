/**
 * The status dashboard as a list of lines, with no terminal in sight.
 *
 * `buildFrame` turns the health data and the operator's current selection into
 * exactly the lines to draw, each already cut to the pane. Dashboard.tsx only
 * keeps the state and hands these to Ink. Because nothing here touches a
 * terminal, "no frame is ever taller or wider than its pane" is a test, not a
 * hope (see status-frame.test.ts).
 */
import type { LogEntry } from "../proxy/stats.js";
import {
  computeSeverity,
  describeSeverity,
  formatRemaining,
  windowReading,
} from "../proxy/severity.js";
import type { AccountRung, AccountSeverity, PoolSeverity, WindowKey } from "../proxy/severity.js";
import { accountCooldownSummary, accountProviderTag, paddedProviderTag } from "./account-view.js";
import type { ModelsStatus } from "./modelsApi.js";
import { planLayout, DETAILS_LINES } from "./status-layout.js";
import type { LayoutPlan, WidthTier } from "./status-layout.js";
import type { AccountStat, Focus, HealthData, Mode, OperationalStatus } from "./status-types.js";
import {
  cellWidth, fitSegs, padCells, seg, segsWidth, terminalSafeText, truncateCells,
} from "./term-text.js";
import type { Seg } from "./term-text.js";

const MODEL_VISIBLE_ROWS = 16;

export type UsageDetailMode = "cache" | "basic" | "none";

export function usageDetailMode(log: LogEntry): UsageDetailMode {
  if (log.cacheReadTokens !== undefined || log.cacheCreationTokens !== undefined) return "cache";
  if (log.inputTokens !== undefined || log.outputTokens !== undefined) return "basic";
  return "none";
}

export function getVisibleModelWindow<T>(
  models: T[],
  selectedIndex: number,
  maxRows = MODEL_VISIBLE_ROWS,
): { rows: T[]; start: number; end: number } {
  if (models.length <= maxRows) {
    return { rows: models, start: 0, end: models.length };
  }

  const selected = Math.max(0, Math.min(selectedIndex, models.length - 1));
  const start = Math.max(0, Math.min(selected - maxRows + 1, models.length - maxRows));
  const end = Math.min(models.length, start + maxRows);
  return { rows: models.slice(start, end), start, end };
}

// ─── Vocabulary shared with the web page: glyph + word, never colour alone ───

const GLYPH: Record<AccountRung, string> = { ok: "✓", watch: "▲", problem: "■", off: "–" };
const RUNG_COLOR: Record<AccountRung, string> = { ok: "green", watch: "yellow", problem: "red", off: "gray" };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatAgo(ts: number, now: number): string {
  if (!ts) return "never";
  const ms = now - ts;
  return ms < 1_000 ? "now" : `${formatRemaining(ms)} ago`;
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function httpStatusText(code: number): string {
  const map: Record<number, string> = {
    200: "OK", 201: "Created", 204: "No Content",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
    404: "Not Found", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway",
    503: "Service Unavailable", 529: "Overloaded",
  };
  return map[code] ?? "";
}

function sourceFullLabel(source: LogEntry["source"]): string {
  if (source === "cli") return "Claude Code";
  if (source === "desktop") return "Claude Desktop";
  if (source === "api") return "API";
  return "—";
}

function join(parts: Seg[][]): Seg[] {
  return parts.flat();
}

// ─── The strip: the verdict, in one line ─────────────────────────────────────

export function stripLine(sev: PoolSeverity, data: HealthData, updatedAgoSec: number, fit: number): Seg[] {
  const color = RUNG_COLOR[sev.pool];
  const left: Seg[] = [
    seg(" CC-Router ", "cyan", { bold: true }),
    seg(`${GLYPH[sev.pool]} `, color, { bold: true }),
    seg(describeSeverity(sev), color, { bold: sev.pool !== "ok" }),
  ];
  const right: Seg[] = [seg(`up ${formatUptime(data.uptime)} · ${updatedAgoSec}s ago `, "gray")];
  const gap = fit - segsWidth(left) - segsWidth(right);
  if (gap >= 2) return [...left, seg(" ".repeat(gap)), ...right];
  return fitSegs(left, fit);
}

// ─── Accounts ────────────────────────────────────────────────────────────────

interface AccountTier {
  name: number;
  /** Width of the quota bar, 0 for numbers only. */
  bar: number;
  reset: boolean;
  tag: boolean;
}

const ACCOUNT_TIERS: Record<WidthTier, AccountTier> = {
  wide: { name: 14, bar: 10, reset: true, tag: true },
  normal: { name: 12, bar: 8, reset: true, tag: false },
  narrow: { name: 10, bar: 0, reset: true, tag: false },
  tiny: { name: 8, bar: 0, reset: false, tag: false },
};

const STATE_WIDTH = 9;
const READING_NOTE: Record<string, string> = {
  "not measured yet": "not measured yet",
  "no reading": "no reading",
  "reset since last reading": "reset, no reading",
};

function utilColor(util: number, capPercent: number, thresholds: PoolSeverity["thresholds"]): string {
  if (capPercent < 100 && util * 100 >= capPercent) return "red";
  if (util >= thresholds.problem) return "red";
  if (util >= thresholds.watch) return "yellow";
  return "green";
}

/** One quota window, padded to a fixed width so the next column lines up. */
function windowCell(
  label: string,
  key: WindowKey,
  a: AccountStat,
  capPercent: number,
  now: number,
  tier: AccountTier,
  thresholds: PoolSeverity["thresholds"],
  muted: boolean,
): Seg[] {
  const rl = a.rateLimits;
  const active = rl?.claim === (key === "fiveHour" ? "five_hour" : "seven_day");
  const total = 3 + (tier.bar > 0 ? tier.bar + 1 : 0) + 4 + (tier.reset ? 7 : 0);
  const head = seg(`${label} `, active ? "white" : "gray", { bold: active });
  const r = windowReading(rl, key, now);

  if (!r.ok) {
    // No figure is shown as a figure: an unmeasured window is not 0 %.
    const note = tier.bar > 0 ? READING_NOTE[r.note] ?? r.note : "—";
    return [head, seg(padCells(note, total - 3), "gray")];
  }

  // An account the operator switched off is not being spent; its figures are history, not alarms.
  const color = muted ? "gray" : utilColor(r.util, capPercent, thresholds);
  const out: Seg[] = [head];
  if (tier.bar > 0) {
    const filled = Math.max(0, Math.min(tier.bar, Math.round(r.util * tier.bar)));
    out.push(seg("█".repeat(filled) + "░".repeat(tier.bar - filled) + " ", color));
  }
  out.push(seg(padCells(`${Math.round(r.util * 100)}%`, 4, "right"), color));
  if (tier.reset) {
    const left = r.reset > 0 ? `↻${formatRemaining(r.reset * 1000 - now)}` : "";
    out.push(seg(padCells(left ? ` ${left}` : "", 7), "gray"));
  }
  return out;
}

function stateWord(a: AccountStat, s: AccountSeverity, now: number): { text: string; color: string; glyph: string } {
  switch (s.state) {
    case "off": return { text: "off", color: "gray", glyph: GLYPH.off };
    case "expired": return { text: "EXPIRED", color: "red", glyph: GLYPH.problem };
    case "cooling": return { text: `COOL ${formatRemaining((s.until ?? now) - now)}`, color: "red", glyph: GLYPH.problem };
    case "limited": return { text: "LIMITED", color: "red", glyph: GLYPH.problem };
    case "unhealthy": return { text: "ERROR", color: "red", glyph: GLYPH.problem };
    case "near": return { text: "NEAR", color: "red", glyph: GLYPH.problem };
    case "hot": return { text: "hot", color: "yellow", glyph: GLYPH.watch };
    default:
      // `busy` is information, not a rung: it does not raise the verdict.
      return a.busy
        ? { text: "busy", color: "yellow", glyph: "◌" }
        : { text: "ok", color: "green", glyph: GLYPH.ok };
  }
}

export function accountLine(
  a: AccountStat,
  s: AccountSeverity,
  plan: Pick<LayoutPlan, "width" | "fit">,
  selected: boolean,
  now: number,
  thresholds: PoolSeverity["thresholds"],
): Seg[] {
  const tier = ACCOUNT_TIERS[plan.width];
  const st = stateWord(a, s, now);
  const off = s.rung === "off";

  const segs: Seg[] = [
    seg(selected ? "▶ " : "  ", selected ? "cyan" : undefined),
    seg(st.glyph, st.color, { bold: s.rung === "problem" }),
    seg(" "),
    seg(padCells(terminalSafeText(a.id), tier.name), off ? "gray" : undefined, { dim: off }),
    seg(" "),
    seg(padCells(st.text, STATE_WIDTH), st.color, { bold: s.rung === "problem" }),
    seg(" "),
  ];
  if (tier.tag) {
    segs.push(seg(paddedProviderTag({ provider: a.provider, rateLimits: a.rateLimits }), a.provider === "openai_subscription" ? "cyan" : "magenta"));
  }

  const s5 = a.sessionLimitPercent ?? 100;
  const w7 = a.weeklyLimitPercent ?? 100;
  segs.push(...windowCell("5h", "fiveHour", a, s5, now, tier, thresholds, off));
  segs.push(seg("  "));
  segs.push(...windowCell("7d", "sevenDay", a, w7, now, tier, thresholds, off));

  // Extras go on only while they fit, in the order the operator reaches for them.
  // The fixed ones are padded to a constant width so the same ones appear on every
  // row and line up; the cooldown and cap notes only exist on the rows they
  // describe, so they come first and are the ones allowed to be uneven.
  // The state column already counts down an account-wide cooldown; per-model
  // deadlines are the part it cannot say.
  const cooldown = s.state === "cooling" && s.scope ? accountCooldownSummary(a, now) : null;
  const extras: Seg[][] = [];
  if (cooldown) extras.push([seg("  "), seg(cooldown, "red")]);
  if (s5 < 100 || w7 < 100) {
    extras.push([seg(`  cap${s5 < 100 ? ` 5h≤${s5}%` : ""}${w7 < 100 ? ` 7d≤${w7}%` : ""}`, "yellow")]);
  }
  extras.push([
    seg("  req "), seg(padCells(String(a.requestCount), 5, "right"), "white"),
    seg("  err "), seg(padCells(String(a.errorCount), 3, "right"), a.errorCount > 0 ? "red" : "gray"),
  ]);
  extras.push([seg("  last ", "gray"), seg(padCells(formatAgo(a.lastUsedMs, now), 9), "gray")]);
  extras.push([
    seg("  tok ", "gray"),
    seg(padCells(a.expiresInMs > 0 ? formatRemaining(a.expiresInMs) : "EXPIRED", 7), a.expiresInMs < 10 * 60_000 ? "red" : a.expiresInMs < 30 * 60_000 ? "yellow" : "white"),
  ]);
  let used = segsWidth(segs);
  for (const extra of extras) {
    const w = segsWidth(extra);
    if (used + w > plan.fit) continue;
    segs.push(...extra);
    used += w;
  }
  return fitSegs(segs, plan.fit);
}

const RANK: Record<AccountRung, number> = { problem: 0, watch: 1, ok: 2, off: 3 };

/**
 * Which accounts to draw when there is room for `rows` of them, as indices into
 * the account list. All of them when they fit. When they do not: a window that
 * follows the selection while the operator is working in the list (so the cursor
 * never leaves the screen), otherwise the ones that most need a look.
 */
export function pickAccounts(rungs: readonly AccountRung[], rows: number, focused: boolean, selected: number): number[] {
  const n = rungs.length;
  if (rows >= n) return rungs.map((_, i) => i);
  if (rows <= 0) return [];
  if (focused) {
    const sel = Math.max(0, Math.min(selected, n - 1));
    const start = Math.max(0, Math.min(sel - rows + 1, n - rows));
    return Array.from({ length: rows }, (_, i) => start + i);
  }
  return rungs
    .map((rung, i) => ({ rung, i }))
    .sort((x, y) => RANK[x.rung] - RANK[y.rung] || x.i - y.i)
    .slice(0, rows)
    .map(x => x.i)
    .sort((x, y) => x - y);
}

function foldLine(rungs: readonly AccountRung[], shown: readonly number[], focused: boolean): Seg[] {
  const hidden = rungs.filter((_, i) => !shown.includes(i));
  const needLook = hidden.filter(r => r === "problem" || r === "watch").length;
  if (needLook === 0) return [seg(`   +${hidden.length} more, all fine`, "gray")];
  const how = focused ? "" : " — Tab, then ↑↓";
  return [seg(`   +${hidden.length} more (${needLook} ${needLook === 1 ? "needs" : "need"} a look${how})`, "yellow")];
}

// ─── Totals ──────────────────────────────────────────────────────────────────

function totalsLine(data: HealthData): Seg[] {
  const out = data.totalOutputTokens ?? 0;
  const cacheTotal = data.totalCacheReadTokens + data.totalCacheCreationTokens + data.totalInputTokens;
  const segs: Seg[] = [
    seg(" TOTALS  ", undefined, { bold: true }),
    seg("requests "), seg(String(data.totalRequests), "cyan"),
    seg("  ·  ", "gray"), seg("errors "), seg(String(data.totalErrors), data.totalErrors > 0 ? "red" : "green"),
    seg("  ·  ", "gray"), seg("refreshes "), seg(String(data.totalRefreshes), "yellow"),
  ];
  if (cacheTotal > 0) {
    const hit = Math.round((data.totalCacheReadTokens / cacheTotal) * 100);
    segs.push(seg("  ·  ", "gray"), seg("cache "), seg(`${hit}% hit`, hit >= 70 ? "green" : hit >= 30 ? "yellow" : "red"));
  }
  const all = cacheTotal + out;
  if (all > 0) segs.push(seg("  ·  ", "gray"), seg("tokens "), seg(fmtTok(all), "cyan", { bold: true }));
  return segs;
}

// ─── Activity ────────────────────────────────────────────────────────────────

const LOG_NAME: Record<WidthTier, number> = { wide: 18, normal: 14, narrow: 10, tiny: 8 };
const LOG_WHAT: Record<WidthTier, number> = { wide: 16, normal: 12, narrow: 12, tiny: 0 };

export function logLine(
  log: LogEntry,
  selected: boolean,
  plan: Pick<LayoutPlan, "width" | "fit">,
): Seg[] {
  const time = new Date(log.ts).toLocaleTimeString("en-GB", { hour12: false });
  const isError = log.type === "error";
  const isRefresh = log.type === "refresh";
  const typeColor = isError ? "red" : isRefresh ? "yellow" : "gray";
  const typeIcon = isError ? "✗" : isRefresh ? "↻" : "→";
  const statusColor = log.statusCode === undefined ? undefined
    : log.statusCode >= 500 ? "red"
    : log.statusCode >= 400 ? "yellow"
    : log.statusCode >= 200 ? "green"
    : "gray";

  const showSource = plan.width === "wide" || plan.width === "normal";
  const sourceLabel = log.source === "cli" ? "cli" : log.source === "desktop" ? "dsk" : log.source === "api" ? "api" : "   ";
  const sourceColor = log.source === "cli" ? "blue" : log.source === "desktop" ? "magenta" : "gray";

  const inputTok = (log.cacheReadTokens ?? 0) + (log.cacheCreationTokens ?? 0) + (log.inputTokens ?? 0);
  const outputTok = log.outputTokens ?? 0;
  const cachePct = inputTok > 0 ? Math.round(((log.cacheReadTokens ?? 0) / inputTok) * 100) : null;
  const cacheColor = cachePct === null ? undefined : cachePct >= 70 ? "green" : cachePct >= 30 ? "yellow" : "red";

  const whatWidth = LOG_WHAT[plan.width];
  // Every route in practice is a POST, so the method is shown only when it is not.
  const what = log.method && log.path
    ? (log.method === "POST" ? terminalSafeText(log.path) : `${terminalSafeText(log.method)} ${terminalSafeText(log.path)}`)
    : terminalSafeText(log.type);

  const base: Seg[] = [
    seg(selected ? "▶ " : "  "),
    seg(time + "  "),
    seg(typeIcon + " ", typeColor),
    ...(showSource ? [seg(sourceLabel + " ", sourceColor)] : []),
    seg(padCells(terminalSafeText(log.accountId), LOG_NAME[plan.width]), "cyan"),
  ];

  // Optional pieces, in display order. When the line is too wide the least
  // useful go first (cache, tokens, duration); the path column and the status
  // code stay so rows keep lining up, and the details text, which is what an
  // error row exists to say, is cut last.
  const pieces: { key: string; segs: Seg[] }[] = [];
  if (whatWidth > 0) {
    pieces.push({ key: "what", segs: [seg(" " + padCells(what, whatWidth), log.method && log.path ? "white" : typeColor)] });
  }
  if (log.statusCode !== undefined) pieces.push({ key: "status", segs: [seg(` ${log.statusCode}`, statusColor)] });
  if (log.durationMs !== undefined) pieces.push({ key: "duration", segs: [seg(` ${log.durationMs}ms`, "gray")] });
  if (cachePct !== null) pieces.push({ key: "cache", segs: [seg(` ↑${cachePct}%`, cacheColor)] });
  if (inputTok > 0 || outputTok > 0) pieces.push({ key: "tokens", segs: [seg(` ${fmtTok(inputTok)}↑ ${fmtTok(outputTok)}↓`, "gray")] });
  if (log.details) pieces.push({ key: "details", segs: [seg("  " + terminalSafeText(log.details), "gray")] });

  const width = () => segsWidth(base) + pieces.reduce((n, p) => n + segsWidth(p.segs), 0);
  for (const drop of ["cache", "tokens", "duration"]) {
    if (width() <= plan.fit) break;
    const at = pieces.findIndex(p => p.key === drop);
    if (at >= 0) pieces.splice(at, 1);
  }

  let line = fitSegs([...base, ...pieces.flatMap(p => p.segs)], plan.fit);
  if (selected) line = line.map(s => ({ text: s.text, color: "black", bg: "white" }));
  return line;
}

// ─── Details ─────────────────────────────────────────────────────────────────

function field(label: string, value: string, color = "white"): Seg[] {
  return [seg(`${label}: `, "gray"), seg(terminalSafeText(value), color)];
}

export function detailLines(log: LogEntry, fit: number): Seg[][] {
  const time = new Date(log.ts).toLocaleString("en-GB", {
    hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const isError = log.type === "error";
  const statusLabel = log.statusCode === undefined ? "—"
    : log.statusCode === 0 ? "connection error"
    : `${log.statusCode} ${httpStatusText(log.statusCode)}`.trim();
  const statusColor = log.statusCode === undefined ? "gray"
    : log.statusCode === 0 || log.statusCode >= 500 ? "red"
    : log.statusCode >= 400 ? "yellow"
    : "green";
  const gap = seg("  ");

  const lines: Seg[][] = [
    [seg(" DETAILS ", isError ? "red" : "cyan", { bold: true }), ...field("Time", time), gap, ...field("Account", log.accountId)],
    [...field("Method", log.method ?? "—"), gap, ...field("Path", log.path ?? "—"), gap, ...field("Model", log.model || "—")],
    field("Session", log.sessionId ?? "—"),
    [...field("Status", statusLabel, statusColor), gap, ...field("Duration", log.durationMs !== undefined ? `${log.durationMs}ms` : "—"),
      gap, ...field("Type", log.type), gap, ...field("Source", sourceFullLabel(log.source))],
  ];
  if (log.details) lines.push(field("Details", log.details));

  const mode = usageDetailMode(log);
  if (mode === "cache") {
    const read = log.cacheReadTokens ?? 0;
    const created = log.cacheCreationTokens ?? 0;
    const input = log.inputTokens ?? 0;
    const output = log.outputTokens ?? 0;
    const totalIn = read + created + input;
    const hit = totalIn > 0 ? (read / totalIn) * 100 : 0;
    const hitColor = totalIn === 0 ? "gray" : hit >= 70 ? "green" : hit >= 30 ? "yellow" : "red";
    lines.push([
      ...field("Cache hit", totalIn > 0 ? `${fmtTok(read)} (${hit.toFixed(1)}%)` : "—", hitColor), gap,
      ...field("created", fmtTok(created)), gap, ...field("uncached", fmtTok(input)), gap,
      ...field("out", fmtTok(output)), gap, ...field("total", fmtTok(totalIn + output)),
    ]);
  } else if (mode === "basic") {
    const input = log.inputTokens ?? 0;
    const output = log.outputTokens ?? 0;
    lines.push([...field("Input", fmtTok(input)), gap, ...field("Output", fmtTok(output)), gap, ...field("Total", fmtTok(input + output))]);
  }

  // A fixed height, so the log above does not jump as the selection moves. The
  // title carries its own margin; the field lines are given the same one.
  const out = lines.slice(0, DETAILS_LINES).map((l, i) => fitSegs(i === 0 ? l : [seg(" "), ...l], fit));
  while (out.length < DETAILS_LINES) out.push([]);
  return out;
}

// ─── Models and operations ───────────────────────────────────────────────────

function modelLines(status: ModelsStatus | null, selected: number, focused: boolean, rows: number, fit: number): Seg[][] {
  const claude = status?.routing.anthropicDefaultModel ?? "default";
  const openai = status?.routing.openAIDefaultModel ?? "default";
  const title: Seg[] = [
    seg(" MODELS  ", undefined, { bold: true }),
    seg("claude=", "gray"), seg(claude, "white"), seg("  openai=", "gray"), seg(openai, "white"),
  ];
  const out: Seg[][] = [fitSegs(title, fit)];
  if (rows <= 0) return out;
  if (status === null) { out.push([seg("  Press [m] to load models from provider APIs", "gray")]); return out; }
  if (status.models.length === 0) { out.push([seg("  No models discovered", "gray")]); return out; }

  const listRows = Math.max(1, rows - 1);
  const visible = getVisibleModelWindow(status.models, selected, listRows);
  out.push([seg(`  showing ${visible.start + 1}-${visible.end} of ${status.models.length}`, "gray")]);
  visible.rows.forEach((model, i) => {
    const upstream = model.id.replace(/^anthropic\//, "").replace(/^openai\//, "");
    const isClaude = status.routing.anthropicDefaultModel === upstream || model.id === "claude/default";
    const isOpenAI = status.routing.openAIDefaultModel === upstream || model.id === "openai/default";
    const color = model.id.startsWith("openai/") ? "cyan" : model.id.startsWith("anthropic/") ? "magenta" : "gray";
    const isSel = focused && visible.start + i === selected;
    out.push(fitSegs([
      seg(isSel ? "▶" : " ", isSel ? "cyan" : undefined),
      seg(` ${terminalSafeText(model.id)}`, color),
      ...(isClaude ? [seg(" Claude", "green")] : isOpenAI ? [seg(" OpenAI", "green")] : []),
    ], fit));
  });
  return out;
}

function operationsLines(op: OperationalStatus, data: HealthData, baseUrl: string, fit: number): Seg[][] {
  const ready = (b: boolean) => seg(b ? "ready" : "needs OpenAI", b ? "green" : "gray");
  const provider = (label: string, p: OperationalStatus["providers"]["anthropic"], ok: boolean): Seg[] =>
    [seg(p.configured ? `${label} ${p.healthy}/${p.accounts} healthy` : `${label} not configured`, !p.configured ? "gray" : ok ? "green" : "yellow")];
  const lines: Seg[][] = [
    [seg(" OPERATIONS  ", undefined, { bold: true }), seg("base ", "gray"), seg(baseUrl, "cyan"),
      seg("  ·  auth ", "gray"), seg(op.auth.required ? "protected" : "open", op.auth.required ? "green" : "yellow"),
      seg("  ·  models ", "gray"), seg(op.capabilities.dynamicModels ? "dynamic" : "off", op.capabilities.dynamicModels ? "green" : "red")],
    [seg("  "), ...provider("Claude", op.providers.anthropic, op.capabilities.anthropicMessages), seg("  "),
      ...provider("OpenAI", op.providers.openai, op.capabilities.openAIResponses),
      seg("  ·  cross-route ", "gray"), ready(op.capabilities.crossProviderMessages)],
    [seg("  endpoints ", "gray"), seg([op.endpoints.messages, op.endpoints.responses, op.endpoints.models, op.endpoints.accounts].join(" "), "white")],
    [seg("  routing ", "gray"), seg(`claude=${op.routing.anthropicDefaultModel ?? "default"}`, "white"),
      seg(` aliases[${op.routing.anthropicAliases.join(",") || "-"}]  `, "gray"),
      seg(`openai=${op.routing.openAIDefaultModel ?? "default"}`, "white"),
      seg(` aliases[${op.routing.openAIAliases.join(",") || "-"}]`, "gray")],
    [seg("  proxy ", "gray"), seg(`${data.mode} → ${data.target}`, "white")],
  ];
  return lines.map(l => fitSegs(l, fit));
}

// ─── Footer: key hints, or the prompt or message that has taken their place ──

function hintLine(items: readonly string[], fit: number): Seg[] {
  const out: Seg[] = [seg(" ", "gray")];
  let used = 1;
  items.forEach((item, i) => {
    const text = (i === 0 ? "" : " · ") + item;
    const w = cellWidth(text);
    if (used + w > fit) return;
    out.push(seg(text, "gray"));
    used += w;
  });
  return out;
}

export interface Banner { text: string; color: string }

const HINTS: Record<Focus, readonly string[]> = {
  logs: ["q quit", "Tab focus", "↑↓ select", "Enter details", "m models", "n add account"],
  accounts: ["q quit", "Tab focus", "↑↓ select", "e on/off", "s 5h cap", "w 7d cap", "d delete", "a Claude all", "o OpenAI all", "n add"],
  models: ["q quit", "Esc back", "↑↓ select", "c Claude default", "o OpenAI default", "r refresh"],
};

// ─── The frame ───────────────────────────────────────────────────────────────

export interface FrameInput {
  data: HealthData;
  /** The router's verdict, when it sent one. Absent from an older router. */
  severity?: PoolSeverity;
  now: number;
  cols: number;
  rows: number;
  baseUrl: string;
  updatedAgoSec: number;
  focus: Focus;
  mode: Mode;
  editBuffer: string;
  selectedLogIndex: number;
  selectedAccountIndex: number;
  detailsOpen: boolean;
  modelsStatus: ModelsStatus | null;
  selectedModelIndex: number;
  banner: Banner | null;
}

export interface Frame {
  lines: Seg[][];
  plan: LayoutPlan;
}

export function buildFrame(input: FrameInput): Frame {
  const { data, now } = input;
  const region = input.focus === "models" ? "models" : "activity";
  const plan = planLayout({ rows: input.rows, cols: input.cols, accountCount: data.accounts.length, region, detailsOpen: input.detailsOpen });
  const sev = input.severity ?? computeSeverity(data.accounts, data.recentLogs, now);

  const lines: Seg[][] = [stripLine(sev, data, input.updatedAgoSec, plan.fit)];
  if (plan.minimal) return { lines, plan };

  // Accounts
  const byId = new Map(sev.accounts.map(s => [s.id, s] as const));
  const rungs: AccountRung[] = data.accounts.map(a => (byId.get(a.id) ?? computeSeverity([a], [], now).accounts[0]!).rung);
  const shown = pickAccounts(rungs, plan.accountRows, input.focus === "accounts", input.selectedAccountIndex);
  for (const i of shown) {
    const a = data.accounts[i]!;
    const s = byId.get(a.id) ?? computeSeverity([a], [], now).accounts[0]!;
    lines.push(accountLine(a, s, plan, input.focus === "accounts" && i === input.selectedAccountIndex, now, sev.thresholds));
  }
  if (plan.accountFold) lines.push(fitSegs(foldLine(rungs, shown, input.focus === "accounts"), plan.fit));

  if (plan.totals) lines.push(fitSegs(totalsLine(data), plan.fit));
  if (plan.operations && data.operational) {
    lines.push(...operationsLines(data.operational, data, input.baseUrl, plan.fit));
  }

  // Activity or models
  if (plan.regionTitle) {
    if (region === "models") {
      lines.push(...modelLines(input.modelsStatus, input.selectedModelIndex, true, plan.regionBody, plan.fit).slice(0, 1 + plan.regionBody));
    } else {
      lines.push([seg(" RECENT ACTIVITY", undefined, { bold: true })]);
      const visible = data.recentLogs.slice(0, plan.regionBody);
      if (visible.length === 0) lines.push([seg("  No activity yet", "gray")]);
      else visible.forEach((log, i) => lines.push(logLine(log, input.focus === "logs" && i === input.selectedLogIndex, plan)));
    }
  }
  if (plan.details) {
    const log = data.recentLogs[input.selectedLogIndex];
    if (log) lines.push(...detailLines(log, plan.fit));
    else for (let i = 0; i < DETAILS_LINES; i++) lines.push([]);
  }

  // Footer
  if (plan.footer) {
    const acct = data.accounts[input.selectedAccountIndex];
    let footer: Seg[];
    if (input.mode === "confirmDelete" && acct) {
      footer = [seg(` Delete "${terminalSafeText(acct.id)}"?  [y] yes  [n/Esc] cancel`, "red", { bold: true })];
    } else if ((input.mode === "editSession" || input.mode === "editWeekly") && acct) {
      footer = [
        seg(` Set ${input.mode === "editSession" ? "5h" : "7d"} cap for `, "cyan"), seg(terminalSafeText(acct.id), "white", { bold: true }),
        seg(" (0–100%): ", "cyan"), seg(input.editBuffer, "white", { bold: true }), seg("█  [Enter] save  [Esc] cancel", "gray"),
      ];
    } else if (input.banner) {
      footer = [seg(` ${input.banner.text}`, input.banner.color)];
    } else if (plan.detailsSuppressed) {
      footer = [seg(" This pane is too short for details; make it taller to open them", "yellow")];
    } else {
      footer = hintLine(HINTS[input.focus], plan.fit);
    }
    lines.push(fitSegs(footer, plan.fit));
  }

  // The plan's count is the contract; this only guards against a builder bug
  // becoming a frame that scrolls the strip away.
  return { lines: lines.slice(0, plan.budget).map(l => fitSegs(l, plan.fit)), plan };
}

export { truncateCells };
