import type {
  AnthropicContent,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "./anthropic-types.js";
import type { OpenAIFunctionCall, OpenAIFunctionCallOutput, OpenAIInputContent, OpenAIInputItem, OpenAIInputMessage, OpenAIResponsesRequest } from "./openai-responses-types.js";
import { parseModelRef } from "./model-ref.js";

function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return { value: args };
  }
}

function textFromOpenAI(block: OpenAIInputContent): string | null {
  if (block.type === "input_text" || block.type === "output_text") return block.text;
  return null;
}

function messageContentToAnthropic(message: OpenAIInputMessage): AnthropicContent {
  const blocks = message.content.map((block): AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | null => {
    const text = textFromOpenAI(block);
    if (text !== null) return { type: "text", text };

    if (block.type === "function_call") {
      return {
        type: "tool_use",
        id: block.call_id,
        name: block.name,
        input: parseArguments(block.arguments),
      };
    }

    if (block.type === "function_call_output") {
      return {
        type: "tool_result",
        tool_use_id: block.call_id,
        content: block.output,
      };
    }

    return null;
  }).filter((block): block is AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock => block !== null);

  if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text;
  return blocks;
}

function normalizeRole(role: OpenAIInputMessage["role"]): "user" | "assistant" {
  return role === "assistant" ? "assistant" : "user";
}

type AnthropicMessage = AnthropicMessagesRequest["messages"][number];
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

// Messages carry no discriminant `type`, so the union is narrowed by its presence.
function isFunctionCall(item: OpenAIInputItem): item is OpenAIFunctionCall {
  return "type" in item && item.type === "function_call";
}

function isFunctionCallOutput(item: OpenAIInputItem): item is OpenAIFunctionCallOutput {
  return "type" in item && item.type === "function_call_output";
}

/**
 * Fold Responses `input` items into Anthropic messages.
 *
 * Function calls and their outputs arrive as top-level items with no `role`, so
 * each is attributed to the role Anthropic expects (calls to the assistant,
 * results to the user) and merged into the neighbouring message — Anthropic
 * rejects consecutive messages sharing a role.
 */
function inputItemsToAnthropicMessages(input: OpenAIInputItem[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];

  const append = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      const existing = typeof last.content === "string"
        ? [{ type: "text" as const, text: last.content }]
        : last.content;
      last.content = [...existing, ...blocks];
      return;
    }
    messages.push({ role, content: blocks });
  };

  for (const item of input) {
    if (isFunctionCall(item)) {
      append("assistant", [{
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: parseArguments(item.arguments),
      }]);
      continue;
    }

    if (isFunctionCallOutput(item)) {
      append("user", [{ type: "tool_result", tool_use_id: item.call_id, content: item.output }]);
      continue;
    }

    const content = messageContentToAnthropic(item);
    append(normalizeRole(item.role), typeof content === "string"
      ? [{ type: "text", text: content }]
      : content);
  }

  // A lone text block round-trips back to the plain-string form Anthropic uses.
  return messages.map(message => {
    if (Array.isArray(message.content) && message.content.length === 1 && message.content[0].type === "text") {
      return { ...message, content: message.content[0].text };
    }
    return message;
  });
}

export function openAIResponsesToAnthropic(req: OpenAIResponsesRequest): AnthropicMessagesRequest {
  const parsed = parseModelRef(req.model);
  return {
    model: parsed.upstreamModel,
    system: req.instructions,
    messages: inputItemsToAnthropicMessages(req.input),
    tools: req.tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    max_tokens: req.max_output_tokens,
    stream: req.stream,
  };
}
