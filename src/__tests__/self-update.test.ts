import { describe, expect, it } from "vitest";
import { semverDiff } from "../utils/self-update.js";

describe("semverDiff", () => {
  it("reports how far ahead the registry is", () => {
    expect(semverDiff("0.6.2", "1.0.0")).toBe("major");
    expect(semverDiff("0.6.2", "0.7.0")).toBe("minor");
    expect(semverDiff("0.6.2", "0.6.3")).toBe("patch");
    expect(semverDiff("0.6.2", "0.6.2")).toBeNull();
  });

  it("never reads an older registry version as an update", () => {
    // The exact case that downgraded a local 0.7.0 dev build to the published
    // 0.6.2: per-digit fall-through saw 2 > 0 in the patch slot.
    expect(semverDiff("0.7.0", "0.6.2")).toBeNull();
    expect(semverDiff("1.0.0", "0.9.9")).toBeNull();
    expect(semverDiff("0.6.3", "0.6.2")).toBeNull();
  });

  it("a higher major wins even when lower positions are behind", () => {
    expect(semverDiff("0.9.9", "1.0.0")).toBe("major");
    expect(semverDiff("0.6.9", "0.7.0")).toBe("minor");
  });
});
