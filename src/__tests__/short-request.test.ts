import { describe, expect, it } from "vitest";
import { SHORT_REQUEST_MAX_TOKENS, isShortRequest } from "../proxy/short-request.js";

/** Shape of a Claude Code `$.model.classify` call as captured 2026-11-03
 *  (claude-cli 2.1.317) — placeholder text, the real content was never logged. */
const CLASSIFY = {
  model: "claude-haiku-5-5",
  max_tokens: 2068,
  system: [{ type: "text", text: "x" }, { type: "text", text: "y" }],
  messages: [{ role: "user", content: "label this prompt" }],
  metadata: { user_id: "u" },
};

/** Shape of a main-loop turn from the same capture. */
const MAIN_LOOP = {
  model: "claude-haiku-5-5",
  max_tokens: 128_000,
  stream: true,
  tools: [{ name: "Bash" }],
  thinking: { type: "adaptive" },
  system: [{ type: "text", text: "x" }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

describe("isShortRequest", () => {
  it("accepts the captured classifier shape", () => {
    expect(isShortRequest(CLASSIFY)).toBe(true);
  });

  it("rejects the captured main-loop shape", () => {
    expect(isShortRequest(MAIN_LOOP)).toBe(false);
  });

  it("rejects a streaming request", () => {
    expect(isShortRequest({ ...CLASSIFY, stream: true })).toBe(false);
  });

  it("treats an explicit stream:false like an absent stream", () => {
    expect(isShortRequest({ ...CLASSIFY, stream: false })).toBe(true);
  });

  it("rejects a request that declares tools", () => {
    expect(isShortRequest({ ...CLASSIFY, tools: [{ name: "Bash" }] })).toBe(false);
  });

  it("accepts an empty tools array", () => {
    expect(isShortRequest({ ...CLASSIFY, tools: [] })).toBe(true);
  });

  it("rejects a non-array tools value", () => {
    expect(isShortRequest({ ...CLASSIFY, tools: {} })).toBe(false);
  });

  it("accepts max_tokens up to the threshold and rejects one above it", () => {
    expect(isShortRequest({ ...CLASSIFY, max_tokens: SHORT_REQUEST_MAX_TOKENS })).toBe(true);
    expect(isShortRequest({ ...CLASSIFY, max_tokens: SHORT_REQUEST_MAX_TOKENS + 1 })).toBe(false);
  });

  it("rejects a missing, non-numeric, non-finite or non-positive max_tokens", () => {
    const { max_tokens: _drop, ...noMax } = CLASSIFY;
    expect(isShortRequest(noMax)).toBe(false);
    expect(isShortRequest({ ...CLASSIFY, max_tokens: "100" })).toBe(false);
    expect(isShortRequest({ ...CLASSIFY, max_tokens: Number.NaN })).toBe(false);
    expect(isShortRequest({ ...CLASSIFY, max_tokens: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isShortRequest({ ...CLASSIFY, max_tokens: 0 })).toBe(false);
  });

  it("rejects anything that is not a Messages request body", () => {
    expect(isShortRequest(undefined)).toBe(false);
    expect(isShortRequest(null)).toBe(false);
    expect(isShortRequest("{}")).toBe(false);
    expect(isShortRequest([])).toBe(false);
    expect(isShortRequest({})).toBe(false);
    const { messages: _drop, ...noMessages } = CLASSIFY;
    expect(isShortRequest(noMessages)).toBe(false);
  });
});
