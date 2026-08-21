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

  it("carries assignments across a restart", () => {
    const before = new SessionRouter();
    const pinned = before.resolve("s1", ALL, always)!;

    const after = new SessionRouter();
    after.restore(before.snapshot());

    // The restored session finds its old account instead of being handed a new
    // one — otherwise its whole prompt cache is rewritten elsewhere.
    expect(after.resolve("s1", ALL, always)).toEqual(pinned);
  });

  it("drops entries already past the TTL rather than reviving them", () => {
    let now = 1_000_000;
    const source = new SessionRouter({ ttlMs: 60_000, now: () => now });
    source.resolve("stale", [A], always);
    const snap = source.snapshot();

    now += 120_000;
    const restored = new SessionRouter({ ttlMs: 60_000, now: () => now });
    restored.restore(snap);

    // Idle that long means no warm cache is left to protect.
    expect(restored.peek("stale")).toBeNull();
  });

  it("reassigns a restored session whose account is gone", () => {
    const source = new SessionRouter();
    source.resolve("s1", [{ provider: "anthropic", accountId: "removed" }], always);

    const restored = new SessionRouter();
    restored.restore(source.snapshot());
    const target = restored.resolve("s1", ALL, t => t.accountId !== "removed")!;

    expect(target.accountId).not.toBe("removed");
  });

  it("ignores malformed snapshot entries instead of failing to start", () => {
    const router = new SessionRouter();
    router.restore([
      { sessionId: "", provider: "anthropic", accountId: "a", lastSeen: Date.now() },
      { sessionId: "bad-provider", provider: "gemini", accountId: "a", lastSeen: Date.now() },
      { sessionId: "no-time", provider: "anthropic", accountId: "a" },
      { sessionId: "good", provider: "anthropic", accountId: "a", lastSeen: Date.now() },
    ] as Parameters<typeof router.restore>[0]);

    expect(router.peek("good")).toEqual(A);
    expect(router.peek("bad-provider")).toBeNull();
    expect(router.peek("no-time")).toBeNull();
  });

  it("notifies on assignment changes so the snapshot can be persisted", () => {
    const onAssignmentsChanged = vi.fn();
    const router = new SessionRouter({ onAssignmentsChanged });

    router.resolve("s1", ALL, always);
    expect(onAssignmentsChanged).toHaveBeenCalledTimes(1);

    // A repeat request refreshes lastSeen, which must also be persisted —
    // otherwise a busy session's snapshot keeps its first timestamp and
    // restores as expired.
    router.resolve("s1", ALL, always);
    expect(onAssignmentsChanged).toHaveBeenCalledTimes(2);
  });

  it("keeps an active session alive across a restart past the original TTL", () => {
    let now = 1_000_000;
    const source = new SessionRouter({ ttlMs: 60_000, now: () => now });
    source.resolve("busy", [A, B], always);

    // Active the whole time, always reusing the same pin.
    for (let i = 0; i < 5; i++) {
      now += 30_000;
      source.resolve("busy", [A, B], always);
    }

    const restored = new SessionRouter({ ttlMs: 60_000, now: () => now });
    restored.restore(source.snapshot());

    expect(restored.peek("busy")).toEqual(A);
  });

  it("holds a pin through a state that would block a new placement", () => {
    const router = new SessionRouter();
    const pinned = router.resolve("s1", ALL, always)!;

    // Placement rejects it (busy), retention accepts it.
    const kept = router.resolve("s1", ALL, t => t.accountId !== pinned.accountId, undefined,
      () => true)!;

    expect(kept).toEqual(pinned);
  });

  it("still moves a session when retention itself says no", () => {
    const router = new SessionRouter();
    const pinned = router.resolve("s1", ALL, always)!;

    const moved = router.resolve("s1", ALL, t => t.accountId !== pinned.accountId, undefined,
      () => false)!;

    expect(moved.accountId).not.toBe(pinned.accountId);
  });
});

