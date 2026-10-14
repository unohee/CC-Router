import { describe, expect, it } from "vitest";
import { createOpenAIStreamToAnthropicNormalizer, openAIStreamEventToAnthropicEvents, openAIStreamFailure } from "../protocol/openai-stream-to-anthropic.js";
import { OpenAIProtocolError } from "../protocol/openai-function-call.js";

describe("openAIStreamEventToAnthropicEvents", () => {
  it("converts common Responses stream events to Anthropic message stream events", () => {
    const events = [
      ...openAIStreamEventToAnthropicEvents({
        type: "response.created",
        response: { id: "resp_1", model: "gpt-5.5" },
      }),
      ...openAIStreamEventToAnthropicEvents({
        type: "response.output_text.delta",
        delta: "Hel",
      }),
      ...openAIStreamEventToAnthropicEvents({
        type: "response.output_text.delta",
        delta: "lo",
      }),
      ...openAIStreamEventToAnthropicEvents({
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "gpt-5.5",
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }),
    ];

    expect(events).toEqual([
      {
        type: "message_start",
        message: {
          id: "resp_1",
          type: "message",
          role: "assistant",
          model: "gpt-5.5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "lo" },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      {
        type: "message_stop",
      },
    ]);
  });

  it("keeps text block state isolated per normalizer instance", () => {
    const first = createOpenAIStreamToAnthropicNormalizer();
    const second = createOpenAIStreamToAnthropicNormalizer();

    first.convert({ type: "response.created", response: { id: "first" } });
    second.convert({ type: "response.created", response: { id: "second" } });
    first.convert({ type: "response.output_text.delta", delta: "a" });

    expect(second.convert({ type: "response.output_text.delta", delta: "b" })).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "b" },
      },
    ]);
  });
  it("replays a real Codex function-call stream as Anthropic tool_use events", () => {
    // Event sequence and field names captured verbatim from
    // chatgpt.com/backend-api/codex/responses (2026-08-20).
    const n = createOpenAIStreamToAnthropicNormalizer();
    const events = [
      ...n.convert({ type: "response.created", response: { id: "resp_1", model: "gpt-5.6-terra" } }),
      ...n.convert({ type: "response.in_progress", response: { id: "resp_1" } }),
      ...n.convert({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_077ef051c91f0266",
          type: "function_call",
          call_id: "call_AA8qYZ5V8MphGlrOQKViAykx",
          name: "get_weather",
          arguments: "",
        },
      }),
      ...n.convert({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"city\":" }),
      ...n.convert({ type: "response.function_call_arguments.delta", output_index: 0, delta: "\"Seoul\"}" }),
      ...n.convert({ type: "response.function_call_arguments.done", output_index: 0, arguments: "{\"city\":\"Seoul\"}" }),
      ...n.convert({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", call_id: "call_AA8qYZ5V8MphGlrOQKViAykx", name: "get_weather", arguments: "{\"city\":\"Seoul\"}" },
      }),
      ...n.convert({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 63, output_tokens: 19 } } }),
    ];

    expect(events).toEqual([
      {
        type: "message_start",
        message: {
          id: "resp_1",
          type: "message",
          role: "assistant",
          model: "gpt-5.6-terra",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_AA8qYZ5V8MphGlrOQKViAykx", name: "get_weather", input: {} },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"city\":" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"Seoul\"}" } },
      // arguments.done adds nothing: the deltas already carried the full string.
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 63, output_tokens: 19 } },
      { type: "message_stop" },
    ]);
  });

  it("assigns separate block indexes when text and a tool call are interleaved", () => {
    const n = createOpenAIStreamToAnthropicNormalizer();
    n.convert({ type: "response.created", response: { id: "r", model: "m" } });

    expect(n.convert({ type: "response.output_text.delta", output_index: 0, delta: "Checking." })).toEqual([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking." } },
    ]);
    expect(n.convert({ type: "response.output_item.done", output_index: 0, item: { type: "message" } }))
      .toEqual([{ type: "content_block_stop", index: 0 }]);

    expect(n.convert({
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", call_id: "call_1", name: "get_weather" },
    })).toEqual([
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} } },
    ]);
    expect(n.convert({ type: "response.function_call_arguments.delta", output_index: 1, delta: "{}" })).toEqual([
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
    ]);
  });

  it("emits arguments from `done` when no delta preceded it", () => {
    const n = createOpenAIStreamToAnthropicNormalizer();
    n.convert({ type: "response.created", response: { id: "r" } });
    n.convert({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "c1", name: "ping" } });

    expect(n.convert({ type: "response.function_call_arguments.done", output_index: 0, arguments: "{\"a\":1}" })).toEqual([
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"a\":1}" } },
    ]);
  });

  it("refuses a tool call still open when the response completes", () => {
    // The stream announced a function call and then ended without ever closing
    // it, so its arguments were never seen, let alone validated. This used to
    // be closed quietly and reported as stop_reason "tool_use", which handed
    // the client a tool call to run off a truncated stream.
    const n = createOpenAIStreamToAnthropicNormalizer();
    n.convert({ type: "response.created", response: { id: "r" } });
    n.convert({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "c1", name: "ping" } });

    expect(() => n.convert({ type: "response.completed", response: { usage: { output_tokens: 4 } } }))
      .toThrow(OpenAIProtocolError);
  });

  it("still closes a text block left open when the stream ends", () => {
    // Only tool calls are fail-closed: an unterminated text block carries no
    // instruction for the client to act on, so it is closed as before.
    const n = createOpenAIStreamToAnthropicNormalizer();
    n.convert({ type: "response.created", response: { id: "r" } });
    n.convert({ type: "response.output_text.delta", output_index: 0, delta: "partial" });

    expect(n.convert({ type: "response.completed", response: { usage: { output_tokens: 4 } } })).toEqual([
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 4 } },
      { type: "message_stop" },
    ]);
  });

  it("refuses a tool call whose arguments never parse", () => {
    const n = createOpenAIStreamToAnthropicNormalizer();
    n.convert({ type: "response.created", response: { id: "r" } });
    n.convert({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "c1", name: "search" } });
    n.convert({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"q\":\"unter" });

    expect(() => n.convert({ type: "response.output_item.done", output_index: 0, item: { type: "function_call" } }))
      .toThrow(OpenAIProtocolError);
  });

  it("refuses a function call that announces no call_id or name", () => {
    const n = createOpenAIStreamToAnthropicNormalizer();
    n.convert({ type: "response.created", response: { id: "r" } });

    expect(() => n.convert({
      type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "", name: "ping" },
    })).toThrow(OpenAIProtocolError);
  });

  it("reports a streamed refusal as stop_reason refusal", () => {
    const n = createOpenAIStreamToAnthropicNormalizer();
    n.convert({ type: "response.created", response: { id: "r" } });
    n.convert({ type: "response.refusal.delta", output_index: 0, delta: "I can't help with that." });

    expect(n.convert({ type: "response.completed", response: { usage: { output_tokens: 2 } } })).toEqual([
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 2 } },
      { type: "message_stop" },
    ]);
  });

  it("ignores a duplicate output_item.added for the same output index", () => {
    const n = createOpenAIStreamToAnthropicNormalizer();
    n.convert({ type: "response.created", response: { id: "r" } });
    const item = { type: "function_call", call_id: "c1", name: "ping" };
    n.convert({ type: "response.output_item.added", output_index: 0, item });

    expect(n.convert({ type: "response.output_item.added", output_index: 0, item })).toEqual([]);
  });

  it("resets tool state between responses on the same normalizer", () => {
    const n = createOpenAIStreamToAnthropicNormalizer();
    n.convert({ type: "response.created", response: { id: "r1" } });
    n.convert({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "c1", name: "ping" } });
    // Close the call properly — an open one now fails the response outright,
    // which would test the guard rather than the reset.
    n.convert({ type: "response.function_call_arguments.done", output_index: 0, arguments: "{}" });
    n.convert({ type: "response.output_item.done", output_index: 0, item: { type: "function_call" } });
    n.convert({ type: "response.completed", response: {} });

    // A following text-only response must not inherit stop_reason "tool_use".
    n.convert({ type: "response.created", response: { id: "r2" } });
    n.convert({ type: "response.output_text.delta", delta: "hi" });
    const tail = n.convert({ type: "response.completed", response: { usage: { output_tokens: 1 } } });

    expect(tail).toEqual([
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 1 } },
      { type: "message_stop" },
    ]);
  });
});

