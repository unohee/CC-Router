import type { AccountRateLimits } from "../../proxy/types.js";
import { codexLimitsFromWindows, type CodexWindow } from "./rate-limits.js";
import type { OpenAISubscriptionAccount } from "./token-refresher.js";

/**
 * The endpoint the Codex CLI's `/status` reads. A plain GET: it reports quota
 * without spending any.
 */
export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const PROBE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Response headers are otherwise the only source of Codex quota, and they only
 * arrive when the account serves a request. An exhausted account is never
 * picked, so its reading can never change: measured 2026-10-29, the router held
 * a 7-day window at 100% for 28 hours after OpenAI had reset it early to 25%,
 * and the dashboard kept the account "rate limited" with four days still on the
 * stale reset clock. Polling this endpoint is the way back.
 */

interface UsageWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_after_seconds?: unknown;
  reset_at?: unknown;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toWindow(raw: unknown, nowSec: number): CodexWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as UsageWindow;
  const seconds = num(w.limit_window_seconds);
  const usedPercent = num(w.used_percent);
  if (seconds === null || seconds <= 0 || usedPercent === null) return null;
  const resetAt = num(w.reset_at);
  const resetAfter = num(w.reset_after_seconds);
  return {
    minutes: seconds / 60,
    usedPercent,
    reset: resetAt ?? (resetAfter !== null ? nowSec + resetAfter : 0),
  };
}

/** Parse a `wham/usage` body into the router's quota shape. Null when it carries no quota. */
export function parseCodexUsage(body: unknown): AccountRateLimits | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { plan_type?: unknown; rate_limit?: unknown };
  if (!b.rate_limit || typeof b.rate_limit !== "object") return null;
  const rl = b.rate_limit as {
    allowed?: unknown; limit_reached?: unknown; primary_window?: unknown; secondary_window?: unknown;
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const windows = [rl.primary_window, rl.secondary_window]
    .map(w => toWindow(w, nowSec))
    .filter((w): w is CodexWindow => w !== null);
  // Unlike headers, this endpoint states the verdict outright.
  const limitReached = rl.limit_reached === true || rl.allowed === false;
  return codexLimitsFromWindows(windows, typeof b.plan_type === "string" ? b.plan_type : "", limitReached);
}

/**
 * Re-read one account's quota. Leaves the reading untouched on any failure:
 * a stale figure is still better than none, and the next probe retries.
 */
export async function probeCodexUsage(
  account: OpenAISubscriptionAccount,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(CODEX_USAGE_ENDPOINT, {
      headers: { authorization: `Bearer ${account.accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const limits = parseCodexUsage(await res.json());
    if (!limits) return false;
    account.rateLimits = limits;
    return true;
  } catch {
    return false;
  }
}

/** True when the account's reading is older than one probe interval, or absent. */
export function codexUsageIsStale(account: OpenAISubscriptionAccount, now = Date.now()): boolean {
  const last = account.rateLimits?.lastUpdated ?? 0;
  return now - last >= PROBE_INTERVAL_MS;
}

/**
 * Keep every enabled account's quota fresh. An account that served a request
 * within the interval already has a reading from its headers and is skipped,
 * so a busy account costs no extra calls.
 */
export function startCodexUsageLoop(
  accounts: OpenAISubscriptionAccount[],
  fetchImpl: typeof fetch = fetch,
): () => void {
  const check = async () => {
    for (const account of accounts) {
      if (account.enabled === false || !codexUsageIsStale(account)) continue;
      // An expired token would only earn a 401; the refresh loop renews it.
      if (account.expiresAt <= Date.now()) continue;
      await probeCodexUsage(account, fetchImpl);
    }
  };

  const timer = setInterval(() => { check().catch(console.error); }, PROBE_INTERVAL_MS);
  timer.unref();
  queueMicrotask(() => { check().catch(console.error); });

  return () => clearInterval(timer);
}
