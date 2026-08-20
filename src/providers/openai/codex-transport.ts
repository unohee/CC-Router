import type { OpenAIResponsesRequest } from "../../protocol/openai-responses-types.js";
import type { OpenAISubscriptionAccount } from "./token-refresher.js";
import { extractCodexRateLimits } from "./rate-limits.js";

const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_CODEX_INSTRUCTIONS = "You are a concise coding assistant.";

export interface ForwardOpenAICodexResponseOptions {
  account: OpenAISubscriptionAccount;
  body: OpenAIResponsesRequest;
  stream: boolean;
}

export async function forwardOpenAICodexResponse(
  opts: ForwardOpenAICodexResponseOptions,
): Promise<Response> {
  const body = toCodexBackendRequest(opts.body);
  const upstream = await fetch(CODEX_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.account.accessToken}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
  recordCodexUsage(opts.account, upstream);
  return ensureEventStreamContentType(upstream);
}

export function toCodexBackendRequest(body: OpenAIResponsesRequest): OpenAIResponsesRequest & {
  instructions: string;
  store: false;
  stream: true;
} {
  const { max_output_tokens: _maxOutputTokens, ...rest } = body;
  return {
    ...rest,
    instructions: body.instructions?.trim() || DEFAULT_CODEX_INSTRUCTIONS,
    store: false,
    stream: true,
  };
}

function ensureEventStreamContentType(upstream: Response): Response {
  const contentType = upstream.headers.get("content-type");
  if (contentType?.includes("text/event-stream")) return upstream;

  const headers = new Headers(upstream.headers);
  headers.set("content-type", "text/event-stream");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * Fold one response's accounting into the account: request/error counts and the
 * quota Codex reports in headers. Called for every forward — the headers are
 * the only place this quota is published, so skipping a response loses that
 * window's reading entirely.
 */
function recordCodexUsage(account: OpenAISubscriptionAccount, upstream: Response): void {
  account.requestCount = (account.requestCount ?? 0) + 1;
  account.lastUsed = Date.now();
  if (!upstream.ok) account.errorCount = (account.errorCount ?? 0) + 1;

  const limits = extractCodexRateLimits(name => upstream.headers.get(name) ?? "");
  if (limits) account.rateLimits = limits;
}
