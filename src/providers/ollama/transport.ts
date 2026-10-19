import type { Response as ExpressResponse } from "express";

/**
 * Sends an Anthropic Messages request to an Ollama endpoint and relays the
 * answer to the client.
 *
 * Ollama accepts the Anthropic body as-is (cache_control, tool_choice,
 * signed thinking history and anthropic-beta are all ignored, measured against
 * 0.23.3), so only `model` is replaced on the way out. The way back needs one
 * real change: Ollama returns `thinking` blocks with no `signature`, and the
 * stream has no signature_delta. Claude Code would keep those blocks in its
 * history, and Anthropic rejects unsigned thinking once the session returns to
 * it. They are therefore stripped, and the remaining block indices renumbered
 * so they stay contiguous from 0.
 */

export interface OllamaUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type OllamaForwardOutcome =
  /** Response delivered. `failedAfterStart` means bytes went out and then the
   *  upstream failed or the stream ended without message_stop. `clientClosed`
   *  means the client hung up mid-response: the stream is cut, but that is the
   *  client's doing, not an upstream failure. */
  | { ok: true; status: number; usage?: OllamaUsage; failedAfterStart?: true; clientClosed?: true }
  /** Nothing was written; the caller may still answer the client itself.
   *  `client_closed` means there is nobody left to answer. */
  | { ok: false; reason: "network" | "upstream_status" | "invalid_response" | "client_closed"; status?: number; detail: string };

export interface OllamaForwardOptions {
  baseUrl: string;
  apiKey?: string;
  /** Upstream model to request. */
  upstreamModel: string;
  /** Model name reported to the client: the Claude name it asked for. */
  publicModel: string;
  body: Record<string, unknown>;
  /** Inactivity timeout: the longest wait for the response headers or for the
   *  next body chunk. Not a total deadline, matching the Anthropic path, whose
   *  http-proxy timeouts are socket-idle timeouts; a long generation that keeps
   *  streaming is never cut. */
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const STRIPPED_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Fold an Anthropic `usage` object into the running reading. */
function mergeUsage(into: Partial<OllamaUsage>, usage: unknown): void {
  if (!isRecord(usage)) return;
  const input = num(usage["input_tokens"]);
  const output = num(usage["output_tokens"]);
  const cacheRead = num(usage["cache_read_input_tokens"]);
  const cacheCreation = num(usage["cache_creation_input_tokens"]);
  if (input !== undefined) into.input_tokens = input;
  if (output !== undefined) into.output_tokens = output;
  if (cacheRead !== undefined) into.cache_read_input_tokens = cacheRead;
  if (cacheCreation !== undefined) into.cache_creation_input_tokens = cacheCreation;
}

function completeUsage(usage: Partial<OllamaUsage>): OllamaUsage | undefined {
  if (usage.input_tokens === undefined && usage.output_tokens === undefined) return undefined;
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    ...(usage.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
  };
}

export interface OllamaStreamTransformer {
  /** Feed decoded text; returns the SSE text to send on, possibly empty. */
  push(text: string): string;
  /** Flush whatever is buffered once the upstream has ended. */
  end(): string;
  usage(): OllamaUsage | undefined;
  /** message_stop has been seen. */
  completed(): boolean;
  /** An `error` event came through. */
  sawError(): boolean;
}

/**
 * Rewrites an Anthropic-shaped SSE stream from Ollama.
 *
 * Events are delimited by a blank line and may be split anywhere across
 * chunks, so text is buffered until a delimiter arrives. Each event is
 * re-emitted as `event: <type>` + `data: <json>`; a block whose data is not
 * JSON is passed through verbatim.
 */
export function createOllamaStreamTransformer(opts: { publicModel?: string } = {}): OllamaStreamTransformer {
  let buffer = "";
  const dropped = new Set<number>();
  const indexMap = new Map<number, number>();
  let nextIndex = 0;
  const usage: Partial<OllamaUsage> = {};
  let completed = false;
  let sawError = false;

  const mapIndex = (upstream: number): number => {
    let mapped = indexMap.get(upstream);
    if (mapped === undefined) {
      mapped = nextIndex++;
      indexMap.set(upstream, mapped);
    }
    return mapped;
  };

  /** Returns the text to emit for one event block, or "" to drop it. */
  const processBlock = (block: string): string => {
    const lines = block.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
    const dataLines: string[] = [];
    let eventName: string | undefined;
    for (const line of lines) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:")) eventName = line.slice(6).trim();
    }
    if (dataLines.length === 0) return block.trim() ? `${block}\n\n` : "";

    let event: unknown;
    try {
      event = JSON.parse(dataLines.join("\n"));
    } catch {
      return `${block}\n\n`;
    }
    if (!isRecord(event)) return `${block}\n\n`;

    const type = typeof event["type"] === "string" ? event["type"] as string : eventName;
    const index = num(event["index"]);

    switch (type) {
      case "message_start": {
        const message = event["message"];
        if (isRecord(message)) {
          if (opts.publicModel) message["model"] = opts.publicModel;
          mergeUsage(usage, message["usage"]);
          // A message_start may already list content; keep it consistent.
          if (Array.isArray(message["content"])) {
            message["content"] = message["content"].filter(b => !(isRecord(b) && STRIPPED_BLOCK_TYPES.has(String(b["type"]))));
          }
        }
        break;
      }
      case "content_block_start": {
        if (index === undefined) break;
        const contentBlock = event["content_block"];
        if (isRecord(contentBlock) && STRIPPED_BLOCK_TYPES.has(String(contentBlock["type"]))) {
          dropped.add(index);
          return "";
        }
        event["index"] = mapIndex(index);
        break;
      }
      case "content_block_delta":
      case "content_block_stop": {
        if (index === undefined) break;
        if (dropped.has(index)) return "";
        event["index"] = mapIndex(index);
        break;
      }
      case "message_delta":
        mergeUsage(usage, event["usage"]);
        break;
      case "message_stop":
        completed = true;
        break;
      case "error":
        sawError = true;
        break;
    }

    const name = type ?? eventName;
    return `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(event)}\n\n`;
  };

