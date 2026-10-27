import { createHash } from "node:crypto";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { selectRoute } from "../providers/route-selector.js";
import { openAIModelForClaudeModel } from "../protocol/model-ref.js";
import { anthropicToOpenAIResponses } from "../protocol/anthropic-to-openai.js";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";
import { OpenAIProtocolError } from "../protocol/openai-function-call.js";
import { createOpenAIStreamToAnthropicNormalizer, openAIStreamFailure } from "../protocol/openai-stream-to-anthropic.js";
import { encodeSseEvent, parseSseLines } from "../protocol/sse.js";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import { codexCanHold, estimatePromptTokens } from "../providers/openai/context-limits.js";
import { decideOllamaFallback } from "../providers/ollama/fallback-policy.js";
import type { OllamaDecision, ResolvedOllamaFallbackConfig } from "../providers/ollama/fallback-policy.js";
import { forwardToOllama } from "../providers/ollama/transport.js";
import type { OllamaUsage } from "../providers/ollama/transport.js";
import {
  decideMigration,
  type PinBlock, type CompactAskGuard,
} from "./session-migration.js";
import type { SessionContextTracker } from "./session-context-tracker.js";
import type { AnthropicMessagesRequest } from "../protocol/anthropic-types.js";
import type { OpenAIFunctionCall, OpenAIResponseCompleted, OpenAIResponseOutputItem } from "../protocol/openai-responses-types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";
import type { SessionTarget } from "./session-router.js";
import type { TierModels } from "../providers/tier-matching.js";

declare module "express-serve-static-core" {
  interface Request {
    _ccRawBody?: Buffer;
    /** Set once per request so the downstream Anthropic proxy reuses this
     *  session's pinned account instead of drawing a fresh one. */
    _ccSessionTarget?: SessionTarget;
    _ccAnthropicModel?: string;
  }
}

type ForwardOpenAI = typeof forwardOpenAICodexResponse;

export interface OpenAIActivity {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  /** Same as durationMs here: these routes log once the response has ended. */
  totalMs: number;
  source: "cli" | "desktop" | "api";
  sessionId?: string;
}

type OpenAIRouteInfo = OpenAIActivity & {
  openAIAccountId: string;
  upstreamModel: string;
  usage?: OpenAIUsage;
  /** The response started and then the upstream failed. Its bytes are already
   *  gone, so it still counts as served, but not as a success. */
  failedAfterStart?: boolean;
  /** The client hung up before the response finished. Served, but neither a
   *  success nor an upstream error. */
  clientClosed?: boolean;
};

export type OllamaRouteInfo = OpenAIActivity & {
  upstreamModel: string;
  /** Seconds until the Anthropic pool frees up, as it read when deciding. */
  poolWaitSeconds: number;
  usage?: OllamaUsage;
  failedAfterStart?: boolean;
  /** The client hung up mid-response. Served, but neither a success nor an
   *  upstream error. */
  clientClosed?: boolean;
};

/** Present only when ProxyConfig.ollamaFallback is enabled. Absent, the
 *  routes below do no Ollama work at all. */
export interface OllamaFallbackRouteOptions {
  config: ResolvedOllamaFallbackConfig;
  /** TokenPool.secondsUntilAvailable. */
  poolWaitSeconds: (model?: string) => number;
  /** Read per request so a rotated key takes effect without a restart. */
  apiKey: () => string | undefined;
  /** Same upstream timeout as the Anthropic proxy. */
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Ollama tiers matched from the live catalog; empty unless `autoTierMap` is on. */
  matchedTiers?: () => TierModels;
}

