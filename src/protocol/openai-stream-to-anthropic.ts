import { openAIUsageToAnthropic, type BridgeUsage } from "./openai-usage.js";
import { OpenAIProtocolError, parseOpenAIFunctionArguments } from "./openai-function-call.js";

interface OpenAIStreamEventItem {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface OpenAIStreamEvent {
  type?: string;
  /** Present on `error` events and inside `response.failed`. */
  message?: string;
  code?: string;
  delta?: string;
  /** Index of the output item this event belongs to; absent on text-only streams. */
  output_index?: number;
  /** Completed `arguments` string, sent with `response.function_call_arguments.done`. */
  arguments?: string;
  item?: OpenAIStreamEventItem;
  response?: {
    id?: string;
    model?: string;
    error?: { message?: string; code?: string } | null;
    usage?: {
      input_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens?: number;
    };
  };
}

/**
 * Failure carried inside an HTTP 200 stream. Codex reports a rejected request
 * — an over-long context, for instance — as `response.failed` / `error` events
 * rather than a non-2xx status, so a caller that only checks `upstream.ok`
 * sees success and forwards an empty message.
 */
export function openAIStreamFailure(event: OpenAIStreamEvent): string | null {
  if (event.type === "error") return event.message ?? event.code ?? "upstream error";
  if (event.type === "response.failed") {
    const err = event.response?.error;
    return err?.message ?? err?.code ?? "upstream reported the response failed";
  }
  return null;
}

type AnthropicStreamEvent = Record<string, unknown>;

export interface OpenAIStreamToAnthropicNormalizer {
  convert(event: OpenAIStreamEvent): AnthropicStreamEvent[];
  reset(): void;
}

export interface OpenAIStreamNormalizerOptions {
  /**
   * Model name reported in message_start instead of the upstream's. A Claude
   * Code session routed to Codex otherwise sees "gpt-5.6-*", treats it as an
   * unrecognised model, and clamps its assumed context window to 200k — which
   * sends long conversations into autocompact thrashing.
   */
  modelOverride?: string;
  /** Called once per response with the usage carried by response.completed. */
  onUsage?: (usage: BridgeUsage) => void;
}

interface OpenBlock {
  /** Anthropic content-block index, assigned in the order blocks open. */
  index: number;
  kind: "text" | "tool_use";
  /** Whether any input_json_delta has been emitted for this tool_use block. */
  sentArgumentDelta: boolean;
  /**
   * Every argument fragment forwarded so far, concatenated. Kept so the whole
   * JSON can be validated once the item closes: the client is about to run
   * this tool, and arguments that do not parse mean it would run with
   * something the model never produced.
   */
  argumentsJson: string;
}

export function createOpenAIStreamToAnthropicNormalizer(
  opts: OpenAIStreamNormalizerOptions = {},
): OpenAIStreamToAnthropicNormalizer {
  /**
   * OpenAI `output_index` -> the Anthropic block opened for it. OpenAI's index
   * can skip values (reasoning items occupy slots we do not forward), while
   * Anthropic requires content blocks numbered contiguously from 0, so the two
   * are mapped rather than passed through.
   */
  let blocks = new Map<number, OpenBlock>();
  let nextIndex = 0;
  let sawToolUse = false;
  let sawRefusal = false;

  const reset = () => {
    blocks = new Map();
    nextIndex = 0;
    sawToolUse = false;
    sawRefusal = false;
  };

  const openTextBlock = (outputIndex: number): AnthropicStreamEvent[] => {
    if (blocks.has(outputIndex)) return [];
    const block: OpenBlock = { index: nextIndex++, kind: "text", sentArgumentDelta: false, argumentsJson: "" };
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
        return [
          {
            type: "message_start",
            message: {
              id: event.response?.id ?? "",
              type: "message",
              role: "assistant",
              model: opts.modelOverride ?? event.response?.model ?? "",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
        ];
      }

      // A function call announces itself with the full call_id/name up front;
      // only its arguments stream in afterwards. Text items are not opened here
      // — they stay lazy so a message item that never emits a delta does not
      // produce an empty text block.
      if (event.type === "response.output_item.added") {
        if (event.item?.type !== "function_call") return [];
        if (blocks.has(outputIndex)) return [];
        if (!event.item.call_id?.trim() || !event.item.name?.trim()) {
          throw new OpenAIProtocolError("Invalid OpenAI function call metadata");
        }
        const block: OpenBlock = {
          index: nextIndex++, kind: "tool_use", sentArgumentDelta: false, argumentsJson: "",
        };
        blocks.set(outputIndex, block);
        sawToolUse = true;
        return [{
          type: "content_block_start",
          index: block.index,
          content_block: {
            type: "tool_use",
            id: event.item.call_id,
            name: event.item.name,
            input: {},
          },
        }];
      }

      if (event.type === "response.output_text.delta") {
        const prefix = openTextBlock(outputIndex);
        const block = blocks.get(outputIndex);
        return [
          ...prefix,
          {
            type: "content_block_delta",
            index: block?.index ?? 0,
            delta: { type: "text_delta", text: event.delta ?? "" },
          },
        ];
      }

      // A refusal streams as text but is not an ordinary completion — it has to
      // reach the client as stop_reason "refusal", not "end_turn".
      if (event.type === "response.refusal.delta") {
        sawRefusal = true;
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
        block.sentArgumentDelta = true;
        block.argumentsJson += event.delta ?? "";
        return [{
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: event.delta ?? "" },
        }];
      }

      // Normally redundant — the deltas already carried the whole argument
      // string. It matters when upstream sends short arguments as a single
      // `done` with no preceding delta, which would otherwise leave the client
      // with a tool_use block whose input never arrived.
      if (event.type === "response.function_call_arguments.done") {
        const block = blocks.get(outputIndex);
        if (!block || block.kind !== "tool_use") return [];
        if (block.sentArgumentDelta || !event.arguments) return [];
        block.sentArgumentDelta = true;
        block.argumentsJson = event.arguments;
        return [{
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: event.arguments },
        }];
      }

      // The other way a stream can carry arguments atomically: no
      // `function_call_arguments.*` event at all, just the finished item. The
      // `sentArgumentDelta` guard is what keeps this from double-emitting when
      // the branch above already supplied them.
      if (event.type === "response.output_item.done") {
        const block = blocks.get(outputIndex);
        const atomicArguments = block?.kind === "tool_use" && !block.sentArgumentDelta
          ? event.item?.arguments ?? ""
          : "";
        if (block?.kind === "tool_use") {
          if (atomicArguments) block.argumentsJson = atomicArguments;
          // Throws if the accumulated JSON is unparseable. The item is closing,
          // so this is the last moment the whole argument string is known and
          // the attempt can still be failed instead of handed to the client.
          parseOpenAIFunctionArguments(block.argumentsJson);
        }
        const argumentEvent = block?.kind === "tool_use" && atomicArguments
          ? [{
              type: "content_block_delta",
              index: block.index,
              delta: { type: "input_json_delta", partial_json: atomicArguments },
            }]
          : [];
        return [...argumentEvent, ...closeBlock(outputIndex)];
      }

      if (event.type === "response.completed") {
        // A tool_use block still open at completion means the stream ended
        // mid-call: its arguments were never validated and may be truncated.
        // Closing it quietly would hand the client a tool call to run.
        if ([...blocks.values()].some(block => block.kind === "tool_use")) {
          throw new OpenAIProtocolError("OpenAI function call ended before completion");
        }
        const usage = event.response?.usage ?? {};
        // Anything still open (a stream that ended without per-item `done`
        // events) is closed here, in the order the blocks were opened.
        const prefix = [...blocks.keys()].flatMap(closeBlock);
        const stopReason = sawToolUse ? "tool_use" : sawRefusal ? "refusal" : "end_turn";
        const bridgedUsage = openAIUsageToAnthropic(usage);
        opts.onUsage?.(bridgedUsage);
        reset();
        return [
          ...prefix,
          {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            // Codex only reveals input_tokens at completion, so message_start
            // necessarily reported 0. Carrying the real figure here gives the
            // client its only accurate reading of context size this turn.
            usage: bridgedUsage,
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
