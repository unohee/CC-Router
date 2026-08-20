import type { OpenAIResponseCompleted } from "./openai-responses-types.js";

export type AnthropicResponseContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicResponseContentBlock[];
  stop_reason: "end_turn" | "tool_use";
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Parse the JSON `arguments` string carried by a function call. Upstream is not
 * guaranteed to emit valid JSON — a response truncated by max_output_tokens can
 * cut mid-object — and throwing here would turn a partially usable response into
 * a hard proxy error, so unparseable arguments degrade to `{}` instead.
 */
function parseToolInput(args: string | undefined): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

export function openAIResponseToAnthropicMessage(response: OpenAIResponseCompleted): AnthropicMessageResponse {
  const content: AnthropicResponseContentBlock[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") content.push({ type: "text", text: part.text });
      }
      continue;
    }

    if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        // Anthropic returns this id as `tool_result.tool_use_id` on the next
        // turn, and anthropic-to-openai maps that straight back to `call_id`.
        // Carrying call_id (not the item id) is what closes the round trip.
        id: item.call_id,
        name: item.name,
        input: parseToolInput(item.arguments),
      });
    }
  }

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model ?? "",
    content,
    stop_reason: content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}