  const drain = (final: boolean): string => {
    let out = "";
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      out += processBlock(block);
    }
    if (final && buffer.trim()) {
      out += processBlock(buffer);
      buffer = "";
    }
    return out;
  };

  return {
    push: (text) => {
      buffer += text;
      return drain(false);
    },
    end: () => drain(true),
    usage: () => completeUsage(usage),
    completed: () => completed,
    sawError: () => sawError,
  };
}

/** Non-streaming counterpart: strip thinking, report the client's model. */
export function transformOllamaMessage(message: unknown, publicModel?: string): {
  message: unknown; usage?: OllamaUsage;
} {
  if (!isRecord(message)) return { message };
  if (Array.isArray(message["content"])) {
    message["content"] = message["content"].filter(b => !(isRecord(b) && STRIPPED_BLOCK_TYPES.has(String(b["type"]))));
  }
  if (publicModel && message["type"] === "message") message["model"] = publicModel;
  const usage: Partial<OllamaUsage> = {};
  mergeUsage(usage, message["usage"]);
  return { message, usage: completeUsage(usage) };
}

/**
 * Forward one request. Never throws. A failure before the first byte is
 * returned unwritten so the caller can answer with its own 429; Ollama's own
 * error body is deliberately not relayed, since the router's Retry-After is
 * the one that says when Claude will be back.
 */