describe("repin durability and idempotence", () => {
  const anthropicOnly: SessionTarget[] = [
    { provider: "anthropic", accountId: "intrect" },
    { provider: "anthropic", accountId: "kyte" },
  ];
  const usable = () => true;

  it("persists a forget, because a lost deletion restores the rejected pin", () => {
    // Losing an addition costs one placement. Losing a deletion sends the
    // session back to the account that just refused it.
    let persists = 0;
    const router = new SessionRouter({ onAssignmentsChanged: () => persists++ });
    router.restore([{ sessionId: "s", provider: "openai", accountId: "codex", lastSeen: Date.now() }]);

    persists = 0;
    router.forget("s");

    expect(persists).toBe(1);
  });

  it("does not persist a forget for a session it never had", () => {
    let persists = 0;
    const router = new SessionRouter({ onAssignmentsChanged: () => persists++ });

    router.forget("never-seen");

    expect(persists).toBe(0);
  });

  it("returns the same account when concurrent refusals both repin", () => {
    // The production bug: two in-flight requests are both refused, each calls
    // in, and the second wipes the first's placement. leastLoaded's cursor has
    // advanced, so it hands back a different account every time — and the
    // conversation is re-written into it.
    const router = new SessionRouter();
    router.restore([{ sessionId: "s", provider: "openai", accountId: "codex", lastSeen: Date.now() }]);

    const first = router.repinOnto("s", anthropicOnly, usable, undefined, usable);
    const second = router.repinOnto("s", anthropicOnly, usable, undefined, usable);

    expect(first?.accountId).toBe(second?.accountId);
  });

  it("still moves a session off an account that has gone unusable", () => {
    // Idempotence must not become stickiness. `canRetain` is looser than
    // `canServe` by exactly one condition, so an account that fails retention
    // also fails placement — both predicates have to reject it here, which is
    // the only combination production can actually produce.
    const router = new SessionRouter();
    router.restore([{ sessionId: "s", provider: "anthropic", accountId: "intrect", lastSeen: Date.now() }]);
    const notIntrect = (t: SessionTarget) => t.accountId !== "intrect";

    const moved = router.repinOnto("s", anthropicOnly, notIntrect, undefined, notIntrect);

    expect(moved?.accountId).toBe("kyte");
  });

  it("re-places rather than revives a pin the TTL has already retired", () => {
    // The early return reads the assignment map, so it has to sweep first.
    // Otherwise a long-idle session is handed straight back to its old account
    // instead of being placed against current load — the account it left may
    // now be the busiest one.
    // The clock has to move *between* restore and repin: restore drops entries
    // that are already expired, so a fixed future clock never puts one in the
    // map and the sweep path is never exercised.
    let clock = Date.now();
    const router = new SessionRouter({ ttlMs: 1_000, now: () => clock });
    router.restore([{ sessionId: "s", provider: "anthropic", accountId: "intrect", lastSeen: clock }]);
    clock += 5_000;

    // intrect is nearly exhausted; a fresh placement must prefer kyte.
    const got = router.repinOnto(
      "s", anthropicOnly, usable,
      t => (t.accountId === "intrect" ? 0.95 : 0.05),
      usable,
    );

    expect(got?.accountId).toBe("kyte");
  });

  it("refreshes lastSeen when it keeps a pin, so the TTL tracks use", () => {
    let clock = Date.now();
    const router = new SessionRouter({ ttlMs: 1_000, now: () => clock });
    router.restore([{ sessionId: "s", provider: "anthropic", accountId: "intrect", lastSeen: clock }]);

    clock += 900;                                              // still inside the TTL
    router.repinOnto("s", anthropicOnly, usable, undefined, usable);
    clock += 900;                                              // past the original expiry

    // size() sweeps; peek() does not, so asserting on peek alone would pass
    // whether or not lastSeen was refreshed.
    expect(router.size()).toBe(1);
    expect(router.peek("s")?.accountId).toBe("intrect");
  });

  it("does not keep a pin that is not among the offered candidates", () => {
    // The whole point of the call is to leave the OpenAI account.
    const router = new SessionRouter();
    router.restore([{ sessionId: "s", provider: "openai", accountId: "codex", lastSeen: Date.now() }]);

    const moved = router.repinOnto("s", anthropicOnly, usable, undefined, usable);

    expect(moved?.provider).toBe("anthropic");
  });
});
