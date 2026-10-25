import type { AccountRateLimits } from "../../proxy/types.js";
import type { ProviderAccount } from "../types.js";

const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const refreshLocks = new Map<string, Promise<boolean>>();

export type OpenAISubscriptionAccount = ProviderAccount & {
  provider: "openai_subscription";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Live usage counters. Optional so accounts.json files written before these
   *  existed still load; treat absent as zero. */
  requestCount?: number;
  errorCount?: number;
  lastUsed?: number;
  /**
   * Quota parsed from Codex response headers. Absent until the first request.
   *
   * Runtime-only, and deliberately so: `serialize()` omits rate limits for
   * Anthropic accounts too, so neither provider carries quota across a restart.
   * The cost of forgetting is one request — the response that follows refreshes
   * the reading — and persisting stale quota would be worse than re-measuring.
   */
  rateLimits?: AccountRateLimits;
};

export function needsOpenAIRefresh(account: Pick<OpenAISubscriptionAccount, "expiresAt">): boolean {
  return account.expiresAt - Date.now() < REFRESH_BUFFER_MS;
}

export async function refreshOpenAISubscriptionToken(account: OpenAISubscriptionAccount): Promise<boolean> {
  const existing = refreshLocks.get(account.id);
  if (existing) return existing;

  const promise = doRefresh(account);
  refreshLocks.set(account.id, promise);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(account.id);
  }
}

export async function prepareOpenAIAccountForRequest(
  account: OpenAISubscriptionAccount,
  allAccounts: OpenAISubscriptionAccount[],
  saveAccounts: (accounts: OpenAISubscriptionAccount[]) => void,
): Promise<boolean> {
  if (!needsOpenAIRefresh(account)) return true;

  const ok = await refreshOpenAISubscriptionToken(account);
  if (ok) saveAccounts(allAccounts);
  return ok;
}

export function startOpenAIRefreshLoop(
  accounts: OpenAISubscriptionAccount[],
  saveAccounts: (accounts: OpenAISubscriptionAccount[]) => void,
): () => void {
  const check = async () => {
    for (const account of accounts) {
      await prepareOpenAIAccountForRequest(account, accounts, saveAccounts);
    }
  };

  const timer = setInterval(() => { check().catch(console.error); }, CHECK_INTERVAL_MS);
  queueMicrotask(() => { check().catch(console.error); });

  return () => clearInterval(timer);
}

async function doRefresh(account: OpenAISubscriptionAccount): Promise<boolean> {
  const body = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) return false;

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = await res.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    data = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  if (typeof data.access_token !== "string" || !data.access_token.trim()) return false;
  if (data.refresh_token !== undefined
      && (typeof data.refresh_token !== "string" || !data.refresh_token.trim())) return false;

  const now = Date.now();
  let expiresAt: number;
  if (typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0) {
    expiresAt = now + data.expires_in * 1000;
  } else {
    // Codex refreshes may omit expires_in; the access JWT carries its expiry.
    try {
      const parts = data.access_token.split(".");
      if (parts.length !== 3) return false;
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown } | null;
      if (typeof claims?.exp !== "number") return false;
      expiresAt = claims.exp * 1000;
    } catch {
      return false;
    }
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  // Validate the complete replacement before mutating either rotating token.
  account.accessToken = data.access_token;
  account.refreshToken = data.refresh_token as string | undefined ?? account.refreshToken;
  account.expiresAt = expiresAt;
  return true;
}
