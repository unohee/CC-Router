/**
 * The router's answer to "can we afford Ollama Cloud today?": a daily budget
 * measured from the monthly balance the quota monitor already polls.
 *
 * Ollama publishes balance, allowance and period end — no per-request bill
 * this router can trust beyond the provider's own meter. So spending is the
 * balance going down: when includedUsd falls between two quota readings, that
 * delta is today's spend. (If the account is shared, other consumers' spending
 * is charged to this router's day as if it were ours — the safe direction.)
 *
 * The day rolls in the configured time zone (default: the router's own zone).
 * Today's allowance is the remaining monthly credit spread evenly over the
 * budget days left in the period, so a running-low month slows down rather
 * than stopping outright. `reserveUsd` is a hard floor that stops Ollama
 * regardless of today's allowance.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface OllamaDailyBudgetConfig {
  /** Opt in. Absent keeps Ollama gating out of the decision entirely. */
  enabled?: boolean;
  /** Monthly included allowance, e.g. 300. */
  monthlyUsd?: number;
  /** The time zone the budget day resets in. Default: the router's own zone. */
  tz?: string;
  /** Stop serving while the remaining balance is at or below this. Default 0. */
  reserveUsd?: number;
}

export interface ResolvedOllamaDailyBudgetConfig {
  monthlyUsd: number;
  tz: string | undefined;
  reserveUsd: number;
}

export function resolveOllamaDailyBudgetConfig(
  raw: OllamaDailyBudgetConfig | undefined,
): ResolvedOllamaDailyBudgetConfig | null {
  if (!raw || raw.enabled !== true) return null;
  // Enabled without a positive monthly figure resolves to off, never free.
  const monthly = typeof raw.monthlyUsd === "number" && Number.isFinite(raw.monthlyUsd) && raw.monthlyUsd > 0
    ? raw.monthlyUsd : 0;
  if (monthly === 0) return null;
  const reserve = typeof raw.reserveUsd === "number" && Number.isFinite(raw.reserveUsd) && raw.reserveUsd >= 0
    ? raw.reserveUsd : 0;
  let tz: string | undefined;
  if (typeof raw.tz === "string" && raw.tz.trim()) {
    try { new Intl.DateTimeFormat("en-CA", { timeZone: raw.tz }); tz = raw.tz; } catch { /* bad zone: local zone */ }
  }
  return { monthlyUsd: monthly, tz, reserveUsd: reserve };
}

export interface OllamaBudgetBalance {
  /** Remaining monthly included credit. */
  includedUsd: number;
  /** Period end, epoch ms: same period => same resetsAt. */
  resetsAt: number;
  /** When the reading was taken, epoch ms. */
  checkedAt: number;
}

export type OllamaBudgetReason = "ok" | "budget-exhausted" | "reserve-exhausted" | "balance-unknown";

export interface OllamaBudgetVerdict {
  allow: boolean;
  reason: OllamaBudgetReason;
  /** Today's allowance in USD, null while no balance reading exists. */
  budgetUsd: number | null;
  spentUsd: number;
  /** What is left of today's allowance in USD. */
  remainingUsd: number | null;
  /** The budget day (YYYY-MM-DD), in the configured zone. */
  day: string;
}

const DAY_MS = 86_400_000;

/** The calendar day `ms` falls in, in the configured or local zone. */
export function dayString(ms: number, tz: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-CA", tz ? { timeZone: tz } : undefined).formatToParts(ms);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function roundCents(n: number): number { return Math.round(n * 100) / 100; }
function clampUsd(n: number): number { return Math.min(10_000, Math.max(0, n)); }

export class OllamaDailyBudget {
  private readonly now: () => number;
  private readonly cfg: ResolvedOllamaDailyBudgetConfig;
  private readonly statePath: string | undefined;
  private day: string;
  private spentUsd = 0;
  private lastReading: OllamaBudgetBalance | null = null;

  constructor(opts: {
    config: ResolvedOllamaDailyBudgetConfig;
    statePath?: string;
    now?: () => number;
  }) {
    this.cfg = opts.config;
    this.now = opts.now ?? Date.now;
    this.statePath = opts.statePath;
    this.day = dayString(this.now(), this.cfg.tz);
    if (this.statePath) this.restore();
  }

  /**
   * Whether Ollama may serve right now. `balance` is the latest reading the
   * caller already has — deciding must never wait for the cloud. The
   * balance-unknown case refuses: the guard's purpose is a cap it cannot check.
   */
  verdict(balance: OllamaBudgetBalance | null): OllamaBudgetVerdict {
    this.roll();
    if (!balance) return this.report(false, "balance-unknown", null, null);
    if (balance.includedUsd <= this.cfg.reserveUsd) {
      return this.report(false, "reserve-exhausted", null, 0);
    }
    const budget = this.todayAllowance(balance);
    const remaining = budget - this.spentUsd;
    return remaining > 0
      ? this.report(true, "ok", budget, remaining)
      : this.report(false, "budget-exhausted", budget, Math.max(0, remaining));
  }

  /**
   * The freshest balance the caller has. When it is lower than the last
   * reading for the same period, the difference counts against today's
   * allowance. A refill (higher balance) or a new period counts nothing.
   * Called on every served request and at boot; cheap either way.
   */
  observe(balance: OllamaBudgetBalance | null): void {
    this.roll();
    if (!balance) return;
    const prev = this.lastReading;
    this.lastReading = balance;
    if (!prev || prev.resetsAt !== balance.resetsAt) return;
    const drop = prev.includedUsd - balance.includedUsd;
    if (drop <= 0) return;
    this.spentUsd = roundCents(this.spentUsd + clampUsd(drop));
    this.flush();
  }

  /** Today's allowance: remaining credit spread over the budget days left. */
  private todayAllowance(balance: OllamaBudgetBalance): number {
    const resetDay = dayString(balance.resetsAt, this.cfg.tz);
    // Whole days from now until the period ends, then rounded up to include
    // the partial last day. When the reset falls inside today, today counts
    // as one whole budget day.
    const daysLeft = resetDay === this.day ? 1
      : Math.max(1, Math.ceil((balance.resetsAt - this.now()) / DAY_MS));
    return roundCents(Math.max(0, balance.includedUsd) / daysLeft);
  }

  private roll(): void {
    const today = dayString(this.now(), this.cfg.tz);
    if (today === this.day) return;
    this.day = today;
    this.spentUsd = 0;
    this.flush();
  }

  private report(allow: boolean, reason: OllamaBudgetReason, budgetUsd: number | null, remainingUsd: number | null): OllamaBudgetVerdict {
    return { allow, reason, budgetUsd, spentUsd: roundCents(this.spentUsd), remainingUsd, day: this.day };
  }

  private restore(): void {
    try {
      if (!existsSync(this.statePath!)) return;
      const raw = JSON.parse(readFileSync(this.statePath!, "utf-8")) as { day?: unknown; spentUsd?: unknown };
      if (typeof raw.day === "string" && raw.day === this.day
          && typeof raw.spentUsd === "number" && Number.isFinite(raw.spentUsd) && raw.spentUsd >= 0) {
        this.spentUsd = clampUsd(raw.spentUsd);
      }
    } catch { /* corrupt state costs one day of budget, never a crash */ }
  }

  private flush(): void {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = this.statePath + ".tmp";
      writeFileSync(tmp, JSON.stringify({ version: 1, day: this.day, spentUsd: this.spentUsd }), "utf-8");
      renameSync(tmp, this.statePath);
    } catch { /* losing the snapshot understates spend, never overstates */ }
  }
}
