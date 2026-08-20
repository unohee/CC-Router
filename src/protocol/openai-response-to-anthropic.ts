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

function parseToolInput(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return {};
  }
}

export function openAIResponseToAnthropicMessage(response: OpenAIResponseCompleted): AnthropicMessageResponse {
  const content: AnthropicResponseContentBlock[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content) {
        content.push({ type: "text", text: part.text });
      }
      continue;
    }

    content.push({
      type: "tool_use",
      id: item.call_id,
      name: item.name,
      input: parseToolInput(item.arguments),
    });
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
