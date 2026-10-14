import { readFileSync } from "node:fs";
import { PID_PATH } from "../config/paths.js";
import type { Account } from "../proxy/types.js";
import { resolveStatusTarget } from "./cmd-status.js";

/**
 * Account edits made to accounts.json while a router is running are lost: the
 * server holds the pool in memory and rewrites every Anthropic record from it on
 * the next token refresh and on shutdown. So the account commands must go through
 * the running server when there is one, and touch the file only when there is not.
 */

export interface LiveRouter {
  baseUrl: string;
  headers: Record<string, string>;
}

export type RouterProbe =
  | { state: "live"; router: LiveRouter }
  | { state: "stopped" }
  /** A router process holds the pid file but its API is not answering. */
  | { state: "unreachable"; reason: string };

function daemonPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function probeRouter(port: number, timeoutMs = 1_500): Promise<RouterProbe> {
  const target = resolveStatusTarget(port);
  try {
    const res = await fetch(target.healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { state: "live", router: { baseUrl: target.baseUrl, headers: target.headers } };
    return { state: "unreachable", reason: `${target.healthUrl} answered HTTP ${res.status}` };
  } catch (err) {
    const pid = daemonPid();
    if (pid !== null && pidAlive(pid)) {
      return {
        state: "unreachable",
        reason: `process ${pid} holds ${PID_PATH} but ${target.healthUrl} did not answer (${(err as Error).message})`,
      };
    }
    return { state: "stopped" };
  }
}

export interface LiveAccountSummary {
  id: string;
  provider: "anthropic_subscription" | "openai_subscription";
}

export async function listLiveAccounts(router: LiveRouter): Promise<LiveAccountSummary[]> {
  const res = await fetch(`${router.baseUrl}/cc-router/health`, {
    headers: router.headers,
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`health returned HTTP ${res.status}`);
  const body = await res.json() as { accounts?: Array<{ id: string; provider?: string }> };
  return (body.accounts ?? []).map(a => ({
    id: a.id,
    provider: a.provider === "openai_subscription" ? "openai_subscription" : "anthropic_subscription",
  }));
}

export type RouterEdit = { ok: true } | { ok: false; status: number; message: string };

async function describeFailure(res: Response): Promise<RouterEdit> {
  const text = await res.text().catch(() => "");
  let message = text;
  try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain text */ }
  return { ok: false, status: res.status, message: message || `HTTP ${res.status}` };
}

export async function addAccountToRouter(router: LiveRouter, account: Account): Promise<RouterEdit> {
  const res = await fetch(`${router.baseUrl}/cc-router/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json", ...router.headers },
    body: JSON.stringify({
      id: account.id,
      accessToken: account.tokens.accessToken,
      refreshToken: account.tokens.refreshToken,
      expiresAt: account.tokens.expiresAt,
      scopes: account.tokens.scopes,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  return res.ok ? { ok: true } : describeFailure(res);
}

export async function removeAccountFromRouter(router: LiveRouter, id: string): Promise<RouterEdit> {
  const res = await fetch(`${router.baseUrl}/cc-router/accounts/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: router.headers,
    signal: AbortSignal.timeout(5_000),
  });
  return res.ok ? { ok: true } : describeFailure(res);
}
