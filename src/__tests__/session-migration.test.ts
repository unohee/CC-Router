import { describe, expect, it } from "vitest";
import {
  decideMigration, CompactAskGuard, expensiveMove, DEFAULT_MIGRATION_LIMITS as L,
  type MigrationInput,
} from "../proxy/session-migration.js";

const LARGE = L.largeSessionTokens + 1;
const HUGE = L.compactAskFloorTokens + 1;

function input(over: Partial<MigrationInput> = {}): MigrationInput {
  return {
    estimatedPromptTokens: HUGE,
    turnCount: L.minTurnsForCompact,
    block: { kind: "temporary", retryAfterSeconds: 30 },
    alternativeAvailable: true,
    alreadyAskedCompact: false,
    ...over,
  };
}

describe("decideMigration", () => {
  it("proceeds when the pin is not blocked at all", () => {
    expect(decideMigration(input({ block: { kind: "none" } })).action).toBe("proceed");
  });

  it("proceeds on an unmeasured size rather than treating it as small or large", () => {
    // The guard is about known cost. An unknown size must not stall a request.
    expect(decideMigration(input({ estimatedPromptTokens: null })).action).toBe("proceed");
  });

  it("proceeds for a session small enough that the rewrite is cheap", () => {
    const d = decideMigration(input({ estimatedPromptTokens: L.largeSessionTokens - 1 }));
    expect(d.action).toBe("proceed");
  });

  it("proceeds when there is no other account to move to", () => {
    // Waiting here would add a stall on top of the pool's own 429.
    expect(decideMigration(input({ alternativeAvailable: false })).action).toBe("proceed");
  });

  it("waits out a short cooldown instead of moving a large session", () => {
    const d = decideMigration(input({
      estimatedPromptTokens: LARGE,
      block: { kind: "temporary", retryAfterSeconds: 42 },
    }));
    expect(d).toEqual({ action: "wait", retryAfterSeconds: 42, estimatedRewriteTokens: LARGE });
  });

  it("rounds a fractional wait up to a whole second, never to zero", () => {
    const d = decideMigration(input({
      estimatedPromptTokens: LARGE,
      block: { kind: "temporary", retryAfterSeconds: 0.2 },
    }));
    expect(d).toMatchObject({ action: "wait", retryAfterSeconds: 1 });
  });

  it("does not wait out a cooldown longer than the cap", () => {
    const d = decideMigration(input({
      estimatedPromptTokens: LARGE,
      block: { kind: "temporary", retryAfterSeconds: L.maxWaitSeconds + 1 },
    }));
    // LARGE is below the compact floor, so the move simply proceeds.
    expect(d.action).toBe("proceed");
  });

  it("asks for a compaction when the move is unavoidable and the context is huge", () => {
    const d = decideMigration(input({ block: { kind: "indefinite" } }));
    expect(d).toEqual({
      action: "compact",
      estimatedPromptTokens: HUGE,
      limitTokens: L.compactAskFloorTokens,
    });
  });

  it("asks once, then lets the move happen", () => {
    const d = decideMigration(input({ block: { kind: "indefinite" }, alreadyAskedCompact: true }));
    expect(d.action).toBe("proceed");
  });

  it("never asks a conversation too short to compact", () => {
    // Claude Code refuses to compact a single exchange and shows the user an
    // error instead, so the ask would convert a move into a failed turn.
    const d = decideMigration(input({
      block: { kind: "indefinite" },
      turnCount: L.minTurnsForCompact - 1,
    }));
    expect(d.action).toBe("proceed");
  });

  it("does not ask below the compact floor, where compaction costs more than it saves", () => {
    const d = decideMigration(input({
      block: { kind: "indefinite" },
      estimatedPromptTokens: L.compactAskFloorTokens - 1,
    }));
    expect(d.action).toBe("proceed");
  });

  it("prefers waiting over asking when the block has a short deadline", () => {
    // Both are available here: huge context, but the account frees up in 30s.
    const d = decideMigration(input());
    expect(d.action).toBe("wait");
  });
});

describe("CompactAskGuard", () => {
  it("remembers an ask for the cooldown window and forgets it after", () => {
    let now = 1_000_000;
    const guard = new CompactAskGuard({ now: () => now, cooldownMs: 10_000 });

    expect(guard.askedRecently("s1")).toBe(false);
    guard.markAsked("s1");
    expect(guard.askedRecently("s1")).toBe(true);

    now += 9_999;
    expect(guard.askedRecently("s1")).toBe(true);
    now += 1;
    expect(guard.askedRecently("s1")).toBe(false);
  });

  it("keeps sessions apart", () => {
    const guard = new CompactAskGuard({ cooldownMs: 10_000 });
    guard.markAsked("s1");
    expect(guard.askedRecently("s2")).toBe(false);
  });

  
  });

describe("expensiveMove", () => {
  const a = { provider: "anthropic", accountId: "intrect" };
  const b = { provider: "anthropic", accountId: "kyte" };
  const codex = { provider: "openai", accountId: "codex" };

  it("reports a move between two Anthropic accounts", () => {
    expect(expensiveMove(a, b, 750_000)).toEqual({
      fromAccountId: "intrect", toAccountId: "kyte", estimatedTokens: 750_000,
    });
  });

  it("ignores a first placement, which has no cache to lose", () => {
    expect(expensiveMove(null, b, 750_000)).toBeNull();
    expect(expensiveMove(undefined, b, 750_000)).toBeNull();
  });

  it("ignores staying on the same account", () => {
    expect(expensiveMove(a, a, 750_000)).toBeNull();
  });

  it("leaves the Codex paths to their own reporting", () => {
    expect(expensiveMove(codex, b, 750_000)).toBeNull();
    expect(expensiveMove(a, codex, 750_000)).toBeNull();
  });

  it("stays silent when there is no number to report", () => {
    expect(expensiveMove(a, b, null)).toBeNull();
  });
});

describe("CompactAskGuard — the window is the only thing that lifts an ask", () => {
  it("is not cleared by a small request on the same session", () => {
    // Claude Code issues small side-calls under the same session id. If those
    // lifted the ask, an interleaved one would erase the bound while the large
    // conversation was still mid-flight.
    let now = 0;
    const guard = new CompactAskGuard({ now: () => now, cooldownMs: 600_000 });
    guard.markAsked("s1");
    now += 1_000;
    expect(guard.askedRecently("s1")).toBe(true);
  });

  it("bounds asks to one per window no matter how many requests arrive", () => {
    let now = 0;
    const guard = new CompactAskGuard({ now: () => now, cooldownMs: 600_000 });
    let asks = 0;
    for (let i = 0; i < 50; i++) {
      if (!guard.askedRecently("s1")) { guard.markAsked("s1"); asks++; }
      now += 10_000;
    }
    // 50 requests over 500s — one window, so exactly one ask.
    expect(asks).toBe(1);
  });
});
