/** Claude Code also sends mid-conversation `system` messages (environment and
 *  tool-loading notices), observed 2026-10-26 on 2.1.309. */
export type AnthropicRole = "user" | "assistant" | "system";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  /** Optional upstream: a tool that returned nothing sends no content at all. */
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
}

/**
 * Any other block Claude Code sends: `thinking` / `redacted_thinking` from
 * earlier turns, `tool_addition` notices for deferred tools, `server_tool_use`
 * and its result when a server tool such as the advisor ran. New kinds appear
 * with client releases, so the converter must not assume the list is closed.
 */
export interface AnthropicOtherBlock {
  type: string;
  [key: string]: unknown;
}

export type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock;

export type AnthropicContent =
  | string
  | Array<AnthropicBlock | AnthropicOtherBlock>;

export interface AnthropicMessage {
  role: AnthropicRole;
  content: AnthropicContent;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  /** Absent on server tools (`type: "advisor_20260301"`, web search, ...),
   *  which the upstream runs itself and a function-calling target cannot. */
  input_schema?: Record<string, unknown>;
  type?: string;
}

export interface AnthropicMessagesRequest {
  model?: string;
  max_tokens?: number;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
  /** Claude 4.6+ reasoning-depth control. Maps onto the Codex `reasoning.effort`
   *  axis, which accepts the same low/medium/high/xhigh/max names. */
  output_config?: {
    effort?: string;
  };
  /** Passed through untouched: Codex always reasons, so there is no "disabled"
   *  equivalent to translate to. Declared so the field is not silently dropped
   *  by object rest when the request is rewritten. */
  thinking?: {
    type?: string;
    display?: string;
  };
}
