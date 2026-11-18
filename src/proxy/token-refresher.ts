import type { Account, RefreshResponse } from "./types.js";
import { writeAnthropicAccountsPreservingOtherProviders, serialize, getRefreshLeadMs } from "../config/manager.js";
import { logRefresh } from "./logger.js";
import { persistenceFrozen } from "../config/persistence-gate.js";
import { stats } from "./stats.js";

/**
 * Official Claude Code CLI client_id for the OAuth PKCE flow.
 * Source: extracted from Claude Code auth flow.
 * Update this if Anthropic changes it in a future Claude Code version.
 */
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * Primary OAuth token endpoint.
 * Alternative: https://claude.ai/v1/oauth/token
 */
const TOKEN_ENDPOINT = "https://claude.ai/v1/oauth/token";

/**
 * The endpoint refreshes go to. CC_ROUTER_OAUTH_TOKEN_URL replaces it so tests
 * can run a real router against a fake OAuth server instead of claude.ai. It
 * is read from the router's own environment, which only its operator sets.
 */
function tokenEndpoint(): string {
  return process.env["CC_ROUTER_OAUTH_TOKEN_URL"] || TOKEN_ENDPOINT;
}

/** Refresh 10 minutes before expiry */
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

/** Check every 5 minutes */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Per-account refresh locks — prevent concurrent refreshes for the same account */
const refreshLocks = new Map<string, Promise<boolean>>();

export function needsRefresh(account: Account, bufferMs = REFRESH_BUFFER_MS): boolean {
  return (account.tokens.expiresAt - Date.now()) < bufferMs;
}

/** Longest wait between early (lead-window) retries after a transient failure. */
const MAX_EARLY_BACKOFF_MS = 30 * 60 * 1000;

export interface RefreshFailure {
  /** True when retrying cannot help: the refresh token itself was refused. */
  permanent: boolean;
  message: string;
}

/**
 * Sort a refused refresh into "log in again" and "try again later".
 * Only `invalid_grant` is permanent — the server says this refresh token is
 * dead. Everything else (5xx, rate limits, an unreadable body) may pass, and
 * treating it as fatal would take a working seat out for good.
 */
export function classifyRefreshFailure(status: number, body: string): RefreshFailure {
  let code = "";
  let description = "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    if (typeof parsed.error === "string") code = parsed.error;
    if (typeof parsed.error_description === "string") description = parsed.error_description;
  } catch {
    // Not JSON — fall through to the substring check.
  }
  const permanent = status === 400 && (code === "invalid_grant" || (code === "" && body.includes("invalid_grant")));
  const detail = description || code || body.slice(0, 120);
  return { permanent, message: `HTTP ${status}${detail ? ` — ${detail}` : ""}` };
}

/**
 * Whether the background loop should refresh this account now.
 * An account whose refresh token was refused is left alone; one inside the
 * lead window but still far from expiry backs off after a failure, while one
 * inside the last ten minutes is retried on every pass.
 */
export function shouldRefreshNow(account: Account, now: number, leadMs: number): boolean {
  if (account.authState === "needs-relogin") return false;
  const remaining = account.tokens.expiresAt - now;
  if (remaining >= leadMs) return false;
  if (remaining > REFRESH_BUFFER_MS && account.nextRefreshAt !== undefined && now < account.nextRefreshAt) return false;
  return true;
}

/**
 * Upstream answered 401 to this access token. That is direct evidence the token
 * is dead whatever `expiresAt` says (revoked by a logout elsewhere, or by another
 * holder of the same login), so it is treated as expired: if the refresh then
 * fails, the seat leaves rotation instead of being picked again and again.
 *
 * `rejectedToken` is the token the request actually carried. If a refresh has
 * replaced it since, the 401 is about a token we no longer hold and nothing is
 * marked — expiring the fresh one would burn a rotation and could take a good
 * seat out.
 */
export async function refreshAfterRejection(account: Account, rejectedToken?: string): Promise<boolean> {
  if (rejectedToken !== undefined && rejectedToken !== account.tokens.accessToken) return true;
  const now = Date.now();
  if (account.tokens.expiresAt > now) account.tokens.expiresAt = now;
  return refreshAccountToken(account);
}

