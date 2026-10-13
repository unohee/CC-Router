import { describe, expect, it } from "vitest";
import { createServer } from "http";
import express, { type Express } from "express";
import { mountMessagesCrossProviderRoute } from "../proxy/messages-cross-route.js";
import { CompactAskGuard, type PinBlock } from "../proxy/session-migration.js";
import { SessionContextTracker } from "../proxy/session-context-tracker.js";
import type { SessionTarget } from "../proxy/session-router.js";

const PINNED: SessionTarget = { provider: "anthropic", accountId: "kyte" };

/** A body whose raw size lands above the given token estimate (2 bytes/token). */
function bodyOfTokens(tokens: number, turns: number): Record<string, unknown> {
  const filler = "x".repeat(Math.max(1, tokens * 2));
  const messages = Array.from({ length: turns }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: i === 0 ? filler : `turn ${i}`,
  }));
  return { model: "claude-opus-5", max_tokens: 16, messages };
}

interface Harness {
  app: Express;
  resolveCalls: string[];
  forwarded: number;
}

function harness(block: PinBlock, over: {
  alternativeAvailable?: boolean;
  guard?: CompactAskGuard;
  askClientToCompact?: boolean;
  holdOnCooldown?: boolean;
} = {}): Harness {
  const h: Harness = { app: express(), resolveCalls: [], forwarded: 0 };

  mountMessagesCrossProviderRoute(h.app, {
    getOpenAIAccount: () => null,
    peekSessionTarget: () => PINNED,
    inspectSessionPin: () => block,
    hasAlternativeAccount: () => over.alternativeAvailable ?? true,
    compactAskGuard: over.guard,
    askClientToCompact: over.askClientToCompact ?? false,
    holdOnCooldown: over.holdOnCooldown ?? true,
    resolveSessionTarget: (sessionId) => {
      h.resolveCalls.push(sessionId);
      return PINNED;
    },
  });

  // Stands in for the Anthropic proxy the route falls through to.
  h.app.post("/v1/messages", (_req, res) => {
    h.forwarded++;
    res.status(200).json({ ok: true });
  });

  return h;
}

async function post(app: Express, body: unknown, sessionId = "session-aaaaaaaa"): Promise<Response> {
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    return await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": sessionId },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe("account-move policy on /v1/messages", () => {
  it("holds a large session on its own account and never resolves a new target", async () => {
    const h = harness({ kind: "temporary", retryAfterSeconds: 30 });
    const res = await post(h.app, bodyOfTokens(300_000, 8));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("x-cc-router-reason")).toBe("hold-session-on-account");
    // The decisive assertion: the pin was never re-resolved, so nothing moved.
    expect(h.resolveCalls).toEqual([]);
    expect(h.forwarded).toBe(0);
  });

  it("asks the client to compact before a move it cannot avoid, exactly once", async () => {
    const guard = new CompactAskGuard();
    const h = harness({ kind: "indefinite" }, { guard, askClientToCompact: true });
    const big = bodyOfTokens(500_000, 8);

    const first = await post(h.app, big);
    expect(first.status).toBe(400);
    expect(first.headers.get("x-cc-router-reason")).toBe("compact-before-account-move");
    const body = await first.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    // Upstream's own wording is what makes the client compact and retry.
    expect(body.error.message).toMatch(/^prompt is too long: \d+ tokens > \d+ maximum$/);
    expect(h.resolveCalls).toEqual([]);

    // A retry that is still large must not be asked again, or the session
    // compacts in a loop — the thrashing this mechanism could otherwise cause.
    const second = await post(h.app, big);
    expect(second.status).toBe(200);
    expect(h.resolveCalls).toEqual(["session-aaaaaaaa"]);
  });

  it("lets a small session move without interference", async () => {
    const h = harness({ kind: "indefinite" });
    const res = await post(h.app, bodyOfTokens(1_000, 8));

    expect(res.status).toBe(200);
    expect(h.resolveCalls).toEqual(["session-aaaaaaaa"]);
    expect(h.forwarded).toBe(1);
  });

  it("does not hold a session when no other account could take it anyway", async () => {
    const h = harness({ kind: "temporary", retryAfterSeconds: 30 }, { alternativeAvailable: false });
    const res = await post(h.app, bodyOfTokens(300_000, 8));

    expect(res.status).toBe(200);
    expect(h.resolveCalls).toEqual(["session-aaaaaaaa"]);
  });

  it("leaves an unblocked pin entirely alone", async () => {
    const h = harness({ kind: "none" });
    const res = await post(h.app, bodyOfTokens(900_000, 20));

    expect(res.status).toBe(200);
    expect(h.resolveCalls).toEqual(["session-aaaaaaaa"]);
  });

  it("does not ask a conversation too short to compact", async () => {
    const h = harness({ kind: "indefinite" }, { guard: new CompactAskGuard(), askClientToCompact: true });
    const res = await post(h.app, bodyOfTokens(500_000, 2));

    expect(res.status).toBe(200);
    expect(h.resolveCalls).toEqual(["session-aaaaaaaa"]);
  });

  it("does nothing for a request that carries no session id", async () => {
    const h = harness({ kind: "temporary", retryAfterSeconds: 30 });
    const res = await post(h.app, bodyOfTokens(300_000, 8), "");

    expect(res.status).toBe(200);
  });

  it("does not ask the client to compact unless the mechanism is opted into", async () => {
    // Default-off is the contract: inducing client compaction is the failure
    // mode this whole area exists to prevent, and that Claude Code answers the
    // 400 by compacting rather than erroring rests on one observation.
    const h = harness({ kind: "indefinite" }, { guard: new CompactAskGuard() });
    const res = await post(h.app, bodyOfTokens(500_000, 8));

    expect(res.status).toBe(200);
    expect(h.resolveCalls).toEqual(["session-aaaaaaaa"]);
  });

  it("can be told not to hold sessions either", async () => {
    const h = harness({ kind: "temporary", retryAfterSeconds: 30 }, { holdOnCooldown: false });
    const res = await post(h.app, bodyOfTokens(300_000, 8));

    expect(res.status).toBe(200);
    expect(h.resolveCalls).toEqual(["session-aaaaaaaa"]);
  });
});

describe("compaction visibility on /v1/messages", () => {
  it("reports a client-side compaction, with the size it fell from", async () => {
    const seen: { fromTokens: number; toTokens: number }[] = [];
    const app = express();
    const tracker = new SessionContextTracker();

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => null,
      peekSessionTarget: () => PINNED,
      inspectSessionPin: () => ({ kind: "none" }),
      contextTracker: tracker,
      onCompactionObserved: ({ fromTokens, toTokens }) => { seen.push({ fromTokens, toTokens }); },
      resolveSessionTarget: () => PINNED,
    });
    app.post("/v1/messages", (_req, res) => { res.status(200).json({ ok: true }); });

    // Grow, then drop and stay dropped. Nothing is moving accounts here — the
    // point is that the router now sees what the client did on its own.
    await post(app, bodyOfTokens(900_000, 8));
    expect(seen).toEqual([]);
    await post(app, bodyOfTokens(120_000, 8));
    expect(seen).toEqual([]);            // one small request is not proof
    await post(app, bodyOfTokens(120_000, 8));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.fromTokens).toBeGreaterThan(800_000);
    expect(seen[0]!.toTokens).toBeLessThan(200_000);
  });
});
