import type { OpenAIResponseCompleted } from "./openai-responses-types.js";

export interface BridgeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

/** OpenAI input includes cached tokens; Anthropic input excludes them. */
export function openAIUsageToAnthropic(usage: OpenAIResponseCompleted["usage"]): BridgeUsage {
  const input = usage?.input_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens;
  const read = typeof cached === "number" && Number.isFinite(cached)
    ? Math.max(0, Math.min(input, cached)) : undefined;
  return {
    input_tokens: input - (read ?? 0),
    output_tokens: usage?.output_tokens ?? 0,
    ...(read !== undefined ? { cache_read_input_tokens: read } : {}),
  };
}
