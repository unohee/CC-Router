/**
 * Anthropic's unified rate-limit headers, as one reading per response.
 *
 * Kept apart from server.ts so the parsing can be tested without starting a
 * router. Numbers that are absent read as 0; whether the 5-hour window was
 * reported at all is kept beside them (`fiveHourReported`), because a seat
 * whose plan has no 5-hour window answers without that header and must not be
 * read as "0% of its 5-hour window used".
 */

import type { AccountRateLimits } from "./types.js";

function inferPlan(requestsLimit: number): string {
  if (requestsLimit <= 0) return "";
  if (requestsLimit <= 100) return "Pro";
  if (requestsLimit <= 500) return "Max 5x";
  return "Max 20x";
}

export function extractRateLimits(headers: Record<string, string | string[] | undefined>): AccountRateLimits | null {
  const h = (name: string) => String(headers[name] ?? "");
  const status = h("anthropic-ratelimit-unified-status");
  if (!status) return null; // No unified headers in this response

  const requestsLimit = parseInt(h("anthropic-ratelimit-requests-limit"), 10) || 0;
  const fiveHourRaw = h("anthropic-ratelimit-unified-5h-utilization");
  const fiveHourReset = parseInt(h("anthropic-ratelimit-unified-5h-reset"), 10) || 0;
  const claim = h("anthropic-ratelimit-unified-representative-claim");

  return {
    status: status === "rate_limited" ? "rate_limited" : "allowed",
    fiveHourUtil: parseFloat(fiveHourRaw) || 0,
    // A missing utilization header is not a reading of 0. The window still
    // counts as reported when the response named its reset or blamed it (a
    // 429 with a five_hour claim carries no utilization).
    fiveHourReported: (fiveHourRaw !== "" && Number.isFinite(parseFloat(fiveHourRaw))) || fiveHourReset > 0 || claim === "five_hour",
    fiveHourReset,
    sevenDayUtil: parseFloat(h("anthropic-ratelimit-unified-7d-utilization")) || 0,
    sevenDayReset: parseInt(h("anthropic-ratelimit-unified-7d-reset"), 10) || 0,
    claim,
    plan: inferPlan(requestsLimit),
    requestsLimit,
    lastUpdated: Date.now(),
  };
}
