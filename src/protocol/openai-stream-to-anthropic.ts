interface OpenAIStreamEventItem {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface OpenAIStreamEvent {
  type?: string;
  delta?: string;
  output_index?: number;
  arguments?: string;
  item?: OpenAIStreamEventItem;
  response?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

type AnthropicStreamEvent = Record<string, unknown>;

export interface OpenAIStreamToAnthropicNormalizer {
  convert(event: OpenAIStreamEvent): AnthropicStreamEvent[];
  reset(): void;
}

interface OpenBlock {
  index: number;
  kind: "text" | "tool_use";
  sentArguments: boolean;
}

export function createOpenAIStreamToAnthropicNormalizer(): OpenAIStreamToAnthropicNormalizer {
  let blocks = new Map<number, OpenBlock>();
  let nextIndex = 0;
  let sawToolUse = false;

  const reset = () => {
    blocks = new Map();
    nextIndex = 0;
    sawToolUse = false;
  };

  const openTextBlock = (outputIndex: number): AnthropicStreamEvent[] => {
    if (blocks.has(outputIndex)) return [];
    const block: OpenBlock = { index: nextIndex++, kind: "text", sentArguments: false };
    blocks.set(outputIndex, block);
    return [{
      type: "content_block_start",
      index: block.index,
      content_block: { type: "text", text: "" },
    }];
  };

  const closeBlock = (outputIndex: number): AnthropicStreamEvent[] => {
    const block = blocks.get(outputIndex);
    if (!block) return [];
    blocks.delete(outputIndex);
    return [{ type: "content_block_stop", index: block.index }];
  };

  return {
    reset,
    convert(event: OpenAIStreamEvent): AnthropicStreamEvent[] {
      const outputIndex = event.output_index ?? 0;

      if (event.type === "response.created") {
        reset();
        return [{
          type: "message_start",
          message: {
            id: event.response?.id ?? "",
            type: "message",
            role: "assistant",
            model: event.response?.model ?? "",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }];
      }

      if (event.type === "response.output_item.added") {
        if (event.item?.type !== "function_call" || blocks.has(outputIndex)) return [];
        const block: OpenBlock = { index: nextIndex++, kind: "tool_use", sentArguments: false };
        blocks.set(outputIndex, block);
        sawToolUse = true;
        return [{
          type: "content_block_start",
          index: block.index,
          content_block: {
            type: "tool_use",
            id: event.item.call_id ?? event.item.id ?? "",
            name: event.item.name ?? "",
            input: {},
          },
        }];
      }

      if (event.type === "response.output_text.delta") {
        const prefix = openTextBlock(outputIndex);
        const block = blocks.get(outputIndex);
        return [...prefix, {
          type: "content_block_delta",
          index: block?.index ?? 0,
          delta: { type: "text_delta", text: event.delta ?? "" },
        }];
      }

      if (event.type === "response.function_call_arguments.delta") {
        const block = blocks.get(outputIndex);
        if (!block || block.kind !== "tool_use") return [];
        block.sentArguments = true;
        return [{
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: event.delta ?? "" },
        }];
      }

      if (event.type === "response.function_call_arguments.done") {
        const block = blocks.get(outputIndex);
        if (!block || block.kind !== "tool_use" || block.sentArguments || !event.arguments) return [];
        block.sentArguments = true;
        return [{
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: event.arguments },
        }];
      }

      if (event.type === "response.output_item.done") {
        const block = blocks.get(outputIndex);
        const argumentEvent = block?.kind === "tool_use" && !block.sentArguments && event.item?.arguments
          ? [{
              type: "content_block_delta",
              index: block.index,
              delta: { type: "input_json_delta", partial_json: event.item.arguments },
            }]
          : [];
        return [...argumentEvent, ...closeBlock(outputIndex)];
      }

      if (event.type === "response.completed") {
        const prefix = [...blocks.keys()].flatMap(closeBlock);
        const stopReason = sawToolUse ? "tool_use" : "end_turn";
        const outputTokens = event.response?.usage?.output_tokens ?? 0;
        reset();
        return [
          ...prefix,
          {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
          },
          { type: "message_stop" },
        ];
      }

      return [];
    },
  };
}

const defaultNormalizer = createOpenAIStreamToAnthropicNormalizer();

export function resetOpenAIStreamNormalizer(): void {
  defaultNormalizer.reset();
}

export function openAIStreamEventToAnthropicEvents(event: OpenAIStreamEvent): AnthropicStreamEvent[] {
  return defaultNormalizer.convert(event);
}