export interface MessagesCrossProviderRouteOptions {
  /** Select an OpenAI account. `preferredAccountId` asks for one specific
   *  account (session affinity); implementations fall back to their own
   *  rotation when it is absent or cannot serve. */
  getOpenAIAccount: (preferredAccountId?: string) => OpenAISubscriptionAccount | null;
  prepareOpenAIAccount?: (account: OpenAISubscriptionAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
  /** Codex tiers matched from the live catalog; empty unless
   *  `modelRouting.openAIAutoTierMap` is on. Fills tiers `openAITierMap` leaves unset. */
  matchedOpenAITiers?: () => TierModels;
  /** Opt-in: when true, exhausted Anthropic capacity triggers automatic OpenAI fallback. Default false. */
  crossProviderFallback?: boolean;
  /** Point-in-time Anthropic-pool availability check (TokenPool.hasAvailableAccount). Required when crossProviderFallback is true. */
  hasAvailableAnthropicAccount?: (model?: string) => boolean;
  /** Fired after a successful automatic fallback so the caller can log/record it. */
  onFallback?: (info: OpenAIRouteInfo) => void;
  /** Resolve the account this session is pinned to. Called at most once per
   *  request — it advances the assignment cursor for sessions seen first time.
   *  `estimatedPromptTokens` lets the implementation refuse a target that could
   *  not hold this conversation; null means the size could not be measured. */
  resolveSessionTarget?: (
    sessionId: string,
    estimatedPromptTokens: number | null,
    model?: string,
  ) => SessionTarget | null;
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
  /** Fired when a session pinned to an OpenAI account could not be served
   *  there. A returned target replaces the pin for this request and onward.
   *  Null means the implementation had nowhere better to put the session — this
   *  request then falls through unpinned, and the implementation decides
   *  whether the old pin survives. See the call site for why this matters. */
  onOpenAISessionUnservable?: (sessionId: string, model?: string) => SessionTarget | null;
  /** Why an existing Anthropic pin cannot serve this request. Absent means the
   *  caller does not price account moves, and routing behaves as it always did.
   *  Consulted BEFORE `resolveSessionTarget`, because both answers it can lead
   *  to — wait, or ask the client to compact — must leave the pin exactly where
   *  it is. Resolving first would already have moved it. */
  inspectSessionPin?: (target: SessionTarget, model?: string) => PinBlock;
  /** Whether any account other than `excludeAccountId` could take this session.
   *  Without one there is nothing to move to, so neither mechanism applies. */
  hasAlternativeAccount?: (excludeAccountId: string, model?: string) => boolean;
  /** Fired when a large session is held on its own account instead of moved. */
  onMigrationWait?: (info: {
    sessionId: string; accountId: string; retryAfterSeconds: number; estimatedRewriteTokens: number;
  }) => void;
  /** Fired when the client is asked to compact before an unavoidable move. */
  onCompactAsk?: (info: {
    sessionId: string; accountId: string; estimatedPromptTokens: number; limitTokens: number;
  }) => void;
  /** Remembers which sessions were already asked to compact. Injected so the
   *  memory outlives a request without this module owning process state. */
  compactAskGuard?: CompactAskGuard;
  /** Kill switches for the two mechanisms above. Absent means the caller did
   *  not configure them; see ProxyConfig.contextMigration for the defaults and
   *  why they differ. */
  holdOnCooldown?: boolean;
  askClientToCompact?: boolean;
  /** Fired when a session is observed to have compacted, with the size it fell
   *  from. The router cannot see client-side compaction any other way. */
  onCompactionObserved?: (info: {
    sessionId: string; accountId: string; fromTokens: number; toTokens: number;
  }) => void;
  /** Tracks per-session prompt size so a compaction can be spotted. */
  contextTracker?: SessionContextTracker;
  /** Last-resort fallback to an Ollama endpoint; see OllamaFallbackRouteOptions. */
  ollamaFallback?: OllamaFallbackRouteOptions;
  /** Fired after Ollama answered (or started answering) a request. */
  onOllamaFallback?: (info: OllamaRouteInfo) => void;
  /** Fired when Ollama was considered for a blocked pool but not used, or
   *  failed before answering. Not fired while Anthropic can serve. */
  onOllamaSkip?: (reason: string) => void;
}

export interface OpenAIUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

/** Raised when an HTTP 200 stream carries a failure before any byte reached the client. */
class UpstreamStreamFailure extends Error {}

type OpenAIForwardOutcome =
  /** `ok` answers "is this response finished with?", not "did the account
   *  serve the session?". Once bytes are out nothing may be retried, but the
   *  account can still have failed — `failedAfterStart` carries that apart so
   *  the caller can move the session without touching the response. */
  | { ok: true; account: OpenAISubscriptionAccount; usage?: OpenAIUsage; failedAfterStart?: true; clientClosed?: true }
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
  sessionId?: string,
): Promise<OpenAIForwardOutcome> {
  // Every way this gives up is logged. The fallback chain treats any failure as
  // "Codex unavailable" and moves on, so without a line here a converter that
  // threw on every real request read exactly like Codex being skipped by
  // design — and it went unnoticed through two investigations (2026-10-26).
  const account = getOpenAIAccount(preferredAccountId);
  if (!account) {
    console.error("[cross-route] no OpenAI account can serve right now");
    return { ok: false, reason: "no_account" };
  }

  let observedUsage: OpenAIUsage | undefined;
  try {
    const ready = await prepareOpenAIAccount(account);
    if (!ready) {
      console.error(`[cross-route] OpenAI account "${account.id}" could not be prepared (token refresh failed)`);
      return { ok: false, reason: "prepare_failed" };
    }

    const body = anthropicToOpenAIResponses(reqBody, modelRouting);
    if (sessionId) body.prompt_cache_key = createHash("sha256").update("cc-router:" + sessionId).digest("hex");
    const upstream = await forwardOpenAI({
      account,
      body,
      stream: body.stream === true,
    });

    if (!upstream.ok && !passThroughUpstreamErrors) {
      const detail = await upstream.text().catch(() => "");
      console.error(`[cross-route] OpenAI account "${account.id}" answered HTTP ${upstream.status}: ${detail.slice(0, 200)}`);
      return { ok: false, reason: "request_failed" };
    }

    const ended = await sendOpenAIAsAnthropic(upstream, res, requestedStream, publicModel, usage => {
      observedUsage = usage;
    });
    return { ok: true, account, usage: observedUsage, ...ended };
  } catch (err) {
    if (err instanceof UpstreamStreamFailure) {
      // Reported inside a 200 stream, before anything was written — treat it
      // like any other failed attempt so the caller can degrade to Anthropic.
      console.error(`[cross-route] OpenAI account "${account.id}" rejected the request: ${err.message}`);
      return { ok: false, reason: "request_failed" };
    }
    if (res.headersSent) {
      console.error(`[cross-route] OpenAI request to "${account.id}" failed after the response had already started: ${(err as Error).message}`);
      return { ok: true, account, usage: observedUsage, failedAfterStart: true };
    }
    console.error(`[cross-route] OpenAI request to "${account.id}" failed before sending: ${(err as Error).message}`);
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

  const elapsed = Date.now() - startedAt;
  return {
    method: req.method,
    path: req.path,
    statusCode: res.statusCode,
    durationMs: elapsed,
    totalMs: elapsed,
    source,
    ...(sessionId ? { sessionId } : {}),
  };
}

/** How a delivered response ended, when it did not end cleanly. */
type ResponseEnd = { failedAfterStart?: true; clientClosed?: true };

/**
 * Cancels `reader` once the client hangs up before the response is complete.
 * Codex keeps generating for as long as its stream is read, so a reader left
 * running spends quota on an answer nobody will receive. Cancelling resolves
 * the pending read as done, which ends the read loop.
 */
function cancelOnClientClose(
  res: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): { clientGone: () => boolean; detach: () => void } {
  let gone = false;
  const onClose = () => {
    if (res.writableEnded || gone) return;
    gone = true;
    reader.cancel().catch(() => {});
  };
  res.on("close", onClose);
  // The client may already have gone while the upstream request was in flight,
  // in which case "close" has fired and will not fire again.
  if (res.destroyed) onClose();
  return { clientGone: () => gone, detach: () => res.off("close", onClose) };
}

async function sendOpenAIAsAnthropic(
  upstream: globalThis.Response,
  res: Response,
  requestedStream: boolean,
  publicModel?: string,
  onUsage?: (usage: OpenAIUsage) => void,
): Promise<ResponseEnd> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (requestedStream) {
      return await sendOpenAIStreamAsAnthropic(upstream, res, publicModel, onUsage);
    }

    const collected = await collectOpenAIStreamAsAnthropicMessage(upstream, res);
    if (!collected) return { clientClosed: true };
    if (publicModel) collected.model = publicModel;
    onUsage?.(collected.usage);
    res.status(upstream.status).json(collected);
    return {};
  }

  if (!contentType.includes("application/json")) {
    res.status(upstream.status);
    res.setHeader("content-type", contentType || "text/plain");
    res.send(await upstream.text());
    return {};
  }

  const json = await upstream.json() as OpenAIResponseCompleted;
  const message = openAIResponseToAnthropicMessage(json);
  if (publicModel) message.model = publicModel;
  onUsage?.(message.usage);
  res.status(upstream.status).json(message);
  return {};
}

