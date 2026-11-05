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

/** Why an attempt was failed over from: the upstream status, or what went wrong before one. */
export type FailoverReason = "429" | "529" | "500" | "502" | "503" | "504" | "connection" | "token-refresh";
export const FAILOVER_REASONS: ReadonlyArray<FailoverReason> = ["429", "529", "500", "502", "503", "504", "connection", "token-refresh"];

/**
 * How a request that entered failover ended:
 *   recovered   another account answered it (status < 400)
 *   refused     another account answered with a status that is not retried (a 4xx)
 *   ollama      every account refused and the Ollama fallback answered
 *   exhausted   every account refused, Ollama did not answer, the last refusal was relayed
 *   clientGone  the client hung up before an answer
 */
export type FailoverOutcome = "recovered" | "refused" | "ollama" | "exhausted" | "clientGone";
export const FAILOVER_OUTCOMES: ReadonlyArray<FailoverOutcome> = ["recovered", "refused", "ollama", "exhausted", "clientGone"];

/** A refusal held back while other accounts are tried, relayed if they all refuse. */
export interface StoredRefusal {
  status: number;
  headers: OutgoingHttpHeaders;
  body: Buffer;
  /** For the log line: "HTTP 429", "connection error (...)". */
  reason: string;
  /** For the counters. */
  kind: FailoverReason;
}

/** The reason for an upstream status that is failed over from. */
export function reasonOfStatus(status: number): FailoverReason {
  const s = String(status);
  return (FAILOVER_REASONS as ReadonlyArray<string>).includes(s) ? s as FailoverReason : "connection";
}

export interface FailoverSnapshot {
  enabled: boolean;
  /** Requests that met at least one refusal and entered the failover chain. */
  requests: number;
  /** Attempts sent to another account. */
  retries: number;
  byOutcome: Record<FailoverOutcome, number>;
  /** Refusals that triggered a failover step, by what they were. */
  byReason: Record<FailoverReason, number>;
  /** When a request last entered failover, epoch ms. */
  lastAt: number | null;
}

/** Counters since the router started; health reports them. */
export class FailoverCounters {
  private requests = 0;
  private retries = 0;
  private lastAt: number | null = null;
  private readonly byOutcome = Object.fromEntries(FAILOVER_OUTCOMES.map(o => [o, 0])) as Record<FailoverOutcome, number>;
  private readonly byReason = Object.fromEntries(FAILOVER_REASONS.map(r => [r, 0])) as Record<FailoverReason, number>;

  constructor(private readonly enabled: boolean, private readonly now: () => number = Date.now) {}

  /** A request met its first refusal. */
  entered(): void { this.requests++; this.lastAt = this.now(); }
  /** A refusal of this kind sent the request on (to another account, or to the end of the chain). */
  refused(reason: FailoverReason): void { this.byReason[reason]++; }
  retried(): void { this.retries++; }
  ended(outcome: FailoverOutcome): void { this.byOutcome[outcome]++; }

  snapshot(): FailoverSnapshot {
    return {
      enabled: this.enabled, requests: this.requests, retries: this.retries,
      byOutcome: { ...this.byOutcome }, byReason: { ...this.byReason }, lastAt: this.lastAt,
    };
  }
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
  /** The request has met a refusal and is counted as having entered failover. */
  entered?: boolean;
  /** Its outcome has been counted. */
  ended?: boolean;
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
