/**
 * Guards for an upstream that goes quiet.
 *
 * Before the first byte: a streaming request whose upstream sends no response
 * headers within `firstByteMs` is abandoned, so failover can try the next seat.
 * Nothing has reached the client, so the retry is invisible to it.
 *
 * After the first byte nothing can be retried (output would be duplicated), but
 * the client must not hang or keep a silently cut answer. An SSE stream that
 * goes idle past `idleMs`, breaks, or ends without `message_stop` is closed
 * with an Anthropic-format `overloaded_error` event, which Claude Code retries.
 * A JSON body that breaks has its connection cut, which the SDK also retries.
 */
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";

export const DEFAULT_FIRST_BYTE_MS = 120_000;
export const DEFAULT_STREAM_IDLE_MS = 180_000;

export interface StreamGuardConfig {
  /** Streaming requests only: 0 turns the guard off. */
  firstByteMs: number;
  /** 0 turns the guard off. */
  idleMs: number;
}

function msFrom(envValue: string | undefined, seconds: unknown, fallback: number): number {
  if (envValue !== undefined && envValue !== "") {
    const n = Number(envValue);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (seconds === undefined) return fallback;
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return fallback;
  return Math.round(s * 1000);
}

/**
 * `streamGuard.firstByteSeconds` (default 120) and `streamGuard.idleSeconds`
 * (default 180) from config; CC_ROUTER_FIRST_BYTE_MS and
 * CC_ROUTER_STREAM_IDLE_MS override them. 0 disables a guard. The idle default
 * sits well above Anthropic's ping interval, so a long thinking pause is not
 * taken for a stall.
 */
export function resolveStreamGuard(
  cfg: { firstByteSeconds?: unknown; idleSeconds?: unknown } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): StreamGuardConfig {
  return {
    firstByteMs: msFrom(env["CC_ROUTER_FIRST_BYTE_MS"], cfg?.firstByteSeconds, DEFAULT_FIRST_BYTE_MS),
    idleMs: msFrom(env["CC_ROUTER_STREAM_IDLE_MS"], cfg?.idleSeconds, DEFAULT_STREAM_IDLE_MS),
  };
}

/** Raised on the upstream request when its headers did not come in time. */
export class FirstByteTimeoutError extends Error {
  readonly code = "CC_FIRST_BYTE_TIMEOUT";
  constructor(readonly ms: number) {
    super(`no response headers within ${Math.round(ms / 1000)}s`);
  }
}

export function isFirstByteTimeout(err: unknown): err is FirstByteTimeoutError {
  return (err as { code?: unknown } | null)?.code === "CC_FIRST_BYTE_TIMEOUT";
}

/**
 * Destroys `proxyReq` with a FirstByteTimeoutError unless its response arrives
 * within `ms`. The proxy's error handler then fails the request over.
 */
export function armFirstByteTimer(proxyReq: ClientRequest, ms: number): void {
  if (ms <= 0) return;
  const timer = setTimeout(() => proxyReq.destroy(new FirstByteTimeoutError(ms)), ms);
  const clear = () => clearTimeout(timer);
  proxyReq.once("response", clear);
  proxyReq.once("close", clear);
}

export const OVERLOADED_EVENT =
  `\n\nevent: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Upstream stream stalled or broke; retry the request" } })}\n\n`;

/** How a relayed response ended. */
export type RelayOutcome = "complete" | "stalled" | "broken" | "truncated" | "clientGone";

function isEventStream(proxyRes: IncomingMessage): boolean {
  const type = String(proxyRes.headers["content-type"] ?? "");
  const encoding = String(proxyRes.headers["content-encoding"] ?? "identity").toLowerCase();
  return type.includes("text/event-stream") && (encoding === "identity" || encoding === "");
}

/**
 * Relays an upstream response to the client like a pipe, with the stall and
 * break handling described above. `onEnd` is called once with the outcome.
 */
export function guardedRelay(
  proxyRes: IncomingMessage,
  res: ServerResponse,
  opts: { idleMs: number; onEnd?: (outcome: RelayOutcome) => void },
): void {
  const sse = isEventStream(proxyRes);
  let finished = false;
  let idle: NodeJS.Timeout | undefined;
  const scan = sse ? new EventStreamScan() : null;

  const clearIdle = () => { if (idle) { clearTimeout(idle); idle = undefined; } };
  const armIdle = () => {
    clearIdle();
    if (opts.idleMs > 0) idle = setTimeout(() => fail("stalled"), opts.idleMs);
  };
  const finish = (outcome: RelayOutcome) => {
    if (finished) return;
    finished = true;
    clearIdle();
    opts.onEnd?.(outcome);
  };
  const fail = (outcome: "stalled" | "broken" | "truncated") => {
    if (finished) return;
    // Settle the outcome first: destroying the upstream response below emits
    // its own aborted/close events synchronously, which must not re-label a
    // stall as a break.
    finish(outcome);
    if (!res.writableEnded && !res.destroyed) {
      res.on("error", () => {});
      if (sse) res.end(OVERLOADED_EVENT);
      else res.destroy();
    }
    if (!proxyRes.destroyed) proxyRes.destroy();
  };

  proxyRes.on("data", (chunk: Buffer) => {
    if (finished) return;
    scan?.feed(chunk);
    if (!res.write(chunk)) {
      // The client is slow, not the upstream: stop the idle clock while waiting.
      proxyRes.pause();
      clearIdle();
      res.once("drain", () => { if (!finished) { proxyRes.resume(); armIdle(); } });
    } else {
      armIdle();
    }
  });
  proxyRes.once("end", () => {
    if (finished) return;
    // A stream that ends without message_stop (or an error event of its own)
    // was cut short: say so in a form the client retries.
    if (scan && !scan.endedProperly) { fail("truncated"); return; }
    res.end();
    finish("complete");
  });
  proxyRes.once("aborted", () => fail("broken"));
  proxyRes.once("error", () => fail("broken"));
  proxyRes.once("close", () => { if (!proxyRes.complete) fail("broken"); });
  res.once("close", () => {
    if (finished) return;
    if (!proxyRes.destroyed) proxyRes.destroy();
    finish(res.writableFinished ? "complete" : "clientGone");
  });

  relayHead(proxyRes, res);
  armIdle();
}

/** Status and headers as received; sent now, as a pipe would with the first chunk. */
function relayHead(proxyRes: IncomingMessage, res: ServerResponse): void {
  res.statusCode = proxyRes.statusCode ?? 502;
  if (proxyRes.statusMessage) res.statusMessage = proxyRes.statusMessage;
  for (const [name, value] of Object.entries(proxyRes.headers)) {
    if (value !== undefined) res.setHeader(name, value);
  }
  res.flushHeaders();
}

/**
 * Watches SSE text for `message_stop` and `error` events. The tail of each
 * chunk is kept, so an event name split across two chunks is still found.
 */
class EventStreamScan {
  sawStop = false;
  sawError = false;
  private tail = "";
  feed(chunk: Buffer): void {
    const text = this.tail + chunk.toString("utf8");
    if (text.includes('"message_stop"') || text.includes("event: message_stop")) this.sawStop = true;
    if (text.includes("event: error")) this.sawError = true;
    this.tail = text.slice(-64);
  }
  /** Ended on its own terms: a message_stop, or an error event the upstream sent itself. */
  get endedProperly(): boolean {
    return this.sawStop || this.sawError;
  }
}

/** Counters for health: how often each guard acted, since start. */
export class StreamGuardCounters {
  firstByteTimeouts = 0;
  stalled = 0;
  broken = 0;
  truncated = 0;
  record(outcome: RelayOutcome): void {
    if (outcome === "stalled") this.stalled++;
    else if (outcome === "broken") this.broken++;
    else if (outcome === "truncated") this.truncated++;
  }
  snapshot(cfg: StreamGuardConfig) {
    return {
      firstByteMs: cfg.firstByteMs, idleMs: cfg.idleMs,
      firstByteTimeouts: this.firstByteTimeouts, stalled: this.stalled, broken: this.broken, truncated: this.truncated,
    };
  }
}
