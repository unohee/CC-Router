/**
 * Pieces of the in-router failover for POST /v1/messages (server.ts): which
 * statuses go to the next account, how a refusal is kept to relay later, and
 * how a response that is not retried is piped through unchanged.
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { NextFunction } from "express";

/** Retried on the next account: plan or rate refusals and server-side failures. */
export const FAILOVER_STATUSES: ReadonlySet<number> = new Set([429, 529, 500, 502, 503, 504]);

export function isFailoverStatus(status: number): boolean {
  return FAILOVER_STATUSES.has(status);
}

/** A refusal held back while other accounts are tried, relayed if they all refuse. */
export interface StoredRefusal {
  status: number;
  headers: OutgoingHttpHeaders;
  body: Buffer;
  /** For the log line: "HTTP 429", "connection error (...)". */
  reason: string;
}

export interface FailoverState {
  /** Accounts this request has been sent to (or skipped), never sent to again. */
  tried: Set<string>;
  /** req.url as the proxy first saw it; the proxy's pathRewrite edits it in place. */
  url: string;
  next: NextFunction;
  /** Attempts after the first. */
  retries: number;
  last?: StoredRefusal;
  /** Throttle slot this request holds right now. */
  throttleHeld?: string;
  /** Set while a connection error is handed to the shared handler, which then
   *  must not answer the client itself. */
  suppressErrorReply?: boolean;
}

/** Largest refusal body kept for relaying; error bodies are a few hundred bytes. */
export const MAX_REFUSAL_BYTES = 1 << 20;

/** Read a response body, keeping at most `max` bytes (the rest is drained). */
export function readCapped(stream: IncomingMessage, max: number = MAX_REFUSAL_BYTES): Promise<Buffer> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (c: Buffer) => {
      if (size >= max) return;
      const piece = c.subarray(0, max - size);
      chunks.push(piece);
      size += piece.length;
    });
    const done = () => resolve(Buffer.concat(chunks));
    stream.once("end", done);
    stream.once("error", done);
    stream.once("aborted", done);
  });
}

/**
 * Pipe an upstream response to the client as http-proxy itself would with
 * selfHandleResponse off: status, headers as received (and as the shared
 * handlers may have edited them), then the body as it arrives. SSE included:
 * every chunk is written the moment it comes.
 */
export function relayResponse(proxyRes: IncomingMessage, res: ServerResponse): void {
  if (res.headersSent || res.destroyed) {
    proxyRes.resume();
    return;
  }
  res.statusCode = proxyRes.statusCode ?? 502;
  if (proxyRes.statusMessage) res.statusMessage = proxyRes.statusMessage;
  for (const [name, value] of Object.entries(proxyRes.headers)) {
    if (value !== undefined) res.setHeader(name, value);
  }
  proxyRes.pipe(res);
}
