/**
 * Per-account quota readings over time: each Anthropic account's 5-hour and
 * 7-day utilization and reset times, sampled at most once per hour.
 *
 * The live pool only knows the latest reading. Estimating how many tokens one
 * percent of a window buys (the supply model) needs the readings next to the
 * hourly token history, so they are kept here with the same 92-day retention.
 *
 * A separate store from usage-history.ts: those rows are keyed per model and
 * aggregate the pool, these are keyed per account. Mixing the two shapes in one
 * file would break the usage file's compatibility for little gain.
 */

import { HOUR_MS, DAY_MS, RETENTION_DAYS } from "./usage-history.js";

/** Distinct accounts kept; readings for further accounts are dropped. */
export const MAX_QUOTA_ACCOUNTS = 64;

export interface QuotaWindowReading {
  /** 0..1 as upstream reports it (it can run slightly past 1). */
  util: number;
  /** Unix seconds; 0 when upstream named no reset. */
  resetAt: number;
}

export interface QuotaReading {
  /** Start of the hour the reading belongs to, epoch ms. */
  hour: number;
  accountId: string;
  /** When the reading was taken, epoch ms. */
  sampledAt: number;
  fiveHour: QuotaWindowReading;
  sevenDay: QuotaWindowReading;
}

/** What the proxy hands in from a response's rate-limit headers. */
export interface QuotaInput {
  fiveHourUtil: number;
  fiveHourReset: number;
  sevenDayUtil: number;
  sevenDayReset: number;
}

/** On-disk shape. Rows are tuples to keep the file small. */
export interface QuotaFile {
  version: 1;
  rows: Array<[
    hourSec: number, accountId: string, sampledAtSec: number,
    fiveHourUtil: number, fiveHourResetSec: number, sevenDayUtil: number, sevenDayResetSec: number,
  ]>;
}

/** An account id safe to key on and print; null for anything else. */
export function sanitizeAccountId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id.length > 0 && id.length <= 128 && /^[\x21-\x7e]+$/.test(id) ? id : null;
}

/** A utilization worth storing: finite, 0..10 (well past any real overshoot). */
function utilOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10 ? v : null;
}

/** A reset time worth storing: finite, non-negative, whole seconds. */
function resetOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

export interface QuotaHistoryOptions {
  now?: () => number;
  retentionDays?: number;
  maxAccounts?: number;
}

export class QuotaHistory {
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxAccounts: number;
  // Keyed `${hour}|${accountId}`; a Map because account ids are data.
  private readonly byKey = new Map<string, QuotaReading>();
  private readonly accounts = new Set<string>();
  private isDirty = false;
  private lastPruneHour = -Infinity;

  constructor(opts: QuotaHistoryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.retentionMs = (opts.retentionDays ?? RETENTION_DAYS) * DAY_MS;
    this.maxAccounts = opts.maxAccounts ?? MAX_QUOTA_ACCOUNTS;
  }

  get dirty(): boolean { return this.isDirty; }

  /**
   * Take a reading unless this account already has one for the current hour.
   * True when it was stored.
   *
   * The first reading of the hour is kept, not the latest: a reading is taken
   * on every upstream response, and replacing it each time would rewrite the
   * file all day for no better estimate. `sampledAt` says where in the hour it
   * fell, which is what pairing it with token usage needs.
   *
   * A reading with no window at all (no utilization, no resets) is not stored:
   * it would read as "0% used" when it means "not measured".
   */
  sample(accountId: unknown, rl: QuotaInput, at: number = this.now()): boolean {
    const id = sanitizeAccountId(accountId);
    if (id === null) return false;
    const fiveUtil = utilOf(rl.fiveHourUtil), fiveReset = resetOf(rl.fiveHourReset);
    const sevenUtil = utilOf(rl.sevenDayUtil), sevenReset = resetOf(rl.sevenDayReset);
    if (fiveUtil === null || fiveReset === null || sevenUtil === null || sevenReset === null) return false;
    if (fiveUtil === 0 && fiveReset === 0 && sevenUtil === 0 && sevenReset === 0) return false;

    const now = this.now();
    const ts = Number.isFinite(at) ? Math.min(at, now) : now;
    if (ts <= now - this.retentionMs) return false;
    const hour = Math.floor(ts / HOUR_MS) * HOUR_MS;
    const key = `${hour}|${id}`;
    if (this.byKey.has(key)) return false;
    if (!this.accounts.has(id) && this.accounts.size >= this.maxAccounts) return false;

    this.byKey.set(key, {
      hour, accountId: id, sampledAt: ts,
      fiveHour: { util: fiveUtil, resetAt: fiveReset },
      sevenDay: { util: sevenUtil, resetAt: sevenReset },
    });
    this.accounts.add(id);
    this.isDirty = true;
    if (hour > this.lastPruneHour) this.prune();
    return true;
  }

