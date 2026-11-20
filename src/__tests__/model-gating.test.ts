import { describe, it, expect } from "vitest";
import { TokenPool } from "../proxy/token-pool.js";
import type { Account } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";
import { lacksModel, modelLimitKey } from "../proxy/model-cooldown.js";
import { discoverAnthropicModelIds } from "../proxy/models-server.js";

function makeAccount(id: string, models?: string[]): Account {
  return {
    id,
    tokens: { accessToken: `t-${id}`, refreshToken: `r-${id}`, expiresAt: Date.now() + 3_600_000, scopes: [] },
    healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0,
    consecutiveErrors: 0, rateLimits: { ...DEFAULT_RATE_LIMITS }, enabled: true,
    sessionLimitPercent: 100, weeklyLimitPercent: 100,
    anthropicModels: models,
  };
}

const BASE = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"];
const CVP = [...BASE, "claude-mythos-5-2"];

describe("per-account model gating", () => {
  it("treats Mythos as its own family", () => {
    expect(modelLimitKey("claude-mythos-5-2[1m]")).toBe("mythos");
    expect(modelLimitKey("anthropic/claude-mythos-5-1")).toBe("mythos");
  });

  it("gates only when the account's list is known and lacks the family", () => {
    expect(lacksModel(makeAccount("a", BASE), "claude-mythos-5-2")).toBe(true);
    expect(lacksModel(makeAccount("a", CVP), "claude-mythos-5-1")).toBe(false);
    expect(lacksModel(makeAccount("a"), "claude-mythos-5-2")).toBe(false);
    expect(lacksModel(makeAccount("a", BASE), "claude-opus-5-5")).toBe(false);
    expect(lacksModel(makeAccount("a", BASE), "some-unknown-model")).toBe(false);
  });

  it("routes Mythos only to granted accounts and leaves other models round-robin", () => {
    const plain = makeAccount("plain", BASE);
    const granted = makeAccount("granted", CVP);
    const pool = new TokenPool([plain, granted]);
    for (let i = 0; i < 4; i++) expect(pool.getNext("claude-mythos-5-2").id).toBe("granted");
    const seen = new Set([0, 1, 2, 3].map(() => pool.getNext("claude-opus-5-5").id));
    expect(seen).toEqual(new Set(["plain", "granted"]));
  });

  it("does not retain a pinned session on an account that lacks the model", () => {
    const pool = new TokenPool([makeAccount("plain", BASE), makeAccount("granted", CVP)]);
    expect(pool.canRetain("plain", "claude-mythos-5-2")).toBe(false);
    expect(pool.canRetain("plain", "claude-opus-5-5")).toBe(true);
    expect(pool.canRetain("granted", "claude-mythos-5-2")).toBe(true);
  });

  it("falls back to normal rotation when no account lists the model", () => {
    const pool = new TokenPool([makeAccount("a", BASE), makeAccount("b", BASE)]);
    expect(["a", "b"]).toContain(pool.getNext("claude-mythos-5-2").id);
  });

  it("discovery records each account's list and keeps it on a failed read", async () => {
    const a = makeAccount("a");
    const b = makeAccount("b", BASE);
    const lists: Record<string, string[] | Error> = { a: CVP, b: new Error("timeout") };
    await discoverAnthropicModelIds([a, b], async acc => {
      const v = lists[acc.id];
      if (v instanceof Error) throw v;
      return v;
    });
    expect(a.anthropicModels).toEqual(CVP);
    expect(b.anthropicModels).toEqual(BASE);
  });
});

describe("session pin with per-account model gating", () => {
  it("moves a session pinned to an ungranted account once, then keeps it", async () => {
    const { SessionRouter } = await import("../proxy/session-router.js");
    const plain = makeAccount("plain", BASE);
    const g1 = makeAccount("g1", CVP);
    const g2 = makeAccount("g2", CVP);
    const pool = new TokenPool([plain, g1, g2]);
    const router = new SessionRouter();
    const targets = [plain, g1, g2].map(a => ({ provider: "anthropic" as const, accountId: a.id }));
    const resolve = (model: string) => router.resolve(
      "s", targets, t => pool.canServe(t.accountId, model), undefined, t => pool.canRetain(t.accountId, model),
    );
    // Pin the session on the ungranted account first, as an Opus turn could.
    expect(router.resolve("s", targets, t => t.accountId === "plain")!.accountId).toBe("plain");
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add(resolve("claude-mythos-5-2")!.accountId);
    expect(seen.size).toBe(1);
    expect(["g1", "g2"]).toContain([...seen][0]);
    // A later Opus turn stays where Mythos put it.
    expect(resolve("claude-opus-5-5")!.accountId).toBe([...seen][0]);
  });
});

describe("count_tokens prefix", () => {
  it("strips anthropic/ on count_tokens even without the Ollama fallback", async () => {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { mountMessagesCrossProviderRoute } = await import("../proxy/messages-cross-route.js");
    const app = express();
    mountMessagesCrossProviderRoute(app, { getOpenAIAccount: () => null, forwardOpenAI: async () => new Response("unused") });
    app.use("/v1/messages/count_tokens", (req, res) => { res.json({ raw: req._ccRawBody?.toString("utf8") }); });
    const server = createServer(app);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/messages/count_tokens`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude-mythos-5-2", messages: [{ role: "user", content: "hi" }] }),
      });
      const out = await res.json() as { raw: string };
      expect(JSON.parse(out.raw).model).toBe("claude-mythos-5-2");
    } finally {
      await new Promise<void>((r, j) => server.close(e => e ? j(e) : r()));
    }
  });
});
