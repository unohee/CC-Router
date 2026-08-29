import { describe, expect, it, vi } from "vitest";
import { SessionRouter } from "../proxy/session-router.js";

const A = "a";
const B = "b";
const C = "c";
const ALL = [A, B, C];
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

    expect(new Set(assigned).size).toBe(3);
  });

  it("reassigns when the pinned account can no longer serve", () => {
    const onReassign = vi.fn();
    const router = new SessionRouter({ onReassign });
    const first = router.resolve("s1", ALL, always)!;

    // The pinned account goes rate-limited; everything else is fine.
    const moved = router.resolve("s1", ALL, t => t !== first)!;

    expect(moved).not.toBe(first);
    expect(onReassign).toHaveBeenCalledWith({ sessionId: "s1", from: first, to: moved });
    // The move sticks — the session does not bounce back on the next request.
    expect(router.resolve("s1", ALL, always)).toEqual(moved);
  });

  it("never pins a session to an account that is already unusable", () => {
    const router = new SessionRouter();
    const target = router.resolve("s1", ALL, id => id === "b")!;

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

  it("uses every account the caller offers", () => {
    const router = new SessionRouter();
    const chosen = ["s1", "s2", "s3"].map(id => router.resolve(id, ALL, always)!);

    expect(new Set(chosen)).toEqual(new Set(ALL));
  });

  it("never picks an account outside the offered set", () => {
    const router = new SessionRouter();
    const chosen = ["s1", "s2", "s3", "s4"].map(id => router.resolve(id, [A, B], always)!);

    expect(chosen.every(id => id === A || id === B)).toBe(true);
  });

  it("gives a new session to the target holding the fewest sessions", () => {
    const router = new SessionRouter();
    // Three sessions land one per target, then the next three must repeat that
    // spread rather than stacking onto whichever comes next in rotation.
    for (const id of ["s1", "s2", "s3"]) router.resolve(id, ALL, always);

    const counts = new Map<string, number>();
    for (const id of ["s4", "s5", "s6"]) {
      const t = router.resolve(id, ALL, always)!;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    expect([...counts.values()].sort()).toEqual([1, 1, 1]);
  });

  it("does not stack new sessions onto a target that already holds several", () => {
    const router = new SessionRouter();
    // Only A is usable at first, so three sessions pile onto it.
    for (const id of ["s1", "s2", "s3"]) router.resolve(id, ALL, id => id === "a");

    // Once B and OpenAI become usable, the next sessions must go to them.
    const next = ["s4", "s5"].map(id => router.resolve(id, ALL, always)!);

    expect(next.every(id => id !== "a")).toBe(true);
    expect(new Set(next).size).toBe(2);
  });

  it("still rotates between equally loaded targets", () => {
    const router = new SessionRouter();
    const seen = ["s1", "s2", "s3"].map(id => router.resolve(id, ALL, always)!);

    expect(new Set(seen).size).toBe(3);
  });

  it("prefers the target with more quota left when load is equal", () => {
    const router = new SessionRouter();
    // A is nearly exhausted, B has headroom, OpenAI is untouched.
    const util = (id: string) => ({ a: 0.85, b: 0.4, c: 0.02 }[id] ?? 0);

    expect(router.resolve("s1", ALL, always, util)!).toBe("c");
    expect(router.resolve("s2", ALL, always, util)!).toBe("b");
    // Only now, with the roomier two each holding a session, does A get one.
    expect(router.resolve("s3", ALL, always, util)!).toBe("a");
  });

  it("keeps rotating when tied targets have identical quota", () => {
    const router = new SessionRouter();
    const seen = ["s1", "s2", "s3"].map(id => router.resolve(id, ALL, always, () => 0.5)!);

    expect(new Set(seen).size).toBe(3);
  });

  it("treats an unmeasured target as empty so it can produce a reading", () => {
    const router = new SessionRouter();
    // B has never served a request, so its quota is unknown (0) and it wins
    // over an account known to be half spent.
    const util = (id: string) => (id === "a" ? 0.5 : 0);

    expect(router.resolve("s1", [A, B], always, util)!).toBe("b");
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
    source.resolve("s1", ["removed"], always);

    const restored = new SessionRouter();
    restored.restore(source.snapshot());
    const target = restored.resolve("s1", ALL, id => id !== "removed")!;

    expect(target).not.toBe("removed");
  });

  it("ignores malformed snapshot entries instead of failing to start", () => {
    const router = new SessionRouter();
    router.restore([
      { sessionId: "", accountId: "a", lastSeen: Date.now() },
      { sessionId: "no-account", accountId: "", lastSeen: Date.now() },
      { sessionId: "no-time", accountId: "a" },
      { sessionId: "good", accountId: "a", lastSeen: Date.now() },
    ] as Parameters<typeof router.restore>[0]);

    expect(router.peek("good")).toEqual(A);
    expect(router.peek("no-account")).toBeNull();
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
    const kept = router.resolve("s1", ALL, t => t !== pinned, undefined,
      () => true)!;

    expect(kept).toEqual(pinned);
  });

  it("still moves a session when retention itself says no", () => {
    const router = new SessionRouter();
    const pinned = router.resolve("s1", ALL, always)!;

    const moved = router.resolve("s1", ALL, t => t !== pinned, undefined,
      () => false)!;

    expect(moved).not.toBe(pinned);
  });
});
