import { describe, expect, it } from "vitest";
import type { LogEntry } from "../proxy/stats.js";
import { terminalSafeText, usageDetailMode } from "../ui/Dashboard.js";

function log(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: 1,
    accountId: "account",
    model: "model",
    type: "route",
    ...overrides,
  };
}

describe("usageDetailMode", () => {
  it("uses the cache breakdown when provider cache accounting exists", () => {
    expect(usageDetailMode(log({ cacheReadTokens: 0, inputTokens: 10, outputTokens: 2 }))).toBe("cache");
  });

  it("uses basic input/output details when cache accounting is unavailable", () => {
    expect(usageDetailMode(log({ inputTokens: 143_864, outputTokens: 382 }))).toBe("basic");
  });

  it("hides usage details when the provider reported no usage fields", () => {
    expect(usageDetailMode(log())).toBe("none");
  });
});


describe("terminalSafeText", () => {
  it("neutralizes terminal controls in request-derived detail fields", () => {
    expect(terminalSafeText("model\u001b[2J\nspoofed")).toBe("model�[2J�spoofed");
  });

  it("preserves ordinary model and session identifiers", () => {
    expect(terminalSafeText("gpt-5.6-sol / 4e809f92-5f79")).toBe("gpt-5.6-sol / 4e809f92-5f79");
  });
});
