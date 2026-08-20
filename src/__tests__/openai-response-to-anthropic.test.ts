import { describe, expect, it } from "vitest";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";

describe("openAIResponseToAnthropicMessage", () => {
  it("maps a completed OpenAI Responses JSON body to an Anthropic message JSON body", () => {
    expect(openAIResponseToAnthropicMessage({
      id: "resp_1",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Done." },
          ],
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    })).toEqual({
      id: "resp_1",
      type: "message",
      role: "assistant",
      model: "gpt-5.5",
      content: [
        { type: "text", text: "Done." },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    });
  });
  it("maps a function_call output item to a tool_use block and flips stop_reason", () => {
    // Field shape captured from chatgpt.com/backend-api/codex/responses (2026-08-20).
    expect(openAIResponseToAnthropicMessage({
      id: "resp_2",
      model: "gpt-5.6-terra",
      output: [
        {
          type: "function_call",
          id: "fc_077ef051c91f0266",
          call_id: "call_AA8qYZ5V8MphGlrOQKViAykx",
          name: "get_weather",
          arguments: "{\"city\":\"Seoul\"}",
        },
      ],
      usage: { input_tokens: 63, output_tokens: 19 },
    })).toEqual({
      id: "resp_2",
      type: "message",
      role: "assistant",
      model: "gpt-5.6-terra",
      content: [
        {
          type: "tool_use",
          // call_id, not the fc_ item id — this is what comes back as tool_use_id.
          id: "call_AA8qYZ5V8MphGlrOQKViAykx",
          name: "get_weather",
          input: { city: "Seoul" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 63, output_tokens: 19 },
    });
  });

  it("preserves the model's ordering of text and tool calls", () => {
    const result = openAIResponseToAnthropicMessage({
      id: "resp_3",
      model: "gpt-5.6-terra",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking." }] },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
      ],
      usage: {},
    });

    expect(result.content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "call_1", name: "get_weather", input: {} },
    ]);
    expect(result.stop_reason).toBe("tool_use");
  });

  it("degrades unparseable arguments to an empty object instead of throwing", () => {
    // A response truncated by max_output_tokens can cut the JSON mid-object.
    const result = openAIResponseToAnthropicMessage({
      id: "resp_4",
      output: [{ type: "function_call", call_id: "call_1", name: "search", arguments: "{\"q\":\"unter" }],
      usage: {},
    });

    expect(result.content).toEqual([{ type: "tool_use", id: "call_1", name: "search", input: {} }]);
  });
});
