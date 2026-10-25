import type {
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "./anthropic-types.js";
import type {
  OpenAIFunctionCall,
  OpenAIFunctionCallOutput,
  OpenAIInputContent,
  OpenAIInputItem,
  OpenAIInputMessage,
  OpenAIResponsesRequest,
} from "./openai-responses-types.js";
import { parseModelRef } from "./model-ref.js";

function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return { value: args };
  }
}

/**
 * A content block as it may actually arrive on the wire. The canonical shape
 * puts function calls and their outputs at the top level of `input` — that is
 * what `OpenAIInputContent` encodes and what we emit — but this is an inbound
 * endpoint, and a client is free to send the nested form anyway. Reading
 * `block.text` off such a block yields undefined and takes the whole request
 * down with a TypeError, so the nested form is decoded here rather than
 * trusted to be absent.
 */
type InboundContentBlock = OpenAIInputContent | OpenAIFunctionCall | OpenAIFunctionCallOutput;

function messageContentToAnthropic(message: OpenAIInputMessage): string | AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];

  for (const block of message.content as InboundContentBlock[]) {
    if (block.type === "function_call") {
      blocks.push({
        type: "tool_use",
        id: block.call_id,
        name: block.name,
        input: parseArguments(block.arguments),
      });
      continue;
    }
    if (block.type === "function_call_output") {
      blocks.push({ type: "tool_result", tool_use_id: block.call_id, content: block.output });
      continue;
    }
    // Not translated back: this direction serves Codex clients, which send text.
    if (block.type === "input_image") continue;
    blocks.push({ type: "text", text: block.text });
  }

  // A lone text block round-trips back to the plain-string form Anthropic uses.
  if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text;
  return blocks;
}

function normalizeRole(role: OpenAIInputMessage["role"]): "user" | "assistant" {
  return role === "assistant" ? "assistant" : "user";
}

type AnthropicMessage = AnthropicMessagesRequest["messages"][number];
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

function isFunctionCall(item: OpenAIInputItem): item is OpenAIFunctionCall {
  return "type" in item && item.type === "function_call";
}

function isFunctionCallOutput(item: OpenAIInputItem): item is OpenAIFunctionCallOutput {
  return "type" in item && item.type === "function_call_output";
}

function inputItemsToAnthropicMessages(input: OpenAIInputItem[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  const append = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === role) {
      // Every message here was built by `append`, so its blocks are AnthropicBlock.
      const existing: AnthropicBlock[] = typeof last.content === "string"
        ? [{ type: "text" as const, text: last.content }]
        : last.content as AnthropicBlock[];
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
    } else if (isFunctionCallOutput(item)) {
      append("user", [{ type: "tool_result", tool_use_id: item.call_id, content: item.output }]);
    } else {
      const content = messageContentToAnthropic(item);
      append(normalizeRole(item.role), typeof content === "string"
        ? [{ type: "text", text: content }]
        : content);
    }
  }

  return messages.map(message => {
    if (Array.isArray(message.content) && message.content.length === 1 && message.content[0].type === "text") {
      return { ...message, content: (message.content[0] as AnthropicTextBlock).text };
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
