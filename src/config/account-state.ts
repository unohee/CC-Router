/**
 * Runtime account state that must survive a restart: cooldowns and the last
 * rate-limit reading.
 *
 * accounts.json holds credentials and settings, and `serialize` deliberately
 * leaves runtime fields out. So a restarted router used to see every account
 * as fresh: it sent the next request to an account still cooling from a 429,
 * or to one whose weekly window was spent, and learned it only from the
 * upstream's refusal. This file keeps that knowledge, written whole and
 * atomically (mode 0600, beside accounts.json) like the history files.
 *
 * Restoring drops whatever has expired: a cooldown past its deadline, a model
 * cooldown past its own, a window whose reset has passed, and a reading too old
 * to say anything.
 */

import type { Account, AccountRateLimits } from "../proxy/types.js";

/** A reading older than this says nothing about the account any more. */
export const MAX_READING_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AccountStateEntry {
  coolingUntil?: number;
  modelCooldowns?: Record<string, number>;
  rateLimits?: AccountRateLimits;
  sevenDayWindowSeen?: boolean;
}

export interface AccountStateFile {
  version: 1;
  savedAt: number;
  accounts: Record<string, AccountStateEntry>;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** What to save for these accounts at `now`: only state that is still live. */
export function snapshotAccountState(accounts: ReadonlyArray<Account>, now: number): AccountStateFile {
  const out: Record<string, AccountStateEntry> = {};
  for (const a of accounts) {
    const e: AccountStateEntry = {};
    if (finite(a.coolingUntil) && a.coolingUntil > now) e.coolingUntil = a.coolingUntil;
    const models = Object.entries(a.modelCooldowns ?? {}).filter(([, until]) => finite(until) && until > now);
    if (models.length > 0) e.modelCooldowns = Object.fromEntries(models);
    if (a.rateLimits.lastUpdated > 0) e.rateLimits = { ...a.rateLimits };
    if (a.sevenDayWindowSeen) e.sevenDayWindowSeen = true;
    if (Object.keys(e).length > 0) out[a.id] = e;
  }
  return { version: 1, savedAt: now, accounts: out };
}

/** A saved reading, cleaned: null when it is unusable or too old. Expired windows are zeroed. */
function restoreReading(raw: unknown, now: number): AccountRateLimits | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const lastUpdated = r["lastUpdated"];
  if (!finite(lastUpdated) || lastUpdated <= 0 || lastUpdated > now || now - lastUpdated > MAX_READING_AGE_MS) return null;
  const util = (v: unknown) => (finite(v) && v >= 0 && v <= 10 ? v : 0);
  const reset = (v: unknown) => (finite(v) && v > 0 ? Math.floor(v) : 0);
  const status = r["status"] === "allowed" || r["status"] === "rate_limited" ? r["status"] : "unknown";
  const nowSec = Math.floor(now / 1000);
  let fiveHourUtil = util(r["fiveHourUtil"]), fiveHourReset = reset(r["fiveHourReset"]);
  let sevenDayUtil = util(r["sevenDayUtil"]), sevenDayReset = reset(r["sevenDayReset"]);
  if (fiveHourReset > 0 && fiveHourReset <= nowSec) { fiveHourUtil = 0; fiveHourReset = 0; }
  if (sevenDayReset > 0 && sevenDayReset <= nowSec) { sevenDayUtil = 0; sevenDayReset = 0; }
  const claim = typeof r["claim"] === "string" ? r["claim"].slice(0, 64) : "";
  // A rate_limited reading whose limiting window has rolled over is no longer
  // limited (the same rule the pool applies when it sweeps).
  const stillLimited = status === "rate_limited" && (
    (claim === "five_hour" && fiveHourReset > 0) || (claim === "seven_day" && sevenDayReset > 0)
    || (claim !== "five_hour" && claim !== "seven_day" && (fiveHourReset > 0 || sevenDayReset > 0)));
  return {
    status: status === "rate_limited" && !stillLimited ? "allowed" : status,
    fiveHourUtil, fiveHourReset, sevenDayUtil, sevenDayReset, claim,
    plan: typeof r["plan"] === "string" ? r["plan"].slice(0, 32) : "",
    requestsLimit: finite(r["requestsLimit"]) && r["requestsLimit"] >= 0 ? r["requestsLimit"] : 0,
    lastUpdated,
  };
}

export interface RestoreSummary {
  /** Accounts that came back cooling (account-wide or for a model). */
  cooling: string[];
  /** Accounts whose last rate-limit reading came back. */
  readings: string[];
}

/**
 * Apply a saved file to the loaded accounts, in place. Entries for accounts no
 * longer configured are ignored, as is anything malformed or expired. A live
 * value already on the account (there should be none at startup) is kept when
 * it is later than the saved one.
 */
export function restoreAccountState(accounts: ReadonlyArray<Account>, raw: unknown, now: number): RestoreSummary {
  const summary: RestoreSummary = { cooling: [], readings: [] };
  if (typeof raw !== "object" || raw === null) return summary;
  const file = raw as { version?: unknown; accounts?: unknown };
  if (file.version !== 1 || typeof file.accounts !== "object" || file.accounts === null) return summary;
  const saved = file.accounts as Record<string, unknown>;
  for (const a of accounts) {
    if (!Object.prototype.hasOwnProperty.call(saved, a.id)) continue;
    const e = saved[a.id];
    if (typeof e !== "object" || e === null) continue;
    const entry = e as Record<string, unknown>;
    let cooling = false;
    const until = entry["coolingUntil"];
    if (finite(until) && until > now) {
      a.coolingUntil = Math.max(a.coolingUntil ?? 0, until);
      cooling = true;
    }
    const models = entry["modelCooldowns"];
    if (typeof models === "object" && models !== null) {
      for (const [key, value] of Object.entries(models as Record<string, unknown>)) {
        if (!finite(value) || value <= now || key.length > 64) continue;
        a.modelCooldowns ??= {};
        a.modelCooldowns[key] = Math.max(a.modelCooldowns[key] ?? 0, value);
        cooling = true;
      }
    }
    const reading = restoreReading(entry["rateLimits"], now);
    if (reading && reading.lastUpdated > a.rateLimits.lastUpdated) {
      a.rateLimits = reading;
      summary.readings.push(a.id);
    }
    if (entry["sevenDayWindowSeen"] === true) a.sevenDayWindowSeen = true;
    if (cooling) summary.cooling.push(a.id);
  }
  return summary;
}
