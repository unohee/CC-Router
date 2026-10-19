import type { IncomingHttpHeaders } from "http";

/**
 * How an upstream 429 reaches the client.
 *
 * Anthropic's 429 for an exhausted plan window carries the
 * `anthropic-ratelimit-unified-*` family. Claude Code reads those as "your
 * account hit its session/weekly limit" and stops the session (measured on
 * 2.1.303: no retry without the watchdog, and long usage-limit waits are capped
 * even with it). But the limit belongs to one pool account: the router has
 * already put that account on cooldown and can usually serve the very next
 * attempt from another one. Relaying the refusal verbatim made a single
 * account's weekly window stop sessions while other accounts sat idle.
 *
 * "retryable" (default) strips the unified headers and answers with a short,
 * explicit wait, so the client retries and the retry is routed afresh.
 * "passthrough" restores the old verbatim relay.
 */
export type Upstream429Relay = "retryable" | "passthrough";

export function resolveUpstream429Relay(raw: unknown): Upstream429Relay {
  return raw === "passthrough" ? "passthrough" : "retryable";
}

/**
 * Whether this 429 is one the rewrite is for: a quota or window refusal that
 * belongs to the account (named window, rate_limited status, or a stated
 * Retry-After). A bare 429 says nothing about the account, so the client keeps
 * its own backoff; an upstream `x-should-retry: false` is never overruled,
 * because a refusal that cannot succeed must not be rotated across the pool.
 */
export function isRetryableQuota429(
  headers: IncomingHttpHeaders,
  limit: { status: string; claim: string } | null,
  statedRetryAfterSeconds: number | null,
): boolean {
  const shouldRetry = headers["x-should-retry"];
  if (String(Array.isArray(shouldRetry) ? shouldRetry[0] : shouldRetry ?? "").toLowerCase() === "false") return false;
  if (limit?.status === "rate_limited") return true;
  if (/^(five_hour|seven_day)/.test(limit?.claim ?? "")) return true;
  return statedRetryAfterSeconds !== null;
}

/**
 * Seconds the client should wait before retrying a request whose account just
 * answered 429.
 *
 * `poolWaitSeconds` is TokenPool.secondsUntilAvailable AFTER the cooldown was
 * recorded: 0 means another account can take the retry now. `fallbackServes`
 * says whether the retry would be answered by a fallback (Ollama) instead of
 * waiting (Ollama, or the Codex cross-provider fallback). Unknown (non-finite)
 * pool state keeps the upstream's own figure.
 */
export function clientRetryAfterSeconds(
  poolWaitSeconds: number,
  fallbackServes: () => boolean,
  upstreamRetryAfterSeconds: number,
  anyHealthy = true,
): number {
  // 0 also means "no healthy account at all" (getNext then hands out a blocked
  // one); a 1s retry there would just loop, so keep the upstream's figure.
  if (poolWaitSeconds <= 0) return anyHealthy ? 1 : Math.max(1, Math.ceil(upstreamRetryAfterSeconds));
  if (!Number.isFinite(poolWaitSeconds)) return Math.max(1, Math.ceil(upstreamRetryAfterSeconds));
  if (fallbackServes()) return 1;
  return Math.max(1, Math.ceil(poolWaitSeconds));
}

/**
 * Rewrite an upstream 429's headers in place (before http-proxy copies them to
 * the client) so it reads as a retryable wait. The body is left alone: Claude
 * Code decides from the headers, not from the message text (measured: plan-limit
 * wording in the body with no unified headers is retried normally).
 * Returns how many unified headers were removed, for the log line.
 */
export function makeUpstream429Retryable(headers: IncomingHttpHeaders, retryAfterSeconds: number): number {
  let removed = 0;
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase().startsWith("anthropic-ratelimit-unified")) {
      delete headers[name];
      removed++;
    }
  }
  headers["retry-after"] = String(retryAfterSeconds);
  headers["x-should-retry"] = "true";
  return removed;
}
