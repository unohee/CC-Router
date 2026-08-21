import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// The module resolves its path at import time, so each case gets a fresh copy.
async function loadWith(contents: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "build-info-"));
  vi.resetModules();
  vi.doMock("url", async () => {
    const actual = await vi.importActual<typeof import("url")>("url");
    return { ...actual, fileURLToPath: () => join(dir, "utils", "build-info.js") };
  });
  if (contents !== null) writeFileSync(join(dir, ".build-info.json"), contents);
  const mod = await import("../utils/build-info.js");
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("readBuildInfo", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.doUnmock("url"));

  it("reports the branch and commit a build came from", async () => {
    const { mod, cleanup } = await loadWith(JSON.stringify({
      branch: "fix/something", commit: "abc1234", dirty: false, builtAt: "2026-08-21T00:00:00Z",
    }));
    try {
      expect(mod.describeBuild()).toBe("fix/something@abc1234");
    } finally { cleanup(); }
  });

  it("marks a build made from a dirty tree", async () => {
    // A clean commit hash implies the code is reachable in git. It is not, if
    // the tree had uncommitted edits when tsc ran.
    const { mod, cleanup } = await loadWith(JSON.stringify({
      branch: "main", commit: "abc1234", dirty: true, builtAt: "",
    }));
    try {
      expect(mod.describeBuild()).toBe("main@abc1234+dirty");
    } finally { cleanup(); }
  });

  it("says nothing for a published install that was never built in place", async () => {
    const { mod, cleanup } = await loadWith(null);
    try {
      expect(mod.readBuildInfo()).toBeNull();
      expect(mod.describeBuild()).toBeNull();
    } finally { cleanup(); }
  });

  it("says nothing rather than throwing on a corrupt or partial stamp", async () => {
    for (const contents of ["not json at all", JSON.stringify({ branch: "main" })]) {
      const { mod, cleanup } = await loadWith(contents);
      try {
        expect(mod.describeBuild()).toBeNull();
      } finally { cleanup(); }
    }
  });
});

describe("fitBuild", () => {
  it("keeps a build that already fits", async () => {
    const { fitBuild } = await import("../proxy/logger.js");
    expect(fitBuild("main@abc1234", 33)).toBe("main@abc1234");
  });

  it("elides the branch rather than the commit it identifies", async () => {
    const { fitBuild } = await import("../proxy/logger.js");
    const fitted = fitBuild("fix/agt-3912-live-build-guard@0fd04fb+dirty", 33);
    expect(fitted).toHaveLength(33);
    // The tail is what you read when a build surprises you. Losing it to a
    // plain slice() is the regression this guards.
    expect(fitted.endsWith("@0fd04fb+dirty")).toBe(true);
    expect(fitted.startsWith("fix/agt")).toBe(true);
  });

  it("falls back to a plain cut when even the commit will not fit", async () => {
    const { fitBuild } = await import("../proxy/logger.js");
    expect(fitBuild("b@0123456789abcdef", 8)).toBe("b@012345");
  });
});