describe("openAIStreamFailure", () => {
  it("recognises a rejection delivered inside a 200 stream", () => {
    expect(openAIStreamFailure({
      type: "response.failed",
      response: { error: { message: "Your input exceeds the context window of this model." } },
    })).toBe("Your input exceeds the context window of this model.");

    expect(openAIStreamFailure({ type: "error", message: "boom" })).toBe("boom");
  });

  it("falls back to a code, then to a generic description", () => {
    expect(openAIStreamFailure({ type: "error", code: "invalid_request_error" })).toBe("invalid_request_error");
    expect(openAIStreamFailure({ type: "response.failed", response: {} }))
      .toBe("upstream reported the response failed");
  });

  it("says nothing about ordinary events", () => {
    expect(openAIStreamFailure({ type: "response.created" })).toBeNull();
    expect(openAIStreamFailure({ type: "response.output_text.delta", delta: "hi" })).toBeNull();
    expect(openAIStreamFailure({ type: "response.completed" })).toBeNull();
  });

  it("uses arguments from output_item.done when no argument events were sent", () => {
    const normalizer = createOpenAIStreamToAnthropicNormalizer();
    normalizer.convert({ type: "response.created", response: { id: "resp_4" } });
    normalizer.convert({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", call_id: "call_3", name: "read_file" },
    });

    expect(normalizer.convert({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", arguments: "{\"path\":\"README.md\"}" },
    })).toEqual([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"path\":\"README.md\"}" },
      },
      { type: "content_block_stop", index: 0 },
    ]);
  });

});