export async function forwardToOllama(
  opts: OllamaForwardOptions,
  res: ExpressResponse,
): Promise<OllamaForwardOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clientAbort = new AbortController();
  // Stop paying for a generation nobody is reading.
  const onClose = () => { if (!res.writableEnded) clientAbort.abort(); };
  res.on("close", onClose);
  const idle = createIdleTimer(opts.timeoutMs);
  const signal = AbortSignal.any([clientAbort.signal, idle.signal]);
  const clientGone = () => clientAbort.signal.aborted;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: opts.body["stream"] === true ? "text/event-stream" : "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (opts.apiKey) headers["authorization"] = `Bearer ${opts.apiKey}`;

  try {
    let upstream: globalThis.Response;
    try {
      idle.arm();
      upstream = await fetchImpl(`${opts.baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...opts.body, model: opts.upstreamModel }),
        signal,
      });
      idle.arm();
    } catch (err) {
      if (clientGone()) return { ok: false, reason: "client_closed", detail: "client disconnected" };
      return { ok: false, reason: "network", detail: errorMessage(err, idle) };
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      if (clientGone()) return { ok: false, reason: "client_closed", detail: "client disconnected" };
      return { ok: false, reason: "upstream_status", status: upstream.status, detail: text.slice(0, 200) };
    }

    const reader = upstream.body?.getReader();
    if (!reader) return { ok: false, reason: "invalid_response", status: upstream.status, detail: "empty body" };
    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return await relayStream(upstream.status, reader, res, opts.publicModel, idle, clientGone);
    }

    // Read the JSON body chunk by chunk too, so the idle timer — not a total
    // deadline — bounds a slow non-streaming answer.
    let json: unknown;
    try {
      json = JSON.parse(await readAll(reader, idle));
    } catch (err) {
      if (clientGone()) return { ok: false, reason: "client_closed", detail: "client disconnected" };
      return { ok: false, reason: "invalid_response", status: upstream.status, detail: errorMessage(err, idle) };
    }
    const { message, usage } = transformOllamaMessage(json, opts.publicModel);
    res.status(upstream.status).json(message);
    return usage ? { ok: true, status: upstream.status, usage } : { ok: true, status: upstream.status };
  } finally {
    idle.clear();
    res.off("close", onClose);
  }
}

interface IdleTimer {
  signal: AbortSignal;
  /** (Re)start the countdown; called before every wait on the upstream. */
  arm(): void;
  clear(): void;
  fired(): boolean;
}

/** An abort signal that fires after `ms` without a call to arm(). */
function createIdleTimer(ms: number): IdleTimer {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
  return {
    signal: controller.signal,
    arm: () => {
      clear();
      timer = setTimeout(() => controller.abort(new Error(`no data from Ollama for ${ms}ms`)), ms);
      timer.unref?.();
    },
    clear,
    fired: () => controller.signal.aborted,
  };
}

function errorMessage(err: unknown, idle: IdleTimer): string {
  if (idle.fired()) return String((idle.signal.reason as Error | undefined)?.message ?? "idle timeout");
  return (err as Error)?.message ?? String(err);
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>, idle: IdleTimer): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    idle.arm();
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function relayStream(
  status: number,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: ExpressResponse,
  publicModel: string,
  idle: IdleTimer,
  clientGone: () => boolean,
): Promise<OllamaForwardOutcome> {
  const transformer = createOllamaStreamTransformer({ publicModel });
  const decoder = new TextDecoder();
  let wroteAnything = false;
  // Headers are held until there is something to send, so a stream that dies
  // before its first event can still fall back to the router's 429.
  const write = (text: string) => {
    if (!text) return;
    if (!wroteAnything) {
      res.status(status);
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.flushHeaders?.();
      wroteAnything = true;
    }
    res.write(text);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      idle.arm();
      write(transformer.push(decoder.decode(value, { stream: true })));
    }
    write(transformer.push(decoder.decode()));
    write(transformer.end());
  } catch (err) {
    if (clientGone()) {
      // The client hung up; nothing failed upstream and nobody is listening.
      if (!wroteAnything) return { ok: false, reason: "client_closed", status, detail: "client disconnected" };
      res.end();
      const usage = transformer.usage();
      return { ok: true, status, clientClosed: true, ...(usage ? { usage } : {}) };
    }
    if (!wroteAnything) {
      return { ok: false, reason: "network", status, detail: errorMessage(err, idle) };
    }
    console.error(`[ollama] stream ended abnormally: ${errorMessage(err, idle)}`);
    res.end();
    const usage = transformer.usage();
    return { ok: true, status, failedAfterStart: true, ...(usage ? { usage } : {}) };
  }

  if (!wroteAnything) {
    return { ok: false, reason: "invalid_response", status, detail: "stream carried no events" };
  }
  res.end();
  const usage = transformer.usage();
  const failed = transformer.sawError() || !transformer.completed();
  return {
    ok: true, status,
    ...(usage ? { usage } : {}),
    ...(failed ? { failedAfterStart: true as const } : {}),
  };
}
