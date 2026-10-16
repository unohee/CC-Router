/**
 * One definition of "is anything wrong right now?" for every status surface.
 *
 * The terminal dashboard and the web page both used to decide this on their own,
 * with different cut-offs (70/90 % in one, 75/90 % in the other) and different
 * ideas of what counts as trouble, so the two could disagree about the same
 * pool. This module is the only place the rules live. The router computes the
 * result into `/cc-router/health`; the terminal dashboard falls back to calling
 * it directly when it talks to a router old enough not to send one.
 *
 * It is pure (no clock, no I/O of its own) so the rules can be tested exactly.
 */

/** A pool, or an account that is serving, is in exactly one of these. */
export type Rung = "ok" | "watch" | "problem";
/** An account the operator switched off is not a problem; it is simply not serving. */
export type AccountRung = Rung | "off";

export type AccountState =
  | "off"
  | "expired"
  | "cooling"
  | "limited"
  | "unhealthy"
  | "near"
  | "hot"
  | "ok";

/** Quota use at which an account is called out (watch) and at which it is a problem. */
export const WATCH_AT = 0.8;
export const PROBLEM_AT = 0.95;
/** This many upstream 429s inside the window is a problem in its own right. */
export const BURST_COUNT = 3;
export const BURST_WINDOW_MS = 5 * 60_000;

/** What severity needs to know about a window of quota use; a subset of the health view. */
export interface SeverityRateLimits {
  status?: string;
  fiveHourUtil?: number;
  fiveHourReset?: number;
  sevenDayUtil?: number;
  sevenDayReset?: number;
  lastUpdated?: number;
}

export interface SeverityAccountInput {
  id: string;
  enabled?: boolean;
  healthy: boolean;
  coolingUntil?: number;
  modelCooldowns?: Record<string, number>;
  expiresInMs?: number;
  rateLimits?: SeverityRateLimits;
}

export interface SeverityLogInput {
  ts: number;
  type: string;
  statusCode?: number;
}

export interface AccountSeverity {
  id: string;
  rung: AccountRung;
  state: AccountState;
  /** Epoch ms at which the last cooldown ends. Set only when `state` is "cooling". */
  until?: number;
  /** What is cooling: model families, or "" when the whole account is. */
  scope?: string;
  /** The window that is hottest, and how full it is (1 = full). Set for "near" and "hot". */
  window?: "5h" | "7d";
  util?: number;
}

export interface PoolSeverity {
  pool: Rung;
  /** The verdict in words: "All 5 accounts healthy", "Watch" or "Problem". The reasons follow it. */
  headline: string;
  /** Why the pool is not "ok", worst first. Empty when it is. */
  reasons: string[];
  /** Upstream 429s inside `BURST_WINDOW_MS`. */
  recent429s: number;
  accounts: AccountSeverity[];
  /** Echoed so a client colours its meters with the same cut-offs, not its own copy. */
  thresholds: { watch: number; problem: number };
}

export type WindowKey = "fiveHour" | "sevenDay";

export type WindowReading =
  | { ok: true; util: number; reset: number }
  | { ok: false; note: "not measured yet" | "no reading" | "reset since last reading" };

/**
 * A usage figure is only a reading if it has a window to belong to. Three
 * states look like "0 %" and are not: the account has served nothing since the
 * router started; upstream reported no figure and no reset time (or the router
 * already rolled the window over, which zeroes both); or the reset time is
 * already in the past. None of them may be thresholded, or shown, as a number.
 */
export function windowReading(
  rl: SeverityRateLimits | undefined,
  key: WindowKey,
  now: number,
): WindowReading {
  if (!rl || !rl.lastUpdated) return { ok: false, note: "not measured yet" };
  const util = (key === "fiveHour" ? rl.fiveHourUtil : rl.sevenDayUtil) || 0;
  const reset = (key === "fiveHour" ? rl.fiveHourReset : rl.sevenDayReset) || 0;
  if (reset <= 0 && util <= 0) return { ok: false, note: "no reading" };
  if (reset > 0 && reset * 1000 <= now) return { ok: false, note: "reset since last reading" };
  return { ok: true, util, reset };
}

