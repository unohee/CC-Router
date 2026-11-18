/**
 * Client requests the router is still answering.
 *
 * Counted at the HTTP layer, from the moment a /v1 request arrives until its
 * response closes (finished or the client hung up). Health reports the number,
 * so a deploy can wait for a quiet moment before a restart, and a draining
 * worker can tell when it is done.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export class InFlightCounter {
  private open = 0;
  private servedTotal = 0;
  private readonly responses = new Set<ServerResponse>();

  /** Requests whose response has not closed yet. */
  get current(): number {
    return this.open;
  }

  /** Requests whose response has closed, since start. */
  get served(): number {
    return this.servedTotal;
  }

  /** Counts `res` until it closes. Safe to call once per request. */
  track(res: ServerResponse): void {
    this.open++;
    this.responses.add(res);
    let done = false;
    res.once("close", () => {
      if (done) return;
      done = true;
      this.open--;
      this.servedTotal++;
      this.responses.delete(res);
    });
  }

  /** The responses still open, for a drain that has run out of time. */
  openResponses(): ServerResponse[] {
    return [...this.responses];
  }

  snapshot(): { requests: number; served: number } {
    return { requests: this.open, served: this.servedTotal };
  }
}

/** Only model traffic counts; health polls and dashboard loads do not hold a restart. */
export function countsAsInFlight(req: IncomingMessage): boolean {
  const url = req.url ?? "";
  return url.startsWith("/v1/");
}
