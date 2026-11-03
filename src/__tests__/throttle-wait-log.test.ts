import { describe, expect, it } from "vitest";
import { formatThrottleWait } from "../proxy/logger.js";

describe("formatThrottleWait", () => {
  it("names the account, wait, in-flight against the limit, util and short flag", () => {
    expect(formatThrottleWait({
      accountId: "max-1", waitedMs: 19_750.4, inFlight: 4, limit: 2, util: 0.912, short: false, bypassed: false,
    })).toBe("throttle wait max-1 waitMs=19750 inFlight=4/2 util=91% short=no");
  });

  it("marks a short request that skipped a wait as a bypass", () => {
    expect(formatThrottleWait({
      accountId: "max-2", waitedMs: 0, inFlight: 4, limit: 4, util: 0.5, short: true, bypassed: true,
    })).toBe("throttle bypass max-2 waitMs=0 inFlight=4/4 util=50% short=yes");
  });

  it("reads an infinite limit as off and a non-finite util as unknown", () => {
    expect(formatThrottleWait({
      accountId: "a", waitedMs: 250, inFlight: 0, limit: Number.POSITIVE_INFINITY, util: Number.NaN, short: false, bypassed: false,
    })).toBe("throttle wait a waitMs=250 inFlight=0/off util=- short=no");
  });
});
