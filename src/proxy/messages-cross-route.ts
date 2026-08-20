import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { selectRoute } from "../providers/route-selector.js";
import { anthropicToOpenAIResponses } from "../protocol/anthropic-to-openai.js";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";
import { createOpenAIStreamToAnthropicNormalizer } from "../protocol/openai-stream-to-anthropic.js";
import { encodeSseEvent, parseSseLines } from "../protocol/sse.js";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { AnthropicMessagesRequest } from "../protocol/anthropic-types.js";
import type { OpenAIFunctionCall, OpenAIResponseCompleted, OpenAIResponseOutputItem } from "../protocol/openai-responses-types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";

declare module "express-serve-static-core" {
  interface Request {
    _ccRawBody?: Buffer;
  }
}

type ForwardOpenAI = typeof forwardOpenAICodexResponse;

export interface MessagesCrossProviderRouteOptions {
  getOpenAIAccount: () => OpenAISubscriptionAccount | null;
  prepareOpenAIAccount?: (account: OpenAISubscriptionAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
  /** Opt-in: when true, exhausted Anthropic capacity triggers automatic OpenAI fallback. Default false. */
  crossProviderFallback?: boolean;
  /** Point-in-time Anthropic-pool availability check (TokenPool.hasAvailableAccount). Required when crossProviderFallback is true. */
  hasAvailableAnthropicAccount?: () => boolean;
  /** Fired after a successful automatic fallback so the caller can log/record it. */
  onFallback?: (info: { openAIAccountId: string; upstreamModel: string }) => void;
}

type OpenAIForwardOutcome =
  | { ok: true; account: OpenAISubscriptionAccount }
  | { ok: false; reason: "no_account" | "prepare_failed" | "request_failed" };

/**
 * Shared account-select -> prepare -> translate -> forward -> translate-back
 * pipeline, used by both the explicit `openai/*` route and the automatic
 * cross-provider fallback below. Never throws; failures are reported via the
 * returned outcome so callers can decide how to react (hard error vs. silent
 * fall-through).
 *
 * Everything from account preparation onward is wrapped in try/catch: token
 * refresh (`prepareOpenAIAccount`) and the forward/translate step both do
 * real network I/O with no internal try/catch of their own, so either can
 * throw (DNS failure, connection reset, timeout) rather than resolving to
 * `false`. That must not become an unhandled rejection — the fallback
 * caller's whole "never worse than the degraded Anthropic path" guarantee
 * depends on this function always resolving. If the error happens after
 * `res` already started being written (mid-stream), there is nothing safe
 * left to do — writing anything more, including a further response via
 * `next()`, would corrupt the response — so that case is reported as
 * handled (`ok: true`) rather than a failure the caller could act on.
 *
 * `passThroughUpstreamErrors` controls what happens when OpenAI itself
 * responds with a non-2xx status (429, 500, ...) — a real HTTP response, not
 * a thrown error. The explicit `openai/*` route passes `true`: the user
 * asked for OpenAI specifically, so its error should be surfaced as-is, same
 * as the main Anthropic proxy does for Anthropic errors. The automatic
 * fallback route passes `false`: an OpenAI error there must count as "OpenAI
 * unavailable too" and fall through to the degraded Anthropic path, not be
 * written to the client as if the fallback had succeeded.
 */
async function forwardAnthropicRequestAsOpenAI(
  reqBody: AnthropicMessagesRequest,
  res: Response,
  requestedStream: boolean,
  getOpenAIAccount: () => OpenAISubscriptionAccount | null,
  prepareOpenAIAccount: (account: OpenAISubscriptionAccount) => Promise<boolean>,
  forwardOpenAI: ForwardOpenAI,
  modelRouting: ModelRoutingConfig | undefined,
  passThroughUpstreamErrors: boolean,
): Promise<OpenAIForwardOutcome> {
  const account = getOpenAIAccount();
  if (!account) return { ok: false, reason: "no_account" };

  try {
    const ready = await prepareOpenAIAccount(account);
    if (!ready) return { ok: false, reason: "prepare_failed" };

    const body = anthropicToOpenAIResponses(reqBody, modelRouting);
    const upstream = await forwardOpenAI({
      account,
      body,
      stream: body.stream === true,
    });

    if (!upstream.ok && !passThroughUpstreamErrors) {
      return { ok: false, reason: "request_failed" };
    }

    await sendOpenAIAsAnthropic(upstream, res, requestedStream);
    return { ok: true, account };
  } catch (err) {
    if (res.headersSent) {
      console.error(`[cross-route] OpenAI request to "${account.id}" failed after the response had already started: ${(err as Error).message}`);
      return { ok: true, account };
    }
    return { ok: false, reason: "request_failed" };
  }
}

function isAnthropicMessagesRequest(value: unknown): value is AnthropicMessagesRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

async function sendOpenAIAsAnthropic(
  upstream: globalThis.Response,
  res: Response,
  requestedStream: boolean,
): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (requestedStream) {
      await sendOpenAIStreamAsAnthropic(upstream, res);
      return;
    }

