import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { selectRoute } from "../providers/route-selector.js";
import { openAIModelForClaudeModel } from "../protocol/model-ref.js";
import { anthropicToOpenAIResponses } from "../protocol/anthropic-to-openai.js";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";
import { createOpenAIStreamToAnthropicNormalizer, openAIStreamFailure } from "../protocol/openai-stream-to-anthropic.js";
import { encodeSseEvent, parseSseLines } from "../protocol/sse.js";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { AnthropicMessagesRequest } from "../protocol/anthropic-types.js";
import type { OpenAIFunctionCall, OpenAIResponseCompleted, OpenAIResponseOutputItem } from "../protocol/openai-responses-types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";
import type { SessionTarget } from "./session-router.js";

declare module "express-serve-static-core" {
  interface Request {
    _ccRawBody?: Buffer;
    /** Set once per request so the downstream Anthropic proxy reuses this
     *  session's pinned account instead of drawing a fresh one. */
    _ccSessionTarget?: SessionTarget;
  }
}

type ForwardOpenAI = typeof forwardOpenAICodexResponse;

export interface OpenAIActivity {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  source: "cli" | "desktop" | "api";
  sessionId?: string;
}

type OpenAIRouteInfo = OpenAIActivity & {
  openAIAccountId: string;
  upstreamModel: string;
  usage?: OpenAIUsage;
};

export interface MessagesCrossProviderRouteOptions {
  /** Select an OpenAI account. `preferredAccountId` asks for one specific
   *  account (session affinity); implementations fall back to their own
   *  rotation when it is absent or cannot serve. */
  getOpenAIAccount: (preferredAccountId?: string) => OpenAISubscriptionAccount | null;
  prepareOpenAIAccount?: (account: OpenAISubscriptionAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
  /** Opt-in: when true, exhausted Anthropic capacity triggers automatic OpenAI fallback. Default false. */
  crossProviderFallback?: boolean;
  /** Point-in-time Anthropic-pool availability check (TokenPool.hasAvailableAccount). Required when crossProviderFallback is true. */
  hasAvailableAnthropicAccount?: () => boolean;
  /** Fired after a successful automatic fallback so the caller can log/record it. */
  onFallback?: (info: OpenAIRouteInfo) => void;
  /** Resolve the account this session is pinned to. Called at most once per
   *  request — it advances the assignment cursor for sessions seen first time. */
  resolveSessionTarget?: (sessionId: string) => SessionTarget | null;
  /** Read an existing pin without creating one. Used on the explicit `openai/*`
   *  route, which must honour an existing pin but must not itself decide that a
   *  session belongs to OpenAI — that would silently divert the session's later
   *  Claude-model requests too. */
  peekSessionTarget?: (sessionId: string) => SessionTarget | null;
  /** Fired when a session pinned to OpenAI serves a Claude-model request there. */
  onSessionRoute?: (info: OpenAIRouteInfo & { sessionId: string }) => void;
  /** Fired when an explicit `openai/*` request is served. Without it this path
   *  leaves no trace, so OpenAI traffic is invisible in logs and the dashboard. */
  onExplicitRoute?: (info: OpenAIRouteInfo) => void;
}

export interface OpenAIUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Raised when an HTTP 200 stream carries a failure before any byte reached the client. */
class UpstreamStreamFailure extends Error {}

type OpenAIForwardOutcome =
  | { ok: true; account: OpenAISubscriptionAccount; usage?: OpenAIUsage }
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
  getOpenAIAccount: (preferredAccountId?: string) => OpenAISubscriptionAccount | null,
  prepareOpenAIAccount: (account: OpenAISubscriptionAccount) => Promise<boolean>,
  forwardOpenAI: ForwardOpenAI,
  modelRouting: ModelRoutingConfig | undefined,
  passThroughUpstreamErrors: boolean,
  /** Session-pinned account, when this request belongs to a session assigned
   *  to a specific OpenAI account. Without it the caller's rotation decides. */
  preferredAccountId?: string,
  /** Model name to report back in place of the upstream's. Set on routes where
   *  the caller asked for a Claude model: reporting "gpt-5.6-*" makes Claude
   *  Code treat the model as unrecognised and clamp its assumed context window
   *  to 200k, which drives long conversations into autocompact thrashing. */
  publicModel?: string,
): Promise<OpenAIForwardOutcome> {
  const account = getOpenAIAccount(preferredAccountId);
  if (!account) return { ok: false, reason: "no_account" };

  let observedUsage: OpenAIUsage | undefined;
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

    await sendOpenAIAsAnthropic(upstream, res, requestedStream, publicModel, usage => {
      observedUsage = usage;
    });
    return { ok: true, account, usage: observedUsage };
  } catch (err) {
    if (err instanceof UpstreamStreamFailure) {
      // Reported inside a 200 stream, before anything was written — treat it
      // like any other failed attempt so the caller can degrade to Anthropic.
      console.error(`[cross-route] OpenAI account "${account.id}" rejected the request: ${err.message}`);
      return { ok: false, reason: "request_failed" };
    }
    if (res.headersSent) {
      console.error(`[cross-route] OpenAI request to "${account.id}" failed after the response had already started: ${(err as Error).message}`);
      return { ok: true, account, usage: observedUsage };
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

function openAIActivity(req: Request, res: Response, startedAt: number, sessionId: string): OpenAIActivity {
  const source = sessionId
    ? "cli" as const
    : req.headers["x-api-key"]
    ? "desktop" as const
    : "api" as const;

  return {
    method: req.method,
    path: req.path,
    statusCode: res.statusCode,
    durationMs: Date.now() - startedAt,
    source,
    ...(sessionId ? { sessionId } : {}),
  };
}

async function sendOpenAIAsAnthropic(
  upstream: globalThis.Response,
  res: Response,
  requestedStream: boolean,
  publicModel?: string,
  onUsage?: (usage: OpenAIUsage) => void,
): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (requestedStream) {
      await sendOpenAIStreamAsAnthropic(upstream, res, publicModel, onUsage);
      return;
    }

    const collected = await collectOpenAIStreamAsAnthropicMessage(upstream);
    if (publicModel) collected.model = publicModel;
    onUsage?.({ input_tokens: collected.usage.input_tokens, output_tokens: collected.usage.output_tokens });
    res.status(upstream.status).json(collected);
    return;
  }

  if (!contentType.includes("application/json")) {
    res.status(upstream.status);
    res.setHeader("content-type", contentType || "text/plain");
    res.send(await upstream.text());
    return;
  }

  const json = await upstream.json() as OpenAIResponseCompleted;
  const message = openAIResponseToAnthropicMessage(json);
  if (publicModel) message.model = publicModel;
  onUsage?.({ input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens });
  res.status(upstream.status).json(message);
}