/** Null when the client hung up before the stream finished. */
async function collectOpenAIStreamAsAnthropicMessage(
  upstream: globalThis.Response,
  res: Response,
): Promise<ReturnType<typeof openAIResponseToAnthropicMessage> | null> {
  // Throws UpstreamStreamFailure when the 200 stream carried a rejection, so
  // the caller degrades instead of returning an empty message.
  const reader = upstream.body?.getReader();
  if (!reader) {
    return openAIResponseToAnthropicMessage({ id: "", model: "", output: [], usage: {} });
  }
  const { clientGone, detach } = cancelOnClientClose(res, reader);
  try {
    return await collectOpenAIStream(reader, clientGone);
  } finally {
    detach();
  }
}

async function collectOpenAIStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  clientGone: () => boolean,
): Promise<ReturnType<typeof openAIResponseToAnthropicMessage> | null> {

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

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || clientGone()) break;

      const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }));
      remainder = parsed.remainder;
      parsed.events.forEach(applyEvent);
    }
  } catch (err) {
    if (clientGone()) return null;
    throw err;
  }
  // Checked before the failure below: a rejection nobody is waiting for must
  // not send the caller off to retry it on Anthropic.
  if (clientGone()) return null;

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

/**
 * Reports `failedAfterStart` when the stream ended abnormally after bytes had
 * already gone out. The response itself is unsalvageable at that point, but the
 * caller still needs to know the account failed — otherwise a session stays
 * pinned to an upstream that dies mid-generation on every turn.
 *
 * Reports `clientClosed` when the client hung up first. The upstream is
 * cancelled, nothing more is written, and the account is not blamed.
 */
