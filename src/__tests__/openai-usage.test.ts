import { describe, expect, it } from "vitest";
import { openAIUsageToAnthropic } from "../protocol/openai-usage.js";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";
import { openAISample } from "../proxy/usage-history.js";

describe("Codex cached token accounting", () => {
  it("separates cached input without double counting through the message and history", () => {
    const message = openAIResponseToAnthropicMessage({ id: "r", usage: {
      input_tokens: 10000, output_tokens: 20, input_tokens_details: { cached_tokens: 9000 },
    } });
    expect(message.usage).toEqual({ input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 9000 });
    const sample = openAISample(message.usage, "gpt-6.1-sol", 1)!;
    expect(sample.input).toBe(1000);
    expect(sample.cacheRead).toBe(9000);
    expect(sample.input! + sample.cacheRead!).toBe(10000);
  });

  it("distinguishes missing cache readings from a measured zero", () => {
    expect(openAIUsageToAnthropic({ input_tokens: 3 })).toEqual({ input_tokens: 3, output_tokens: 0 });
    expect(openAIUsageToAnthropic({ input_tokens: 3, input_tokens_details: { cached_tokens: 0 } }))
      .toEqual({ input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0 });
  });

  it("bounds invalid cache counts", () => {
    expect(openAIUsageToAnthropic({ input_tokens: 3, input_tokens_details: { cached_tokens: 8 } }).input_tokens).toBe(0);
    expect(openAIUsageToAnthropic({ input_tokens: 3, input_tokens_details: { cached_tokens: -1 } }).input_tokens).toBe(3);
  });
});
