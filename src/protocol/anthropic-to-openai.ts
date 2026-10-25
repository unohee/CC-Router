import type {
  AnthropicBlock,
  AnthropicContent,
  AnthropicImageBlock,
  AnthropicMessagesRequest,
  AnthropicOtherBlock,
  AnthropicRole,
  AnthropicTool,
  AnthropicToolResultBlock,
} from "./anthropic-types.js";
import type {
  OpenAIInputContent,
  OpenAIInputItem,
  OpenAIInputRole,
  OpenAIResponsesRequest,
  OpenAITool,
} from "./openai-responses-types.js";
import { parseModelRef } from "./model-ref.js";
import type { ModelRoutingConfig } from "./model-ref.js";

function stringifySystem(system: AnthropicMessagesRequest["system"]): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system.map(block => block.text).join("\n");
}

function imageUrl(block: AnthropicImageBlock): string | null {
  const source = block.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined;
  if (source?.type === "base64" && source.media_type && source.data) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  if (source?.type === "url" && source.url) return source.url;
  return null;
}

/**
 * A tool result as the single string `function_call_output` carries. Images in
 * a result are named rather than dropped, so the model knows one was there.
 */
function toolResultOutput(block: AnthropicToolResultBlock): string {
  const content = block.content;
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map(item => (item.type === "text" ? item.text : "[image omitted]"))
    .join("\n");
}

/**
 * Expand one Anthropic message into Responses `input` items.
 *
 * Two shape rules are enforced here, both verified against the Codex backend
 * (2026-08-20) — violating either returns HTTP 400 `invalid_value`:
 *
 *  1. `function_call` / `function_call_output` are TOP-LEVEL input items, not
 *     blocks inside a message's `content`. A message carrying both text and a
 *     tool call therefore splits into several items, emitted in the original
 *     block order so the model sees the same sequence it produced.
 *  2. Assistant text is `output_text`; only user/system text is `input_text`.
 *
 * Every block kind is handled by name, and anything unrecognised is skipped
 * rather than assumed to be a tool result. Treating the unknown as a
 * `tool_result` threw on the first `thinking` or `tool_addition` block, and the
 * throw was swallowed as "Codex unavailable" — so every real Claude Code
 * request fell through to the next fallback while test requests, which carry
 * neither, went to Codex (measured 2026-10-26).
 */
function messageToOpenAIItems(role: AnthropicRole, content: AnthropicContent): OpenAIInputItem[] {
  const openAIRole: OpenAIInputRole = role;
  const textType = role === "assistant" ? "output_text" as const : "input_text" as const;

  if (typeof content === "string") {
    return [{ role: openAIRole, content: [{ type: textType, text: content }] }];
  }

  const items: OpenAIInputItem[] = [];
  let pending: OpenAIInputContent[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    items.push({ role: openAIRole, content: pending });
    pending = [];
  };

  for (const raw of content) {
    const block = raw as AnthropicBlock | AnthropicOtherBlock;
    switch (block.type) {
      case "text":
        pending.push({ type: textType, text: (block as { text: string }).text });
        continue;

      case "image": {
        // Images are only input; an assistant turn cannot carry one.
        const url = role === "assistant" ? null : imageUrl(block as AnthropicImageBlock);
        if (url) pending.push({ type: "input_image", image_url: url });
        continue;
      }

      case "tool_use": {
        const call = block as { id: string; name: string; input?: unknown };
        flush();
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input ?? {}),
        });
        continue;
      }

      case "tool_result": {
        const result = block as AnthropicToolResultBlock;
        flush();
        items.push({
          type: "function_call_output",
          call_id: result.tool_use_id,
          output: toolResultOutput(result),
        });
        continue;
      }

      // Anthropic's own reasoning: signed for Anthropic, meaningless to Codex.
      case "thinking":
      case "redacted_thinking":
      // Client notices that a deferred tool was loaded; the tool list itself
      // is what a function-calling target reads.
      case "tool_addition":
      // A server tool the upstream ran (the advisor, web search). Codex has no
      // such tool to call, so the call itself is dropped; see the default
      // branch for its result.
      case "server_tool_use":
        continue;

      default: {
        // Unknown kinds that carry text (a server tool's result, for one) keep
        // their text so the conversation does not lose what it said.
        const text = (block as AnthropicOtherBlock).text;
        if (typeof text === "string" && text) pending.push({ type: textType, text });
        continue;
      }
    }
  }

  flush();
  return items;
}

/** Only tools the target can call itself. Server tools have no input schema. */
function toOpenAITools(tools: AnthropicTool[] | undefined): OpenAITool[] | undefined {
  if (!tools) return undefined;
  return tools
    .filter((tool): tool is AnthropicTool & { input_schema: Record<string, unknown> } =>
      typeof tool.input_schema === "object" && tool.input_schema !== null)
    .map(tool => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    }));
}

export function anthropicToOpenAIResponses(
  req: AnthropicMessagesRequest,
  modelRouting: ModelRoutingConfig = {},
): OpenAIResponsesRequest {
  const parsed = parseModelRef(req.model, modelRouting);
  // Effort maps 1:1 — both sides use low/medium/high/xhigh/max. Omitted rather
  // than defaulted when absent, so the target model's own default applies.
  const effort = req.output_config?.effort?.trim();
  return {
    model: parsed.upstreamModel,
    ...(effort ? { reasoning: { effort } } : {}),
    instructions: stringifySystem(req.system),
    input: req.messages.flatMap(message => messageToOpenAIItems(message.role, message.content)),
    tools: toOpenAITools(req.tools),
    max_output_tokens: req.max_tokens,
    stream: req.stream,
  };
}