async function sendOpenAIStreamAsAnthropic(
  upstream: globalThis.Response,
  res: Response,
  publicModel?: string,
  onUsage?: (usage: OpenAIUsage) => void,
): Promise<ResponseEnd> {
  res.status(upstream.status);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  // Headers are NOT flushed yet: an upstream failure can still arrive as the
  // first event, and flushing would commit this response to OpenAI.

  const normalizer = createOpenAIStreamToAnthropicNormalizer({ modelOverride: publicModel, onUsage });
  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    return {};
  }
  const { clientGone, detach } = cancelOnClientClose(res, reader);
  try {
    return await relayOpenAIStream(reader, res, normalizer, clientGone);
  } finally {
    detach();
  }
}

async function relayOpenAIStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: Response,
  normalizer: ReturnType<typeof createOpenAIStreamToAnthropicNormalizer>,
  clientGone: () => boolean,
): Promise<ResponseEnd> {
  const decoder = new TextDecoder();
  let remainder = "";
  let wroteAnything = false;
  let failedMidStream = false;
  // A failure the upstream already reported still counts against the account,
  // even if the client left afterwards.
  const clientLeft = (): ResponseEnd => failedMidStream
    ? { failedAfterStart: true, clientClosed: true }
    : { clientClosed: true };

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
      if (done || clientGone()) break;

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
        // The same failure after bytes are out cannot be retried, but it still
        // says this account could not serve the session. Ignoring it here left
        // the session pinned to an upstream that gives up partway every turn.
        if (failure) failedMidStream = true;

        for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
          commit(mapped);
        }
      }
    }

    // Nobody is reading: the cancelled stream's remains are not worth
    // converting, and writing them would go to a closed socket.
    if (clientGone()) {
      res.end();
      return clientLeft();
    }

    const tail = decoder.decode();
    if (tail || remainder) {
      const parsed = parseSseLines(remainder + tail + "\n");
      for (const event of parsed.events) {
        const failure = openAIStreamFailure(event as Parameters<typeof normalizer.convert>[0]);
        if (failure && !wroteAnything) throw new UpstreamStreamFailure(failure);
        if (failure) failedMidStream = true;

        for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
          commit(mapped);
        }
      }
    }

    // A stream that produced nothing but an opening still has to be delivered.
    flushPending();
  } catch (err) {
    // The client hung up; whatever the read raised after that is not the
    // upstream's fault, and there is nobody to fall back for.
    if (clientGone()) {
      res.end();
      return clientLeft();
    }
    // Nothing written means nothing committed: no header has been flushed, so
    // the caller can still degrade to Anthropic. Ending the response here
    // instead would hand the client an empty 200 and report it as served.
    // This covers a transport drop and a reported failure alike, and an invalid
    // tool stream too — the normalizer raises OpenAIProtocolError rather than
    // forward a tool call built from a truncated or malformed stream.
    if (!wroteAnything) throw err;
    console.error(`[cross-route] OpenAI stream ended abnormally: ${(err as Error).message}`);
    // Past the first byte nothing can be retried, but the stream must not just
    // stop: without a terminal event the client cannot tell a refused response
    // from a complete one.
    if (err instanceof OpenAIProtocolError) {
      res.write(encodeSseEvent({
        type: "error",
        error: { type: "api_error", message: "Invalid or incomplete response from OpenAI" },
      }));
    }
    res.end();
    return { failedAfterStart: true };
  }
  res.end();
  return failedMidStream ? { failedAfterStart: true } : {};
}