    res.status(upstream.status).json(await collectOpenAIStreamAsAnthropicMessage(upstream));
    return;
  }

  if (!contentType.includes("application/json")) {
    res.status(upstream.status);
    res.setHeader("content-type", contentType || "text/plain");
    res.send(await upstream.text());
    return;
  }

  const json = await upstream.json() as OpenAIResponseCompleted;
  res.status(upstream.status).json(openAIResponseToAnthropicMessage(json));
}

async function collectOpenAIStreamAsAnthropicMessage(upstream: globalThis.Response): Promise<ReturnType<typeof openAIResponseToAnthropicMessage>> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return openAIResponseToAnthropicMessage({ id: "", model: "", output: [], usage: {} });
  }

  const decoder = new TextDecoder();
  let remainder = "";
  let id = "";
  let model = "";
  let usage: OpenAIResponseCompleted["usage"] = {};
  // Keyed by OpenAI `output_index` so text and tool calls can be re-emitted in
  // the order the model produced them, rather than text-then-tools.
  const textByIndex = new Map<number, string>();
  const callsByIndex = new Map<number, OpenAIFunctionCall>();

  const applyEvent = (event: unknown) => {
    if (typeof event !== "object" || event === null) return;
    const openAIEvent = event as {
      type?: string;
      delta?: string;
      output_index?: number;
      item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
      response?: {
        id?: string;
        model?: string;
        usage?: OpenAIResponseCompleted["usage"];
      };
    };
    const outputIndex = openAIEvent.output_index ?? 0;

    if (openAIEvent.type === "response.created") {
      id = openAIEvent.response?.id ?? id;
      model = openAIEvent.response?.model ?? model;
      return;
    }

    if (openAIEvent.type === "response.output_text.delta") {
      textByIndex.set(outputIndex, (textByIndex.get(outputIndex) ?? "") + (openAIEvent.delta ?? ""));
      return;
    }

    // `output_item.done` carries the finished call in one piece (call_id, name
    // and the complete arguments string), so the argument deltas need not be
    // reassembled here.
    if (openAIEvent.type === "response.output_item.done") {
      const item = openAIEvent.item;
      if (item?.type === "function_call" && item.call_id) {
        callsByIndex.set(outputIndex, {
          type: "function_call",
          call_id: item.call_id,
          name: item.name ?? "",
          arguments: item.arguments ?? "",
        });
      }
      return;
    }

    if (openAIEvent.type === "response.completed") {
      id = openAIEvent.response?.id ?? id;
      model = openAIEvent.response?.model ?? model;
      usage = openAIEvent.response?.usage ?? usage;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }));
    remainder = parsed.remainder;
    parsed.events.forEach(applyEvent);
  }

  const tail = decoder.decode();
  if (tail || remainder) {
    parseSseLines(remainder + tail + "\n").events.forEach(applyEvent);
  }

  const output: OpenAIResponseOutputItem[] = [...new Set([...textByIndex.keys(), ...callsByIndex.keys()])]
    .sort((a, b) => a - b)
    .flatMap((index): OpenAIResponseOutputItem[] => {
      const call = callsByIndex.get(index);
      if (call) return [call];
      const text = textByIndex.get(index);
      return text ? [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      }] : [];
    });

  return openAIResponseToAnthropicMessage({ id, model, output, usage });
}

