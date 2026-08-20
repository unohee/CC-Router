import { describe, expect, it } from "vitest";
import { anthropicToOpenAIResponses } from "../protocol/anthropic-to-openai.js";

describe("anthropicToOpenAIResponses", () => {
  it("maps a simple Anthropic message request to an OpenAI Responses request", () => {
    const result = anthropicToOpenAIResponses({
      model: "openai/gpt-5.5",
      max_tokens: 256,
      system: "You are concise.",
      messages: [
        { role: "user", content: "Write a test." },
      ],
      stream: true,
    });

    expect(result).toEqual({
      model: "gpt-5.5",
      instructions: "You are concise.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Write a test." }],
        },
      ],
      max_output_tokens: 256,
      stream: true,
    });
  });

  it("maps Anthropic tools, assistant tool_use, and user tool_result", () => {
    const result = anthropicToOpenAIResponses({
      model: "openai/gpt-5.5",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "CC-Router" },
          ],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    });

    expect(result.tools).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
    // Verified against the Codex backend (2026-08-20): function calls nested
    // inside a message's content are rejected with HTTP 400 `invalid_value`,
    // and assistant text must be output_text rather than input_text.
    expect(result.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "I will inspect it." }] },
      { type: "function_call", call_id: "toolu_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
      { type: "function_call_output", call_id: "toolu_1", output: "CC-Router" },
    ]);
  });

  it("keeps user text as input_text and assistant text as output_text across turns", () => {
    const result = anthropicToOpenAIResponses({
      model: "openai/gpt-5.5",
      messages: [
        { role: "user", content: "Say A" },
        { role: "assistant", content: "A" },
        { role: "user", content: [{ type: "text", text: "Now say B" }] },
      ],
    });

    expect(result.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Say A" }] },
      { role: "assistant", content: [{ type: "output_text", text: "A" }] },
      { role: "user", content: [{ type: "input_text", text: "Now say B" }] },
    ]);
  });

  it("splits a message into ordered items when text precedes several tool calls", () => {
    const result = anthropicToOpenAIResponses({
      model: "openai/gpt-5.5",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading both." },
            { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
            { type: "tool_use", id: "t2", name: "read_file", input: { path: "b" } },
          ],
        },
      ],
    });

    expect(result.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "Reading both." }] },
      { type: "function_call", call_id: "t1", name: "read_file", arguments: "{\"path\":\"a\"}" },
      { type: "function_call", call_id: "t2", name: "read_file", arguments: "{\"path\":\"b\"}" },
    ]);
  });

  it("passes reasoning effort through and omits it when the request has none", () => {
    const withEffort = anthropicToOpenAIResponses({
      model: "openai/gpt-5.6-sol",
      output_config: { effort: "xhigh" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(withEffort.reasoning).toEqual({ effort: "xhigh" });

    // Omitted, not defaulted — the target model's own default should apply.
    const without = anthropicToOpenAIResponses({
      model: "openai/gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(without.reasoning).toBeUndefined();
  });
});