/** "4m", "2h36m", "1d3h"; seconds below a minute, because a cooldown can be that short. */
export function formatRemaining(ms: number): string {
  // Floored, like every other countdown on these surfaces, so "4m" never reads 3m59s as 4.
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function severityOfUtil(util: number): Rung {
  if (util >= PROBLEM_AT) return "problem";
  if (util >= WATCH_AT) return "watch";
  return "ok";
}

function assessAccount(a: SeverityAccountInput, now: number): AccountSeverity {
  const id = a.id;
  if (a.enabled === false) return { id, rung: "off", state: "off" };
  if (typeof a.expiresInMs === "number" && a.expiresInMs <= 0) {
    return { id, rung: "problem", state: "expired" };
  }

  if (typeof a.coolingUntil === "number" && a.coolingUntil > now) {
    return { id, rung: "problem", state: "cooling", until: a.coolingUntil, scope: "" };
  }
  const cooling = Object.entries(a.modelCooldowns ?? {}).filter(
    ([, until]) => typeof until === "number" && until > now,
  );
  if (cooling.length > 0) {
    return {
      id,
      rung: "problem",
      state: "cooling",
      until: Math.max(...cooling.map(([, until]) => until)),
      scope: cooling.map(([family]) => family).join(", "),
    };
  }

  if (a.rateLimits?.status === "rate_limited") return { id, rung: "problem", state: "limited" };
  if (!a.healthy) return { id, rung: "problem", state: "unhealthy" };

  // The hotter of the two windows decides, and only a real reading counts.
  let hottest: { window: "5h" | "7d"; util: number } | null = null;
  for (const [key, window] of [["fiveHour", "5h"], ["sevenDay", "7d"]] as const) {
    const r = windowReading(a.rateLimits, key, now);
    if (r.ok && (hottest === null || r.util > hottest.util)) hottest = { window, util: r.util };
  }
  if (hottest) {
    const rung = severityOfUtil(hottest.util);
    if (rung === "problem") return { id, rung, state: "near", ...hottest };
    if (rung === "watch") return { id, rung, state: "hot", ...hottest };
  }
  return { id, rung: "ok", state: "ok" };
}

function reasonOf(s: AccountSeverity, now: number): string {
  switch (s.state) {
    case "expired": return `${s.id} token expired`;
    case "cooling": {
      const scope = s.scope ? `${s.scope} ` : "";
      return `${s.id} ${scope}cooling ${formatRemaining((s.until ?? now) - now)}`;
    }
    case "limited": return `${s.id} rate limited`;
    case "unhealthy": return `${s.id} unhealthy`;
    case "near":
    case "hot": {
      const pct = Math.round((s.util ?? 0) * 100);
      return (s.util ?? 0) >= 1 ? `${s.id} ${s.window} at limit` : `${s.id} ${s.window} ${pct}%`;
    }
    default: return s.id;
  }
}

/** Upstream rejections inside the burst window. A 429 the router raised itself to hold a session is not one. */
export function countRecent429s(logs: readonly SeverityLogInput[], now: number): number {
  let n = 0;
  for (const l of logs) {
    if (l.statusCode === 429 && l.type === "error" && l.ts <= now && now - l.ts <= BURST_WINDOW_MS) n++;
  }
  return n;
}

export function computeSeverity(
  accounts: readonly SeverityAccountInput[],
  logs: readonly SeverityLogInput[],
  now: number,
): PoolSeverity {
  const assessed = accounts.map(a => assessAccount(a, now));
  const recent429s = countRecent429s(logs, now);
  const thresholds = { watch: WATCH_AT, problem: PROBLEM_AT };
  const result = (pool: Rung, reasons: string[]): PoolSeverity => ({
    pool, headline: headlineOf(pool, assessed), reasons, recent429s, accounts: assessed, thresholds,
  });

  if (assessed.length === 0) return result("problem", ["no accounts configured"]);
  if (assessed.every(s => s.rung === "off")) return result("problem", ["every account is off"]);

  const reasons: string[] = [
    ...assessed.filter(s => s.rung === "problem").map(s => reasonOf(s, now)),
    ...(recent429s >= BURST_COUNT ? [`429 ×${recent429s} in ${BURST_WINDOW_MS / 60_000}m`] : []),
    ...assessed.filter(s => s.rung === "watch").map(s => reasonOf(s, now)),
  ];
  const pool: Rung = assessed.some(s => s.rung === "problem") || recent429s >= BURST_COUNT
    ? "problem"
    : assessed.some(s => s.rung === "watch") ? "watch" : "ok";
  return result(pool, reasons);
}

function headlineOf(pool: Rung, accounts: readonly AccountSeverity[]): string {
  if (pool === "problem") return "Problem";
  if (pool === "watch") return "Watch";
  const serving = accounts.filter(a => a.rung !== "off").length;
  const off = accounts.length - serving;
  return `All ${serving} ${serving === 1 ? "account" : "accounts"} healthy${off > 0 ? ` · ${off} off` : ""}`;
}

/** One line for the strip: the headline, then the reasons worst first. The same words on both surfaces. */
export function describeSeverity(s: PoolSeverity): string {
  return s.pool === "ok" ? s.headline : `${s.headline} — ${s.reasons.join(" · ")}`;
}