async function sendOpenAIStreamAsAnthropic(upstream: globalThis.Response, res: Response): Promise<void> {
  res.status(upstream.status);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.flushHeaders?.();

  const normalizer = createOpenAIStreamToAnthropicNormalizer();
  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let remainder = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }));
      remainder = parsed.remainder;
      for (const event of parsed.events) {
        for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
          res.write(encodeSseEvent(mapped));
        }
      }
    }

    const tail = decoder.decode();
    if (tail || remainder) {
      const parsed = parseSseLines(remainder + tail + "\n");
      for (const event of parsed.events) {
        for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
          res.write(encodeSseEvent(mapped));
        }
      }
    }
  } finally {
    res.end();
  }
}

export function mountMessagesCrossProviderRoute(
  app: Express,
  opts: MessagesCrossProviderRouteOptions,
): void {
  const forwardOpenAI = opts.forwardOpenAI ?? forwardOpenAICodexResponse;
  const prepareOpenAIAccount = opts.prepareOpenAIAccount ?? (async () => true);

  app.post(
    "/v1/messages",
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        (req as Request)._ccRawBody = Buffer.from(buf);
      },
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      if (!isAnthropicMessagesRequest(req.body)) {
        res.status(400).json({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Expected Anthropic Messages request with messages array",
          },
        });
        return;
      }

      const route = selectRoute(req.body.model, opts.modelRouting);
      const requestedStream = req.body.stream === true;

      if (route.provider === "openai_subscription") {
        const outcome = await forwardAnthropicRequestAsOpenAI(
          req.body, res, requestedStream,
          opts.getOpenAIAccount, prepareOpenAIAccount, forwardOpenAI, opts.modelRouting,
          /* passThroughUpstreamErrors */ true,
        );
        if (!outcome.ok) {
          if (outcome.reason === "no_account") {
            res.status(503).json({
              type: "error",
              error: {
                type: "no_accounts",
                message: "No OpenAI subscription accounts are configured",
              },
            });
          } else if (outcome.reason === "prepare_failed") {
            res.status(401).json({
              type: "error",
              error: {
                type: "authentication_error",
                message: "OpenAI subscription token refresh failed",
              },
            });
          } else {
            res.status(502).json({
              type: "error",
              error: {
                type: "api_error",
                message: "OpenAI subscription request failed",
              },
            });
          }
        }
        return;
      }

      // route.provider === "anthropic_subscription" — bare/anthropic model name.
      // Opt-in automatic fallback: only consider it when every Anthropic account
      // is currently exhausted AND an OpenAI default model is actually configured
      // (otherwise "openai/default" would resolve to the literal string "default"
      // and go out as a bogus upstream model). Any failure here is silent — this
      // must never turn into a harder failure than the degraded Anthropic path
      // the request would have taken anyway.
      const openAIDefaultModel = opts.modelRouting?.openAIDefaultModel?.trim();
      const anthropicExhausted =
        opts.crossProviderFallback === true &&
        opts.hasAvailableAnthropicAccount?.() === false;

      if (anthropicExhausted && openAIDefaultModel) {
        const outcome = await forwardAnthropicRequestAsOpenAI(
          { ...req.body, model: "openai/default" }, res, requestedStream,
          opts.getOpenAIAccount, prepareOpenAIAccount, forwardOpenAI, opts.modelRouting,
          /* passThroughUpstreamErrors */ false,
        );
        if (outcome.ok) {
          opts.onFallback?.({ openAIAccountId: outcome.account.id, upstreamModel: openAIDefaultModel });
          return;
        }
        // OpenAI unavailable too — fall through to the normal (degraded) Anthropic path.
      }

      next();
    },
  );
}
