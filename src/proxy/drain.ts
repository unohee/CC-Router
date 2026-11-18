/**
 * Draining: stop taking new connections, let the requests already in flight
 * finish, and only then let the process go.
 *
 * A restart that exits at once cuts every stream in flight, and a Claude Code
 * turn streams for minutes. Draining waits for them up to a limit (10 minutes
 * by default). A stream still open at the limit is ended with an
 * Anthropic-format `overloaded_error`, which Claude Code retries, instead of a
 * dropped connection mid-answer.
 */
import { Server as NetServer, type Socket } from "node:net";
import type { Server, ServerResponse } from "node:http";
import type { InFlightCounter } from "./in-flight.js";

export const DEFAULT_DRAIN_LIMIT_MS = 10 * 60_000;
/** Bounds for a configured limit: long enough to matter, short enough for systemd's stop timeout. */
export const MIN_DRAIN_LIMIT_MS = 1_000;
export const MAX_DRAIN_LIMIT_MS = 30 * 60_000;

/**
 * The drain limit. CC_ROUTER_DRAIN_LIMIT_MS (tests, one-off runs) wins over
 * config `drain.limitSeconds`; anything unusable falls back to the default.
 */
export function resolveDrainLimitMs(limitSeconds: unknown, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = Number(env["CC_ROUTER_DRAIN_LIMIT_MS"]);
  if (env["CC_ROUTER_DRAIN_LIMIT_MS"] !== undefined && Number.isFinite(fromEnv) && fromEnv >= 0) {
    return Math.min(fromEnv, MAX_DRAIN_LIMIT_MS);
  }
  const seconds = Number(limitSeconds);
  if (limitSeconds === undefined || !Number.isFinite(seconds)) return DEFAULT_DRAIN_LIMIT_MS;
  return Math.min(MAX_DRAIN_LIMIT_MS, Math.max(MIN_DRAIN_LIMIT_MS, Math.round(seconds * 1000)));
}

const OVERLOADED = {
  type: "error",
  error: { type: "overloaded_error", message: "CC-Router is restarting; retry the request" },
};

/**
 * Ends a response that the drain limit caught unfinished, in the form the
 * client retries: a 529 before any byte, an `error` event inside an SSE stream.
 * A non-stream body already under way cannot be completed honestly, so its
 * connection is cut, which the Anthropic SDK also treats as retryable.
 */
export function endUnfinishedResponse(res: ServerResponse): "529" | "sse-error" | "cut" | "already-ended" {
  if (res.writableEnded || res.destroyed) return "already-ended";
  // Writes racing the upstream pipe must not surface as an unhandled error.
  res.on("error", () => {});
  if (!res.headersSent) {
    const body = JSON.stringify(OVERLOADED);
    res.writeHead(529, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
    res.end(body);
    return "529";
  }
  const type = String(res.getHeader("content-type") ?? "");
  if (type.includes("text/event-stream")) {
    // The leading blank line closes any event the upstream left half-written.
    res.end(`\n\nevent: error\ndata: ${JSON.stringify(OVERLOADED)}\n\n`);
    return "sse-error";
  }
  res.destroy();
  return "cut";
}

/**
 * Open client connections, counted from the server's `connection` events.
 * Install at startup; a drain waits for this to reach zero.
 */
export function trackConnections(server: Pick<Server, "on">): () => number {
  const open = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  });
  return () => open.size;
}

/**
 * Makes this response close its connection when it is done, even if the proxy
 * copies `connection: keep-alive` from upstream. While draining, a client that
 * reuses a kept-alive socket is served on it once and then reconnects, to the
 * worker that now holds the port, instead of finding the socket reset under it.
 */
export function forceConnectionClose(res: ServerResponse): void {
  const set = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | readonly string[]) =>
    set(name, name.toLowerCase() === "connection" ? "close" : value)) as typeof res.setHeader;
  if (!res.headersSent) set("connection", "close");
}

/**
 * Stops accepting new connections without touching the open ones. Node's
 * http.Server#close also closes idle keep-alive sockets at once, and a client
 * that picks one of those for its next request just as it closes gets
 * ECONNRESET. net.Server#close only stops the listener; idle sockets close at
 * keepAliveTimeout, the race the client's keep-alive handling already covers.
 */
export function stopAccepting(server: Pick<Server, "close">): void {
  if (server instanceof NetServer) NetServer.prototype.close.call(server);
  else server.close();
}

export interface DrainResult {
  /** Requests still open when the limit ran out, ended by endUnfinishedResponse. */
  dropped: number;
  /** Requests that finished during the drain. */
  finished: number;
  durationMs: number;
}

/**
 * Stops accepting, then waits until no request is in flight and every client
 * connection has closed (requests that arrive on a kept-alive connection
 * meanwhile are served with `connection: close`), up to `limitMs`. Whatever is
 * left is ended in a form the client retries.
 */
export async function drainServer(opts: {
  server: Pick<Server, "close" | "closeAllConnections">;
  inFlight: InFlightCounter;
  /** Open connections (trackConnections); without it only requests are waited for. */
  connections?: () => number;
  limitMs: number;
  pollMs?: number;
}): Promise<DrainResult> {
  const startedAt = Date.now();
  const servedBefore = opts.inFlight.served;
  stopAccepting(opts.server);
  const poll = opts.pollMs ?? 100;
  const deadline = startedAt + opts.limitMs;
  const connections = opts.connections ?? (() => 0);
  while ((opts.inFlight.current > 0 || connections() > 0) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, poll));
  }
  let dropped = 0;
  for (const res of opts.inFlight.openResponses()) {
    if (endUnfinishedResponse(res) !== "already-ended") dropped++;
  }
  opts.server.closeAllConnections?.();
  return { dropped, finished: opts.inFlight.served - servedBefore, durationMs: Date.now() - startedAt };
}
