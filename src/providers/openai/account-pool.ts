import type { OpenAISubscriptionAccount } from "./token-refresher.js";

/**
 * How long an exhausted account waits before being retried when its headers
 * carried no usable reset time. Without this the account could never recover:
 * the quota is only ever refreshed by a response, and a response only happens
 * if the account is picked.
 */
const BLIND_RETRY_MS = 5 * 60 * 1000;

/**
 * Whether an exhausted account has waited out its limit and may be tried again.
 *
 * The binding window's reset is authoritative. When it is missing or zero, fall
 * back to a fixed delay since the reading was taken — one wasted request that
 * refreshes the quota beats an account that can never come back.
 */
function exhaustionHasLapsed(limits: NonNullable<OpenAISubscriptionAccount["rateLimits"]>): boolean {
  const bindingReset = limits.claim === "five_hour" ? limits.fiveHourReset : limits.sevenDayReset;
  if (bindingReset > 0) return Math.floor(Date.now() / 1000) >= bindingReset;
  return Date.now() - limits.lastUpdated >= BLIND_RETRY_MS;
}

/**
 * Whether an OpenAI account can take traffic right now. Enabled, and not
 * sitting on an unexpired exhausted quota — Codex publishes utilisation per
 * window, so a capped account is known before it starts refusing requests.
 *
 * Shared so the picker and session affinity cannot drift apart: a session must
 * never be pinned to an account the picker would skip.
 */
export function canServeOpenAI(account: OpenAISubscriptionAccount): boolean {
  if (!account.enabled) return false;
  const limits = account.rateLimits;
  if (!limits || limits.status !== "rate_limited") return true;
  return exhaustionHasLapsed(limits);
}

export function createOpenAIAccountPicker(
  accounts: OpenAISubscriptionAccount[],
): () => OpenAISubscriptionAccount | null {
  let index = 0;

  return () => {
    const usable = accounts.filter(canServeOpenAI);
    if (usable.length === 0) return null;

    const account = usable[index % usable.length];
    index = (index + 1) % usable.length;
    return account;
  };
}
