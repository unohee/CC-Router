import { describe, expect, it, vi } from "vitest";
import { SessionRouter } from "../proxy/session-router.js";
import type { SessionTarget } from "../proxy/session-router.js";

const A: SessionTarget = { provider: "anthropic", accountId: "a" };
const B: SessionTarget = { provider: "anthropic", accountId: "b" };
const OPENAI: SessionTarget = { provider: "openai", accountId: "codex" };
const ALL = [A, B, OPENAI];
const always = () => true;

describe("SessionRouter", () => {
  it("keeps a session on the account it was first assigned", () => {
    const router = new SessionRouter();
    const first = router.resolve("s1", ALL, always);

    for (let i = 0; i < 5; i++) {
      expect(router.resolve("s1", ALL, always)).toEqual(first);
    }
  });

  it("spreads distinct sessions across the pool", () => {
    const router = new SessionRouter();
    const assigned = ["s1", "s2", "s3"].map(id => router.resolve(id, ALL, always));

    expect(new Set(assigned.map(t => t!.accountId)).size).toBe(3);
  });

  it("reassigns when the pinned account can no longer serve", () => {
    const onReassign = vi.fn();
    const router = new SessionRouter({ onReassign });
    const first = router.resolve("s1", ALL, always)!;

    // The pinned account goes rate-limited; everything else is fine.
    const moved = router.resolve("s1", ALL, t => t.accountId !== first.accountId)!;

    expect(moved.accountId).not.toBe(first.accountId);
    expect(onReassign).toHaveBeenCalledWith({ sessionId: "s1", from: first, to: moved });
    // The move sticks — the session does not bounce back on the next request.
    expect(router.resolve("s1", ALL, always)).toEqual(moved);
  });

  it("never pins a session to an account that is already unusable", () => {
    const router = new SessionRouter();
    const target = router.resolve("s1", ALL, t => t.accountId === "b")!;

    expect(target).toEqual(B);
  });

  it("returns null when nothing can serve, leaving the caller to degrade", () => {
    const router = new SessionRouter();

    expect(router.resolve("s1", ALL, () => false)).toBeNull();
  });

  it("forgets an assignment once it goes untouched past the TTL", () => {
    let now = 1_000;
    const router = new SessionRouter({ ttlMs: 60_000, now: () => now });
    router.resolve("s1", [A], always);
    expect(router.peek("s1")).toEqual(A);

    now += 60_001;
    router.resolve("other", [A], always);   // any call sweeps

    expect(router.peek("s1")).toBeNull();
  });

  it("keeps an assignment alive while the session stays active", () => {
    let now = 1_000;
    const router = new SessionRouter({ ttlMs: 60_000, now: () => now });
    router.resolve("s1", [A, B], always);

    for (let i = 0; i < 5; i++) {
      now += 50_000;                        // under the TTL each time
      router.resolve("s1", [A, B], always);
    }

    expect(router.peek("s1")).toEqual(A);
  });

  it("hands whole sessions to an OpenAI account when one is in the pool", () => {
    const router = new SessionRouter();
    const targets = ["s1", "s2", "s3"].map(id => router.resolve(id, ALL, always)!);

    expect(targets.filter(t => t.provider === "openai")).toHaveLength(1);
  });

  it("excludes OpenAI entirely when the caller does not offer it", () => {
    const router = new SessionRouter();
    const targets = ["s1", "s2", "s3", "s4"].map(id => router.resolve(id, [A, B], always)!);

    expect(targets.every(t => t.provider === "anthropic")).toBe(true);
  });

  it("gives a new session to the target holding the fewest sessions", () => {
    const router = new SessionRouter();
    // Three sessions land one per target, then the next three must repeat that
    // spread rather than stacking onto whichever comes next in rotation.
    for (const id of ["s1", "s2", "s3"]) router.resolve(id, ALL, always);

    const counts = new Map<string, number>();
    for (const id of ["s4", "s5", "s6"]) {
      const t = router.resolve(id, ALL, always)!;
      counts.set(t.accountId, (counts.get(t.accountId) ?? 0) + 1);
    }

    expect([...counts.values()].sort()).toEqual([1, 1, 1]);
  });

  it("does not stack new sessions onto a target that already holds several", () => {
    const router = new SessionRouter();
    // Only A is usable at first, so three sessions pile onto it.
    for (const id of ["s1", "s2", "s3"]) router.resolve(id, ALL, t => t.accountId === "a");

    // Once B and OpenAI become usable, the next sessions must go to them.
    const next = ["s4", "s5"].map(id => router.resolve(id, ALL, always)!);

    expect(next.every(t => t.accountId !== "a")).toBe(true);
    expect(new Set(next.map(t => t.accountId)).size).toBe(2);
  });

  it("still rotates between equally loaded targets", () => {
    const router = new SessionRouter();
    const seen = ["s1", "s2", "s3"].map(id => router.resolve(id, [A, B, OPENAI], always)!.accountId);

    expect(new Set(seen).size).toBe(3);
  });

  it("prefers the target with more quota left when load is equal", () => {
    const router = new SessionRouter();
    // A is nearly exhausted, B has headroom, OpenAI is untouched.
    const util = (t: SessionTarget) => ({ a: 0.85, b: 0.4, codex: 0.02 }[t.accountId] ?? 0);

    expect(router.resolve("s1", ALL, always, util)!.accountId).toBe("codex");
    expect(router.resolve("s2", ALL, always, util)!.accountId).toBe("b");
    // Only now, with the roomier two each holding a session, does A get one.
    expect(router.resolve("s3", ALL, always, util)!.accountId).toBe("a");
  });

  it("keeps rotating when tied targets have identical quota", () => {
    const router = new SessionRouter();
    const seen = ["s1", "s2", "s3"].map(id => router.resolve(id, ALL, always, () => 0.5)!.accountId);

    expect(new Set(seen).size).toBe(3);
  });

  it("treats an unmeasured target as empty so it can produce a reading", () => {
    const router = new SessionRouter();
    // B has never served a request, so its quota is unknown (0) and it wins
    // over an account known to be half spent.
    const util = (t: SessionTarget) => (t.accountId === "a" ? 0.5 : 0);

    expect(router.resolve("s1", [A, B], always, util)!.accountId).toBe("b");
  });
});
