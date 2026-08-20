import { describe, expect, it } from "vitest";
import { openAIResponsesToAnthropic } from "../protocol/openai-to-anthropic.js";

describe("openAIResponsesToAnthropic", () => {
  it("maps a Responses request to Anthropic Messages", () => {
    const result = openAIResponsesToAnthropic({
      model: "claude/sonnet",
      instructions: "Be direct.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Summarize this." }],
        },
      ],
      max_output_tokens: 512,
      stream: true,
    });

    expect(result).toEqual({
      model: "claude-sonnet-4-5",
      system: "Be direct.",
      messages: [
        { role: "user", content: "Summarize this." },
      ],
      max_tokens: 512,
      stream: true,
    });
  });

  it("maps function calls and outputs to Anthropic tool blocks", () => {
    const result = openAIResponsesToAnthropic({
      model: "anthropic/claude-opus-4-1",
      input: [
        {
          role: "assistant",
          content: [
            { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "function_call_output", call_id: "call_1", output: "CC-Router" },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "read_file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });

    expect(result.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "CC-Router" }],
      },
    ]);
    expect(result.tools).toEqual([
      {
        name: "read_file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  it("lifts top-level function call items into the neighbouring Anthropic messages", () => {
    // Real Codex CLI traffic puts calls and their outputs at the top level of
    // `input`, as siblings of messages — not nested in a message's content.
    const result = openAIResponsesToAnthropic({
      model: "claude/sonnet",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Read a." }] },
        { role: "assistant", content: [{ type: "output_text", text: "Reading." }] },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" },
        { type: "function_call_output", call_id: "call_1", output: "contents" },
      ],
    });

    expect(result.messages).toEqual([
      { role: "user", content: "Read a." },
      {
        // Merged: Anthropic rejects two consecutive assistant messages.
        role: "assistant",
        content: [
          { type: "text", text: "Reading." },
          { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "contents" }] },
    ]);
  });

  it("merges consecutive parallel tool calls into one assistant message", () => {
    const result = openAIResponsesToAnthropic({
      model: "claude/sonnet",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Read both." }] },
        { type: "function_call", call_id: "c1", name: "read_file", arguments: "{\"path\":\"a\"}" },
        { type: "function_call", call_id: "c2", name: "read_file", arguments: "{\"path\":\"b\"}" },
      ],
    });

    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "c1", name: "read_file", input: { path: "a" } },
        { type: "tool_use", id: "c2", name: "read_file", input: { path: "b" } },
      ],
    });
  });
});