export function mountMessagesCrossProviderRoute(
  app: Express,
  opts: MessagesCrossProviderRouteOptions,
): void {
  const forwardOpenAI = opts.forwardOpenAI ?? forwardOpenAICodexResponse;
  const prepareOpenAIAccount = opts.prepareOpenAIAccount ?? (async () => true);
  const ollama = opts.ollamaFallback;
  // Separate from provider pins: fallback must still yield to a recovered Claude pool.
  const fallbackAccounts = new Map<string, string>();

  const decideOllama = (claudeModel: string, estimatedPromptTokens: number | null): OllamaDecision => {
    const decision = decideOllamaFallback({
      config: ollama?.config ?? null,
      claudeModel,
      anthropicAvailable: () => opts.hasAvailableAnthropicAccount?.(claudeModel) ?? true,
      poolWaitSeconds: () => ollama?.poolWaitSeconds(claudeModel) ?? 0,
      estimatedPromptTokens,
      apiKey: () => ollama?.apiKey(),
      matchedTiers: ollama?.matchedTiers,
    });
    // Only a decision taken against a blocked pool is worth surfacing; the
    // everyday "Anthropic can serve" answer would bury it.
    if (!decision.use && decision.reason !== "disabled" && decision.reason !== "anthropic-available") {
      opts.onOllamaSkip?.(decision.detail ? `${decision.reason} (${decision.detail})` : decision.reason);
    }
    return decision;
  };

  // count_tokens is answered locally while requests are going to Ollama:
  // Ollama does not implement it (404; a known bug can hang the daemon on it),
  // and proxying it to the blocked pool only earns the client a 429. Mounted
  // only when the fallback is enabled, so the default path is untouched.
  if (ollama) {
    app.post(
      "/v1/messages/count_tokens",
      express.json({
        limit: "10mb",
        verify: (req, _res, buf) => {
          (req as Request)._ccRawBody = Buffer.from(buf);
        },
      }),
      (req: Request, res: Response, next: NextFunction) => {
        if (!isAnthropicMessagesRequest(req.body)) return next();
        const route = selectRoute(req.body.model, opts.modelRouting);
        if (route.provider !== "anthropic_subscription") return next();
        const estimated = estimatePromptTokens(req._ccRawBody);
        const decision = decideOllama(route.upstreamModel, estimated);
        if (!decision.use) return next();
        res.json({ input_tokens: estimated ?? 0 });
      },
    );
  }

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
      if (route.provider === "anthropic_subscription") req._ccAnthropicModel = route.upstreamModel;
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
          undefined, sessionId,
        );
        if (outcome.ok) {
          opts.onExplicitRoute?.({
            openAIAccountId: outcome.account.id,
            upstreamModel: route.upstreamModel,
            usage: outcome.usage,
            failedAfterStart: outcome.failedAfterStart,
            clientClosed: outcome.clientClosed,
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
      const tieredModel = openAIModelForClaudeModel(req.body.model, opts.modelRouting, opts.matchedOpenAITiers?.())
        ?? openAIDefaultModel;
      const crossProviderEffort = opts.modelRouting?.openAIReasoningEffort?.trim();
      const crossProviderBody: AnthropicMessagesRequest = {
        ...req.body,
        model: `openai/${tieredModel}`,
        ...(crossProviderEffort ? {
          output_config: { ...req.body.output_config, effort: crossProviderEffort },
        } : {}),
      };

      // Size the conversation once, here: both the account-move policy below
      // and the placement decision further down need the same number, and
      // measuring twice invites them to disagree.
      const estimatedPromptTokens = estimatePromptTokens(req._ccRawBody);

      // Watch the size on every session request, not just the ones where a move
      // is in question: a compaction matters most when nothing is moving,
      // because that is when it reports what the CLIENT decided to do, and at
      // what size. The router has no other way to see it.
      if (sessionId) {
        const compacted = opts.contextTracker?.observe(sessionId, estimatedPromptTokens);
        if (compacted) {
          opts.onCompactionObserved?.({
            sessionId,
            accountId: opts.peekSessionTarget?.(sessionId)?.accountId ?? "-",
            ...compacted,
          });
        }
      }

      // Price the account move before routing gets a chance to make it.
      //
      // A session whose pinned account has gone unusable is about to be moved,
      // and for a large conversation that move is not free: the prompt cache is
      // account-local, so the next request re-writes the whole prefix into the
      // new account. Both answers below therefore run BEFORE
      // `resolveSessionTarget` — they must leave the pin untouched, and
      // resolving first would already have released it.
      const pinnedBefore = sessionId && opts.peekSessionTarget
        ? opts.peekSessionTarget(sessionId)
        : null;
      if (
        pinnedBefore?.provider === "anthropic" &&
        opts.inspectSessionPin &&
        req.body.messages
      ) {
        const guard = opts.compactAskGuard;
        const decision = decideMigration({
          estimatedPromptTokens,
          turnCount: req.body.messages.length,
          block: opts.inspectSessionPin(pinnedBefore, route.upstreamModel),
          alternativeAvailable:
            opts.hasAlternativeAccount?.(pinnedBefore.accountId, route.upstreamModel) ?? false,
          alreadyAskedCompact: guard?.askedRecently(sessionId) ?? false,
        });

        if (decision.action === "wait" && opts.holdOnCooldown !== false) {
          opts.onMigrationWait?.({
            sessionId, accountId: pinnedBefore.accountId,
            retryAfterSeconds: decision.retryAfterSeconds,
            estimatedRewriteTokens: decision.estimatedRewriteTokens,
          });
          res.setHeader("Retry-After", String(decision.retryAfterSeconds));
          res.setHeader("x-cc-router-reason", "hold-session-on-account");
          res.status(429).json({
            type: "error",
            error: {
              type: "rate_limit_error",
              message: `${pinnedBefore.accountId} is cooling down — holding this session on it rather than re-writing its context into another account`,
            },
          });
          return;
        }

        if (decision.action === "compact" && opts.askClientToCompact === true) {
          guard?.markAsked(sessionId);
          opts.onCompactAsk?.({
            sessionId, accountId: pinnedBefore.accountId,
            estimatedPromptTokens: decision.estimatedPromptTokens,
            limitTokens: decision.limitTokens,
          });
          // Upstream's own wording, because that is what makes the client
          // compact its history and retry instead of surfacing an error. The
          // numbers are this router's policy, not Anthropic's window, and the
          // header says so for anyone reading the exchange.
          res.setHeader("x-cc-router-reason", "compact-before-account-move");
          res.status(400).json({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: `prompt is too long: ${decision.estimatedPromptTokens} tokens > ${decision.limitTokens} maximum`,
            },
          });
          return;
        }
      }

      // Session affinity. Resolved once here and stashed on the request so the
      // Anthropic proxy downstream reuses the same decision rather than
      // resolving again (which would advance the assignment cursor twice).
      const sessionTarget = sessionId && opts.resolveSessionTarget
        ? opts.resolveSessionTarget(sessionId, estimatedPromptTokens, route.upstreamModel)
        : null;
      if (sessionTarget) req._ccSessionTarget = sessionTarget;

      // This session belongs to an OpenAI account, so its Claude-model requests
      // go there too — that is what keeps a conversation on one provider
      // instead of alternating models mid-thread. A failure here is silent and
      // falls through to Anthropic, same as the fallback path below.
      if (sessionTarget?.provider === "openai" && openAIDefaultModel && tieredModel) {
        const outcome = await forwardAnthropicRequestAsOpenAI(
          crossProviderBody, res, requestedStream,
          opts.getOpenAIAccount, prepareOpenAIAccount, forwardOpenAI, opts.modelRouting,
          /* passThroughUpstreamErrors */ false,
          sessionTarget.accountId,
          /* publicModel */ req.body.model,
          sessionId,
        );
        if (outcome.ok) {
          opts.onSessionRoute?.({
            sessionId,
            openAIAccountId: outcome.account.id,
            upstreamModel: tieredModel,
            usage: outcome.usage,
            failedAfterStart: outcome.failedAfterStart,
            clientClosed: outcome.clientClosed,
            ...openAIActivity(req, res, startedAt, sessionId),
          });
          // The response is spent either way, but a failure means this account
          // could not serve the session. Without moving it here the session
          // stays pinned to an account that keeps failing mid-generation, and
          // the client receives a truncated answer every turn while the logs
          // read as success.
          if (outcome.failedAfterStart) opts.onOpenAISessionUnservable?.(sessionId);
          return;
        }

        // The pinned OpenAI account could not serve this session, and the
        // request is about to fall through to Anthropic. Leaving the pin on
        // OpenAI makes that fall-through permanent *and* unpinned: the
        // downstream Anthropic handler only honours an anthropic-provider pin,
        // so every later request draws from plain rotation and re-writes the
        // conversation into whichever account comes next. Measured at 600-750K
        // tokens per bounce on a session whose context had outgrown the Codex
        // context window, with no 429 anywhere — the rejection arrives inside a
        // 200 stream, so nothing else marks the account as unusable.
        //
        // Re-pin now so the session settles on one Anthropic account instead.
        const replacement = opts.onOpenAISessionUnservable?.(sessionId, route.upstreamModel) ?? null;
        if (replacement) req._ccSessionTarget = replacement;
      }

      const anthropicExhausted =
        opts.crossProviderFallback === true &&
        opts.hasAvailableAnthropicAccount?.(route.upstreamModel) === false;

      // The fallback picks an OpenAI account directly rather than through the
      // session router, so the size guard above does not cover it. Without this
      // check, exhausting the Anthropic pool would hand Codex exactly the
      // oversized conversations it cannot answer — and because the request is
      // mid-session, the client has nowhere to retry: falling through to the
      // degraded Anthropic path at least returns the upstream's own 429.
      if (anthropicExhausted && openAIDefaultModel && tieredModel
          && codexCanHold(estimatedPromptTokens)) {
        const outcome = await forwardAnthropicRequestAsOpenAI(
          crossProviderBody, res, requestedStream,
          opts.getOpenAIAccount, prepareOpenAIAccount, forwardOpenAI, opts.modelRouting,
          /* passThroughUpstreamErrors */ false,
          /* preferredAccountId */ sessionId ? fallbackAccounts.get(sessionId) : undefined,
          /* publicModel */ req.body.model,
          sessionId,
        );
        if (outcome.ok) {
          if (sessionId) {
            fallbackAccounts.delete(sessionId);
            fallbackAccounts.set(sessionId, outcome.account.id);
            if (fallbackAccounts.size > 10_000) fallbackAccounts.delete(fallbackAccounts.keys().next().value!);
          }
          opts.onFallback?.({
            openAIAccountId: outcome.account.id,
            upstreamModel: tieredModel,
            usage: outcome.usage,
            failedAfterStart: outcome.failedAfterStart,
            clientClosed: outcome.clientClosed,
            ...openAIActivity(req, res, startedAt, sessionId),
          });
          return;
        }
        // OpenAI unavailable too — fall through to the normal (degraded) Anthropic path.
      }

      // Last resort: an Ollama model, but only for a pool that is blocked for
      // longer than the operator is willing to wait. Re-decided on every request
      // and never pinned, so the session returns to Anthropic the moment an
      // account frees up. A session pinned to an Anthropic account reaches this
      // point too: the migration hold above only applies while an alternative
      // account exists, and with none the pin cannot be retained downstream.
      if (ollama && !res.headersSent) {
        const decision = decideOllama(route.upstreamModel, estimatedPromptTokens);
        if (decision.use) {
          const outcome = await forwardToOllama({
            baseUrl: ollama.config.baseUrl,
            apiKey: ollama.apiKey(),
            upstreamModel: decision.model,
            publicModel: req.body.model ?? route.publicModel,
            body: req.body as unknown as Record<string, unknown>,
            timeoutMs: ollama.timeoutMs,
            fetchImpl: ollama.fetchImpl,
          }, res);
          if (outcome.ok) {
            opts.onOllamaFallback?.({
              upstreamModel: decision.model,
              poolWaitSeconds: decision.waitSeconds,
              usage: outcome.usage,
              failedAfterStart: outcome.failedAfterStart,
              clientClosed: outcome.clientClosed,
              ...openAIActivity(req, res, startedAt, sessionId),
            });
            return;
          }
          // The client hung up before Ollama answered. Nothing failed, and the
          // pool's 429 would only be logged for a request nobody is waiting on.
          if (outcome.reason === "client_closed" || res.destroyed) return;
          // Nothing was written: the client gets the pool's own 429, whose
          // Retry-After says when Claude is back. Ollama's error says nothing
          // useful about that.
          opts.onOllamaSkip?.(`ollama-failed (${outcome.reason}${outcome.status ? ` ${outcome.status}` : ""}: ${outcome.detail.slice(0, 120)})`);
        }
      }

      next();
    },
  );
}
