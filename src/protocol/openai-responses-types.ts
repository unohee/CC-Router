export type OpenAIInputRole = "system" | "user" | "assistant" | "tool";

export interface OpenAIInputText {
  type: "input_text";
  text: string;
}

export interface OpenAIOutputText {
  type: "output_text";
  text: string;
}

export interface OpenAIFunctionCall {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface OpenAIFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type OpenAIInputContent =
  | OpenAIInputText
  | OpenAIOutputText
  | OpenAIFunctionCall
  | OpenAIFunctionCallOutput;

export interface OpenAIInputMessage {
  role: OpenAIInputRole;
  content: OpenAIInputContent[];
}

/**
 * One entry of a Responses request's `input` array. Function calls and their
 * outputs are TOP-LEVEL items, siblings of messages — not blocks nested inside
 * a message's `content`. Nesting them is rejected upstream with HTTP 400
 * `invalid_value` (verified against the Codex backend, 2026-08-20).
 */
export type OpenAIInputItem =
  | OpenAIInputMessage
  | OpenAIFunctionCall
  | OpenAIFunctionCallOutput;

export interface OpenAITool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface OpenAIResponsesRequest {
  model: string;
  instructions?: string;
  input: OpenAIInputItem[];
  tools?: OpenAITool[];
  max_output_tokens?: number;
  stream?: boolean;
  store?: boolean;
  /** Reasoning depth. Verified 2026-08-20: omitting it yields "medium" on
   *  gpt-5.6-sol, despite that model's metadata advertising "low". */
  reasoning?: {
    effort?: string;
  };
}

export interface OpenAIResponseOutputMessage {
  type: "message";
  role?: "assistant";
  content: OpenAIOutputText[];
}

/**
 * One entry of a completed response's `output` array, and equally the `item`
 * payload of `response.output_item.added` / `.done` stream events. Function
 * calls reuse the input-side `OpenAIFunctionCall` shape: the Responses API
 * emits the same `{call_id, name, arguments}` fields in both directions.
 */
export type OpenAIResponseOutputItem =
  | OpenAIResponseOutputMessage
  | OpenAIFunctionCall;

export interface OpenAIResponseCompleted {
  id: string;
  model?: string;
  output?: OpenAIResponseOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}