async function collectOpenAIStreamAsAnthropicMessage(upstream: globalThis.Response): Promise<ReturnType<typeof openAIResponseToAnthropicMessage>> {
  // Throws UpstreamStreamFailure when the 200 stream carried a rejection, so
  // the caller degrades instead of returning an empty message.
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
  let collectedFailure: string | null = null;

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
      return;
    }

    const failure = openAIStreamFailure(openAIEvent as Parameters<typeof openAIStreamFailure>[0]);
    if (failure) collectedFailure ??= failure;
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

  if (collectedFailure) throw new UpstreamStreamFailure(collectedFailure);
  return openAIResponseToAnthropicMessage({ id, model, output, usage });
}

async function sendOpenAIStreamAsAnthropic(
  upstream: globalThis.Response,
  res: Response,
  publicModel?: string,
  onUsage?: (usage: OpenAIUsage) => void,
): Promise<void> {
  res.status(upstream.status);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  // Headers are NOT flushed yet: an upstream failure can still arrive as the
  // first event, and flushing would commit this response to OpenAI.

  const normalizer = createOpenAIStreamToAnthropicNormalizer({ modelOverride: publicModel, onUsage });
  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let remainder = "";
  let wroteAnything = false;

  // message_start is emitted from response.created, which always precedes the
  // response.failed that reports a rejection. Writing it immediately would
  // commit the response to OpenAI before knowing the request was even
  // accepted, so the opening events are held until real content appears.
  let pending: Record<string, unknown>[] = [];
  const commit = (event: Record<string, unknown>) => {
    pending.push(event);
    const type = event["type"];
    const isContent = type === "content_block_start" || type === "content_block_delta"
      || type === "content_block_stop" || type === "message_delta";
    if (!isContent) return;
    if (!wroteAnything) res.flushHeaders?.();
    for (const held of pending) res.write(encodeSseEvent(held));
    pending = [];
    wroteAnything = true;
  };
  const flushPending = () => {
    if (pending.length === 0) return;
    if (!wroteAnything) res.flushHeaders?.();
    for (const held of pending) res.write(encodeSseEvent(held));
    pending = [];
    wroteAnything = true;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }));
      remainder = parsed.remainder;
      for (const event of parsed.events) {
        // Codex reports a rejected request (an over-long context, say) inside
        // an HTTP 200 stream. Nothing downstream would notice: the normalizer
        // ignores these events and the client receives an empty message. While
        // no bytes have gone out yet the request is still salvageable, so this
        // is raised for the caller to retry on Anthropic.
        const failure = openAIStreamFailure(event as Parameters<typeof normalizer.convert>[0]);
        if (failure && !wroteAnything) throw new UpstreamStreamFailure(failure);

        for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
          commit(mapped);
        }
      }
    }

    const tail = decoder.decode();
    if (tail || remainder) {
      const parsed = parseSseLines(remainder + tail + "\n");
      for (const event of parsed.events) {
        const failure = openAIStreamFailure(event as Parameters<typeof normalizer.convert>[0]);
        if (failure && !wroteAnything) throw new UpstreamStreamFailure(failure);

        for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
          commit(mapped);
        }
      }
    }

    // A stream that produced nothing but an opening still has to be delivered.
    flushPending();
  } catch (err) {
    // A pre-first-byte failure leaves the response untouched so the caller can
    // still fall through to Anthropic; anything else ends the stream as before.
    if (err instanceof UpstreamStreamFailure && !wroteAnything) throw err;
    res.end();
    return;
  }
  res.end();
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
      const startedAt = Date.now();
      const sessionId = String(req.headers["x-claude-code-session-id"] ?? "").trim();

      if (route.provider === "openai_subscription") {
        // An explicit openai/* request from a session already pinned to an
        // OpenAI account stays on that account, so its prompt cache survives.
        // Peek rather than resolve: asking for a new assignment here would pin
        // the whole session to OpenAI on the strength of one explicit call.
        const pinned = sessionId && opts.peekSessionTarget
          ? opts.peekSessionTarget(sessionId)
          : null;

        const outcome = await forwardAnthropicRequestAsOpenAI(
          req.body, res, requestedStream,
          opts.getOpenAIAccount, prepareOpenAIAccount, forwardOpenAI, opts.modelRouting,
          /* passThroughUpstreamErrors */ true,
          pinned?.provider === "openai" ? pinned.accountId : undefined,
        );
        if (outcome.ok) {
          opts.onExplicitRoute?.({
            openAIAccountId: outcome.account.id,
            upstreamModel: route.upstreamModel,
            usage: outcome.usage,
            ...openAIActivity(req, res, startedAt, sessionId),
          });
        }
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
      //
      // `openAIDefaultModel` gates cross-provider routing: without it configured
      // there is no sanctioned OpenAI target, and the request stays on Anthropic.
      // The model actually sent preserves the request's tier, so an opus request
      // is not answered by the model chosen for sonnet; unrecognised Claude names
      // fall back to the configured default. Any failure below is silent — it
      // must never be a harder failure than the degraded Anthropic path the
      // request would have taken anyway.
      const openAIDefaultModel = opts.modelRouting?.openAIDefaultModel?.trim();
      const tieredModel = openAIModelForClaudeModel(req.body.model, opts.modelRouting)
        ?? openAIDefaultModel;

      // Session affinity. Resolved once here and stashed on the request so the
      // Anthropic proxy downstream reuses the same decision rather than
      // resolving again (which would advance the assignment cursor twice).
      const sessionTarget = sessionId && opts.resolveSessionTarget
        ? opts.resolveSessionTarget(sessionId)
        : null;
      if (sessionTarget) req._ccSessionTarget = sessionTarget;

      // This session belongs to an OpenAI account, so its Claude-model requests
      // go there too — that is what keeps a conversation on one provider
      // instead of alternating models mid-thread. A failure here is silent and
      // falls through to Anthropic, same as the fallback path below.
      if (sessionTarget?.provider === "openai" && openAIDefaultModel && tieredModel) {
        const outcome = await forwardAnthropicRequestAsOpenAI(
          { ...req.body, model: `openai/${tieredModel}` }, res, requestedStream,
          opts.getOpenAIAccount, prepareOpenAIAccount, forwardOpenAI, opts.modelRouting,
          /* passThroughUpstreamErrors */ false,
          sessionTarget.accountId,
          /* publicModel */ req.body.model,
        );
        if (outcome.ok) {
          opts.onSessionRoute?.({
            sessionId,
            openAIAccountId: outcome.account.id,
            upstreamModel: tieredModel,
            usage: outcome.usage,
            ...openAIActivity(req, res, startedAt, sessionId),
          });
          return;
        }
      }

      const anthropicExhausted =
        opts.crossProviderFallback === true &&
        opts.hasAvailableAnthropicAccount?.() === false;

      if (anthropicExhausted && openAIDefaultModel && tieredModel) {
        const outcome = await forwardAnthropicRequestAsOpenAI(
          { ...req.body, model: `openai/${tieredModel}` }, res, requestedStream,
          opts.getOpenAIAccount, prepareOpenAIAccount, forwardOpenAI, opts.modelRouting,
          /* passThroughUpstreamErrors */ false,
          /* preferredAccountId */ undefined,
          /* publicModel */ req.body.model,
        );
        if (outcome.ok) {
          opts.onFallback?.({
            openAIAccountId: outcome.account.id,
            upstreamModel: tieredModel,
            usage: outcome.usage,
            ...openAIActivity(req, res, startedAt, sessionId),
          });
          return;
        }
        // OpenAI unavailable too — fall through to the normal (degraded) Anthropic path.
      }

      next();
    },
  );
}