  /** Copies, oldest first, then by account id. */
  readings(): QuotaReading[] {
    return [...this.byKey.values()]
      .sort((a, b) => a.hour - b.hour || (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0))
      .map(r => ({ ...r, fiveHour: { ...r.fiveHour }, sevenDay: { ...r.sevenDay } }));
  }

  /** Drop readings that have aged out. Returns how many went. */
  prune(): number {
    const now = this.now();
    this.lastPruneHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const cutoff = now - this.retentionMs;
    let removed = 0;
    for (const [key, r] of this.byKey) {
      if (r.hour + HOUR_MS <= cutoff) { this.byKey.delete(key); removed++; }
    }
    if (removed > 0) {
      this.accounts.clear();
      for (const r of this.byKey.values()) this.accounts.add(r.accountId);
      this.isDirty = true;
    }
    return removed;
  }

  toFile(): QuotaFile {
    return {
      version: 1,
      rows: this.readings().map(r => [
        r.hour / 1000, r.accountId, Math.floor(r.sampledAt / 1000),
        r.fiveHour.util, r.fiveHour.resetAt, r.sevenDay.util, r.sevenDay.resetAt,
      ]),
    };
  }

  /** Call only after the snapshot reached disk; a failed write must stay dirty. */
  markClean(): void { this.isDirty = false; }

  /**
   * Merge a file into the store. False when it is not a quota file at all, in
   * which case nothing was taken. Malformed rows are skipped one by one; a
   * reading already held for the same hour and account is kept.
   */
  restore(raw: unknown): boolean {
    if (typeof raw !== "object" || raw === null) return false;
    const file = raw as { version?: unknown; rows?: unknown };
    if (file.version !== 1 || !Array.isArray(file.rows)) return false;
    for (const row of file.rows as unknown[]) {
      if (!Array.isArray(row) || row.length !== 7) continue;
      const [hourSec, accountId, sampledAtSec, fiveUtil, fiveReset, sevenUtil, sevenReset] = row as unknown[];
      const id = sanitizeAccountId(accountId);
      if (id === null || typeof hourSec !== "number" || !Number.isFinite(hourSec)) continue;
      if (typeof sampledAtSec !== "number" || !Number.isFinite(sampledAtSec)) continue;
      const fu = utilOf(fiveUtil), fr = resetOf(fiveReset), su = utilOf(sevenUtil), sr = resetOf(sevenReset);
      if (fu === null || fr === null || su === null || sr === null) continue;
      const hour = Math.floor(hourSec * 1000 / HOUR_MS) * HOUR_MS;
      const key = `${hour}|${id}`;
      if (this.byKey.has(key)) continue;
      if (!this.accounts.has(id) && this.accounts.size >= this.maxAccounts) continue;
      // A sample time outside its own hour is clamped into it.
      const sampledAt = Math.min(Math.max(sampledAtSec * 1000, hour), hour + HOUR_MS - 1);
      this.byKey.set(key, { hour, accountId: id, sampledAt, fiveHour: { util: fu, resetAt: fr }, sevenDay: { util: su, resetAt: sr } });
      this.accounts.add(id);
    }
    // As in usage-history: what was merged is on disk already, so the dirty flag
    // is left to whatever was recorded before the merge.
    this.prune();
    return true;
  }
}

export const QUOTA_HISTORY_DEFAULT_DAYS = 7;

export interface QuotaHistoryView {
  generatedAt: number;
  retentionDays: number;
  days: number;
  accounts: Array<{ id: string; readings: Array<Omit<QuotaReading, "accountId">> }>;
}

/** `?days=` as a whole number of days within the retention; the default otherwise. */
export function parseQuotaDays(raw: unknown, retentionDays: number = RETENTION_DAYS): number {
  const n = typeof raw === "string" && /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(n, retentionDays) : QUOTA_HISTORY_DEFAULT_DAYS;
}

/** The readings of the last `days` days, grouped by account. */
export function quotaHistoryView(src: QuotaHistory, opts: { now: number; days: number; retentionDays?: number }): QuotaHistoryView {
  const from = opts.now - opts.days * DAY_MS;
  const grouped = new Map<string, QuotaHistoryView["accounts"][number]["readings"]>();
  for (const r of src.readings()) {
    if (r.hour + HOUR_MS <= from || r.hour > opts.now) continue;
    const list = grouped.get(r.accountId) ?? [];
    list.push({ hour: r.hour, sampledAt: r.sampledAt, fiveHour: r.fiveHour, sevenDay: r.sevenDay });
    grouped.set(r.accountId, list);
  }
  return {
    generatedAt: opts.now,
    retentionDays: opts.retentionDays ?? RETENTION_DAYS,
    days: opts.days,
    accounts: [...grouped.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, readings]) => ({ id, readings })),
  };
}

/** The process-wide store the proxy samples into. */
export const quotaHistory = new QuotaHistory();
