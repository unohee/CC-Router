import { describe, expect, it } from "vitest";
import { createServer } from "http";
import express from "express";
import { mountMessagesCrossProviderRoute } from "../proxy/messages-cross-route.js";
import { SessionRouter } from "../proxy/session-router.js";
import type { SessionTarget } from "../proxy/session-router.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import {
  BYTES_PER_TOKEN,
  CODEX_SESSION_CEILING,
  targetCanHoldContext,
} from "../providers/openai/context-limits.js";

const OPENAI_ACCOUNT = {
  id: "codex",
  provider: "openai_subscription" as const,
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 60 * 60 * 1000,
  enabled: true,
};

/** A Messages body whose raw bytes estimate to roughly `tokens` tokens. */
function bodyOfSize(tokens: number): string {
  const envelope = JSON.stringify({
    model: "claude-opus-4",
    max_tokens: 128,
    messages: [{ role: "user", content: "" }],
    stream: false,
  });
  const padding = Math.max(0, tokens * BYTES_PER_TOKEN - envelope.length);
  return JSON.stringify({
    model: "claude-opus-4",
    max_tokens: 128,
    messages: [{ role: "user", content: "x".repeat(padding) }],
    stream: false,
  });
}

async function withRoute(
  opts: Parameters<typeof mountMessagesCrossProviderRoute>[1],
  run: (url: string, fellThrough: () => boolean) => Promise<void>,
): Promise<void> {
  const app = express();
  let reachedAnthropic = false;
  mountMessagesCrossProviderRoute(app, opts);
  // Stands in for the Anthropic proxy mounted after this route. Reaching it is
  // how "did not go to OpenAI" is observed.
  app.post("/v1/messages", (_req, res) => {
    reachedAnthropic = true;
    res.status(200).json({ ok: "anthropic" });
  });

  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
  try {
    await run(`http://127.0.0.1:${address.port}/v1/messages`, () => reachedAnthropic);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function okResponse(): Response {
  return new Response(JSON.stringify({
    id: "resp_1",
    model: "gpt-5.6-sol",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 4, output_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("cross-provider fallback is sized before it is taken", () => {
  it("does not hand Codex a conversation it cannot hold", async () => {
    const forwarded: OpenAIResponsesRequest[] = [];
    await withRoute({
      getOpenAIAccount: () => OPENAI_ACCOUNT,
      crossProviderFallback: true,
      hasAvailableAnthropicAccount: () => false,
      modelRouting: { openAIDefaultModel: "gpt-5.6-sol" },
      forwardOpenAI: async ({ body }) => { forwarded.push(body); return okResponse(); },
    }, async (url, fellThrough) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyOfSize(CODEX_SESSION_CEILING + 10_000),
      });
      expect(res.status).toBe(200);
      // Falling through to a rate-limited Anthropic pool returns that pool's own
      // 429, which the client can retry. Being refused by Codex mid-session
      // returns nothing it can act on, and costs a full prefix rewrite.
      expect(forwarded).toEqual([]);
      expect(fellThrough()).toBe(true);
    });
  });

  it("still takes the fallback for a conversation that fits", async () => {
    const forwarded: OpenAIResponsesRequest[] = [];
    await withRoute({
      getOpenAIAccount: () => OPENAI_ACCOUNT,
      crossProviderFallback: true,
      hasAvailableAnthropicAccount: () => false,
      modelRouting: { openAIDefaultModel: "gpt-5.6-sol" },
      forwardOpenAI: async ({ body }) => { forwarded.push(body); return okResponse(); },
    }, async (url, fellThrough) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyOfSize(1_000),
      });
      expect(res.status).toBe(200);
      expect(forwarded).toHaveLength(1);
      expect(fellThrough()).toBe(false);
    });
  });
});

describe("placement is told how big the request is", () => {
  it("passes an estimate that tracks the body, not a constant", async () => {
    const seen: (number | null)[] = [];
    await withRoute({
      getOpenAIAccount: () => OPENAI_ACCOUNT,
      modelRouting: { openAIDefaultModel: "gpt-5.6-sol" },
      resolveSessionTarget: (_id, estimated) => { seen.push(estimated); return null; },
      forwardOpenAI: async () => okResponse(),
    }, async (url) => {
      const small = bodyOfSize(1_000);
      const large = bodyOfSize(400_000);
      for (const body of [small, large]) {
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "s-1" },
          body,
        });
      }
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(Math.ceil(Buffer.byteLength(small) / BYTES_PER_TOKEN));
      expect(seen[1]).toBe(Math.ceil(Buffer.byteLength(large) / BYTES_PER_TOKEN));
    });
  });
});

describe("an existing Codex pin is released when the conversation outgrows it", () => {
  // Rebuilds the predicates startServer derives in resolveSessionTarget. What
  // is under test is that a pin survives on the retention predicate alone —
  // leaving Codex out of `candidates` is not enough to move a pinned session,
  // because `resolve` never consults that list for one.
  const anthropic: SessionTarget[] = [
    { provider: "anthropic", accountId: "kyte" },
    { provider: "anthropic", accountId: "intrect" },
  ];
  const codex: SessionTarget = { provider: "openai", accountId: "codex" };

  function place(router: SessionRouter, sessionId: string, estimated: number | null): SessionTarget | null {
    const candidates = targetCanHoldContext("openai", estimated)
      ? [...anthropic, codex]
      : [...anthropic];
    const fits = (t: SessionTarget) => targetCanHoldContext(t.provider, estimated);
    return router.resolve(sessionId, candidates, fits, undefined, fits);
  }

  it("keeps the pin while the conversation still fits", () => {
    const router = new SessionRouter();
    router.restore([{ sessionId: "s", provider: "openai", accountId: "codex", lastSeen: Date.now() }]);
    expect(place(router, "s", CODEX_SESSION_CEILING)).toEqual(codex);
  });

  it("moves the session to a Claude account before Codex has to refuse it", () => {
    const moves: { from: SessionTarget; to: SessionTarget }[] = [];
    const router = new SessionRouter({ onReassign: ({ from, to }) => { moves.push({ from, to }); } });
    router.restore([{ sessionId: "s", provider: "openai", accountId: "codex", lastSeen: Date.now() }]);

    const placed = place(router, "s", CODEX_SESSION_CEILING + 1);

    expect(placed?.provider).toBe("anthropic");
    expect(moves).toHaveLength(1);
    expect(moves[0].from).toEqual(codex);
    expect(moves[0].to.provider).toBe("anthropic");
    // And it stays moved: the next request finds an Anthropic pin, so the move
    // is paid once rather than on every turn.
    expect(place(router, "s", CODEX_SESSION_CEILING + 1)).toEqual(placed);
  });

  it("leaves an unmeasured request on its Codex pin rather than churning it", () => {
    const router = new SessionRouter();
    router.restore([{ sessionId: "s", provider: "openai", accountId: "codex", lastSeen: Date.now() }]);
    expect(place(router, "s", null)).toEqual(codex);
  });
});
