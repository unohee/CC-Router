import { describe, it, expect } from "vitest";
import {
  clientRetryAfterSeconds, isRetryableQuota429, makeUpstream429Retryable, resolveUpstream429Relay,
} from "../proxy/upstream-429-relay.js";

describe("isRetryableQuota429", () => {
  it("takes named windows, rate_limited status and stated waits", () => {
    expect(isRetryableQuota429({}, { status: "allowed", claim: "seven_day" }, null)).toBe(true);
    expect(isRetryableQuota429({}, { status: "allowed", claim: "seven_day_opus" }, null)).toBe(true);
    expect(isRetryableQuota429({}, { status: "allowed", claim: "five_hour" }, null)).toBe(true);
    expect(isRetryableQuota429({}, { status: "rate_limited", claim: "" }, null)).toBe(true);
    expect(isRetryableQuota429({}, null, 30)).toBe(true);
  });

  it("leaves a bare 429 alone", () => {
    expect(isRetryableQuota429({}, { status: "allowed", claim: "" }, null)).toBe(false);
    expect(isRetryableQuota429({}, null, null)).toBe(false);
  });

  it("never overrules an upstream x-should-retry: false", () => {
    expect(isRetryableQuota429({ "x-should-retry": "false" }, { status: "rate_limited", claim: "seven_day" }, 60)).toBe(false);
    expect(isRetryableQuota429({ "x-should-retry": "FALSE" }, null, 60)).toBe(false);
  });
});

describe("clientRetryAfterSeconds", () => {
  it("answers 1s when another account or a fallback can take the retry", () => {
    expect(clientRetryAfterSeconds(0, () => false, 9_000)).toBe(1);
    expect(clientRetryAfterSeconds(9_000, () => true, 9_000)).toBe(1);
  });

  it("otherwise tells the pool's real wait", () => {
    expect(clientRetryAfterSeconds(3_599.2, () => false, 9_000)).toBe(3_600);
  });

  it("keeps the upstream figure when no account is healthy or the pool state is unknown", () => {
    expect(clientRetryAfterSeconds(0, () => false, 75, false)).toBe(75);
    expect(clientRetryAfterSeconds(Infinity, () => true, 75)).toBe(75);
  });

  it("only asks about the fallback once the pool is known blocked", () => {
    let asked = false;
    clientRetryAfterSeconds(0, () => { asked = true; return true; }, 10);
    expect(asked).toBe(false);
  });
});

describe("makeUpstream429Retryable", () => {
  it("withholds every unified header and states the wait", () => {
    const h: Record<string, string> = {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-7d-reset": "1",
      "retry-after": "99999",
      "content-type": "application/json",
    };
    expect(makeUpstream429Retryable(h, 1)).toBe(2);
    expect(h).toEqual({ "retry-after": "1", "x-should-retry": "true", "content-type": "application/json" });
  });
});

describe("resolveUpstream429Relay", () => {
  it("defaults to retryable and accepts only passthrough as the alternative", () => {
    expect(resolveUpstream429Relay(undefined)).toBe("retryable");
    expect(resolveUpstream429Relay("bogus")).toBe("retryable");
    expect(resolveUpstream429Relay("passthrough")).toBe("passthrough");
  });
});
