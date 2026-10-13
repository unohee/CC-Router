import { describe, expect, it } from "vitest";
import { SessionContextTracker } from "../proxy/session-context-tracker.js";

describe("SessionContextTracker", () => {
  it("reports a compaction once the drop persists, with the size it fell from", () => {
    const t = new SessionContextTracker();
    expect(t.observe("s", 400_000)).toBeNull();
    expect(t.observe("s", 900_000)).toBeNull();
    // First small request: candidate only — this could still be a side-call.
    expect(t.observe("s", 120_000)).toBeNull();
    // Second confirms it.
    expect(t.observe("s", 130_000)).toEqual({ fromTokens: 900_000, toTokens: 130_000 });
  });

  it("does not mistake a small side-call on the same session for a compaction", () => {
    // Claude Code issues haiku title generations and sub-agent turns under the
    // same session id. One of those after a 900K turn must not register.
    const t = new SessionContextTracker();
    t.observe("s", 900_000);
    expect(t.observe("s", 5_000)).toBeNull();
    expect(t.observe("s", 910_000)).toBeNull();
    // The candidate was discarded, so a later genuine drop still needs two
    // observations of its own.
    expect(t.observe("s", 100_000)).toBeNull();
    expect(t.observe("s", 100_000)).toEqual({ fromTokens: 910_000, toTokens: 100_000 });
  });

  it("ignores ordinary growth and unmeasured requests", () => {
    const t = new SessionContextTracker();
    expect(t.observe("s", 100_000)).toBeNull();
    expect(t.observe("s", 200_000)).toBeNull();
    expect(t.observe("s", null)).toBeNull();
    expect(t.peakOf("s")).toBe(200_000);
  });

  it("does not fire on a proportional drop that is small in absolute terms", () => {
    // 30K -> 1K is a 97% drop, but there is no compaction worth reporting in a
    // session that never grew.
    const t = new SessionContextTracker();
    t.observe("s", 30_000);
    expect(t.observe("s", 1_000)).toBeNull();
    expect(t.observe("s", 1_000)).toBeNull();
  });

  it("does not fire on a large absolute drop that leaves most of the context", () => {
    const t = new SessionContextTracker();
    t.observe("s", 900_000);
    // 900K -> 700K is 200K, but 78% of the peak remains: that is one big turn
    // falling out of a request, not a compaction.
    expect(t.observe("s", 700_000)).toBeNull();
    expect(t.observe("s", 700_000)).toBeNull();
  });

  it("keeps sessions independent", () => {
    const t = new SessionContextTracker();
    t.observe("a", 900_000);
    t.observe("b", 50_000);
    expect(t.observe("b", 10_000)).toBeNull();
    expect(t.peakOf("a")).toBe(900_000);
  });

  it("tracks the next cycle from the compacted size", () => {
    const t = new SessionContextTracker();
    t.observe("s", 900_000);
    t.observe("s", 120_000);
    t.observe("s", 120_000);
    // Peak resets, so the next compaction is measured from the new growth.
    expect(t.peakOf("s")).toBe(120_000);
    t.observe("s", 800_000);
    expect(t.observe("s", 150_000)).toBeNull();
    expect(t.observe("s", 150_000)).toEqual({ fromTokens: 800_000, toTokens: 150_000 });
  });

  it("evicts the least recently seen session instead of growing without bound", () => {
    let now = 0;
    const t = new SessionContextTracker({ limits: { maxSessions: 3 }, now: () => now });
    t.observe("old", 100_000); now += 1000;
    t.observe("b", 100_000); now += 1000;
    t.observe("c", 100_000); now += 1000;
    t.observe("d", 100_000);       // evicts "old"
    expect(t.peakOf("old")).toBeNull();
    expect(t.peakOf("d")).toBe(100_000);
  });
});