function recordRefreshFailure(account: Account, failure: RefreshFailure, now: number): void {
  account.lastRefreshAttempt = now;
  account.lastRefreshError = failure.message;
  account.consecutiveErrors++;
  const wasPermanent = account.authState === "needs-relogin";
  account.authState = failure.permanent ? "needs-relogin" : "refresh-failing";
  if (failure.permanent) {
    account.nextRefreshAt = undefined;
    if (!wasPermanent) {
      const left = Math.max(0, Math.round((account.tokens.expiresAt - now) / 60_000));
      console.error(
        `  ${account.id}: refresh token refused (${failure.message}). ` +
        `The current access token works for ${left} more min — run: cc-router accounts relogin ${account.id}`,
      );
    }
  } else {
    const step = Math.min(account.consecutiveErrors, 6);
    account.nextRefreshAt = now + Math.min(MAX_EARLY_BACKOFF_MS, CHECK_INTERVAL_MS * 2 ** (step - 1));
  }
  // A refresh that fails early must not take down a seat whose access token
  // still works: it is unhealthy only once that token has run out.
  if (account.tokens.expiresAt <= now) account.healthy = false;
}

export async function refreshAccountToken(account: Account): Promise<boolean> {
  // A refused refresh token stays refused; do not ask the server again.
  if (account.authState === "needs-relogin") return false;
  // A worker handing over never rotates a token: its successor owns refresh
  // now, and two holders refreshing one token is what kills it. The access
  // token in hand keeps working until expiresAt. Not recorded as a failure.
  if (persistenceFrozen()) return false;
  // Deduplicate concurrent refresh calls for the same account
  const existing = refreshLocks.get(account.id);
  if (existing) return existing;

  const promise = _doRefresh(account);
  refreshLocks.set(account.id, promise);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(account.id);
  }
}

async function _doRefresh(account: Account): Promise<boolean> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.tokens.refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
    });

    const res = await fetch(tokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      logRefresh(account.id, false);
      console.error(`  Status: ${res.status} — ${body}`);
      recordRefreshFailure(account, classifyRefreshFailure(res.status, body), Date.now());
      return false;
    }

    const data: RefreshResponse = await res.json() as RefreshResponse;

    // CRITICAL: refresh_token ROTATES — save the new one immediately or lose access permanently
    account.tokens.accessToken = data.access_token;
    account.tokens.refreshToken = data.refresh_token;
    account.tokens.expiresAt = Date.now() + data.expires_in * 1000;
    account.tokens.scopes = data.scope.split(" ");
    account.healthy = true;
    account.consecutiveErrors = 0;
    account.lastRefresh = Date.now();
    account.lastRefreshAttempt = account.lastRefresh;
    account.authState = "ok";
    account.lastRefreshError = undefined;
    account.nextRefreshAt = undefined;

    stats.totalRefreshes++;
    stats.addLog({ ts: Date.now(), accountId: account.id, model: "-", type: "refresh" });

    const expiresInMin = Math.round(data.expires_in / 60);
    logRefresh(account.id, true, expiresInMin);
    return true;
  } catch (err) {
    logRefresh(account.id, false);
    console.error(`  Error:`, err);
    const reason = err instanceof Error ? err.message : String(err);
    recordRefreshFailure(account, { permanent: false, message: reason }, Date.now());
    return false;
  }
}

/**
 * Persist all accounts to disk.
 * Uses atomic write (tmp + rename) to prevent corruption if process dies mid-write.
 * Must be called after every successful refresh since refresh_token ROTATES.
 */
export function saveAccounts(accounts: Account[]): void {
  writeAnthropicAccountsPreservingOtherProviders(serialize(accounts));
}

/**
 * One pass of the background loop: refresh every account that is due, save
 * after each success (the refresh token rotates), and mark accounts whose
 * refresh token was refused unhealthy once their access token runs out.
 */
export async function runRefreshPass(
  accounts: Account[],
  leadMs: number,
  now: number = Date.now(),
  save: (accounts: Account[]) => void = saveAccounts,
): Promise<void> {
  for (const account of accounts) {
    if (account.authState === "needs-relogin") {
      if (account.tokens.expiresAt <= now) account.healthy = false;
      continue;
    }
    if (shouldRefreshNow(account, now, leadMs)) {
      const ok = await refreshAccountToken(account);
      if (ok) save(accounts);
    }
  }
}

/**
 * Background refresh loop: every 5 minutes, refresh any token inside the lead
 * window (`tokenRefresh.leadMinutes`, default 4 h before expiry). Refreshing
 * that early is deliberate: a refresh token that has died is found hours
 * before the outage instead of ten minutes before it. The per-request path in
 * server.ts keeps the 10-minute buffer.
 */
export function startRefreshLoop(accounts: Account[], leadMs: () => number = getRefreshLeadMs): void {
  const check = () => runRefreshPass(accounts, leadMs());

  // Run immediately on startup (catches already-expired tokens)
  check().catch(console.error);

  setInterval(() => { check().catch(console.error); }, CHECK_INTERVAL_MS);
}
