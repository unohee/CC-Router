import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// The module resolves its path at import time, so each case gets a fresh copy.
// `stamp` is the JSON to write, minus `anchorMtimeMs` — the helper fills that in
// from the anchor it just created, which is what a real build does.
async function loadWith(stamp: Record<string, unknown> | string | null, opts: { stale?: boolean; resize?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "build-info-"));
  mkdirSync(join(dir, "cli"), { recursive: true });
  const anchor = join(dir, "cli", "index.js");
  writeFileSync(anchor, "// compiled\n");

  vi.resetModules();
  vi.doMock("url", async () => {
    const actual = await vi.importActual<typeof import("url")>("url");
    return { ...actual, fileURLToPath: () => join(dir, "utils", "build-info.js") };
  });

  if (typeof stamp === "string") {
    writeFileSync(join(dir, ".build-info.json"), stamp);
  } else if (stamp !== null) {
    writeFileSync(join(dir, ".build-info.json"), JSON.stringify({
      ...stamp, anchor: { mtimeMs: statSync(anchor).mtimeMs, size: statSync(anchor).size },
    }));
    // Stand in for a rebuild that ran without the stamping script: dist/ is
    // newer than the stamp that claims to describe it.
    if (opts.stale) {
      const later = Date.now() / 1000 + 60;
      utimesSync(anchor, later, later);
    }
    // Grow the file but put its mtime back: what an incremental compile can do.
    if (opts.resize) {
      const { atimeMs, mtimeMs } = statSync(anchor);
      writeFileSync(anchor, "// compiled, and then some\n");
      utimesSync(anchor, atimeMs / 1000, mtimeMs / 1000);
    }
  }

  const mod = await import("../utils/build-info.js");
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("readBuildInfo", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.doUnmock("url"));

  it("reports the branch and commit a build came from", async () => {
    const { mod, cleanup } = await loadWith({
      branch: "fix/something", commit: "abc1234", dirty: false, builtAt: "2026-08-21T00:00:00Z",
    });
    try {
      expect(mod.describeBuild()).toBe("fix/something@abc1234");
    } finally { cleanup(); }
  });

  it("marks a build made from a dirty tree", async () => {
    // A clean commit hash implies the code is reachable in git. It is not, if
    // the tree had uncommitted edits when tsc ran.
    const { mod, cleanup } = await loadWith({
      branch: "main", commit: "abc1234", dirty: true, builtAt: "",
    });
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

  it("says nothing when the stamp no longer describes what is in dist/", async () => {
    const { mod, cleanup } = await loadWith(
      { branch: "fix/something", commit: "abc1234", dirty: false, builtAt: "" },
      { stale: true },
    );
    try {
      // Building a revision that predates the stamping script leaves the old
      // stamp in place, naming a branch whose code has just been replaced.
      expect(mod.describeBuild()).toBeNull();
    } finally { cleanup(); }
  });

  it("rejects a stamp whose anchor fingerprint is missing or not numeric", async () => {
    // Two absent values compare equal, so a stamp written when the anchor could
    // not be read would otherwise validate against anything, forever.
    for (const anchor of [null, undefined, {}, { mtimeMs: 1 }, { mtimeMs: "1", size: 2 }]) {
      const { mod, cleanup } = await loadWith(JSON.stringify({
        branch: "main", commit: "abc1234", dirty: false, builtAt: "", anchor,
      }));
      try {
        expect(mod.describeBuild()).toBeNull();
      } finally { cleanup(); }
    }
  });

  it("rejects a stamp whose anchor kept its mtime but changed size", async () => {
    // `tsc --incremental` can leave mtime untouched; size is the second axis.
    const { mod, cleanup } = await loadWith(
      { branch: "main", commit: "abc1234", dirty: false, builtAt: "" },
      { resize: true },
    );
    try {
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
  it("keeps a build that already fits, without adding an ellipsis", async () => {
    const { fitBuild } = await import("../proxy/logger.js");
    const fitted = fitBuild("main@abc1234", 33);
    expect(fitted).toBe("main@abc1234");
    expect(fitted).not.toContain("\u2026");
  });

  it("elides exactly at the boundary rather than one character early", async () => {
    const { fitBuild } = await import("../proxy/logger.js");
    // 12 chars into a width of 12 must survive untouched; 11 must not silently
    // lose a character to an off-by-one.
    expect(fitBuild("main@abc1234", 12)).toBe("main@abc1234");
    expect(fitBuild("main@abc1234", 11)).toHaveLength(11);
    expect(fitBuild("main@abc1234", 11).endsWith("@abc1234")).toBe(true);
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

  it("still fits the width when even the commit is too long to keep", async () => {
    const { fitBuild } = await import("../proxy/logger.js");
    // Asserting the exact plain cut here would be satisfied by a degenerate
    // slice() implementation, which is the regression the suite exists to
    // catch. The property that matters is that the banner box stays intact.
    expect(fitBuild("b@0123456789abcdef", 8)).toHaveLength(8);
  });
});

describe("logStartup", () => {
  const counts = { anthropic: 2, openai: 1 };

  it("names the build in the banner when there is one", async () => {
    vi.resetModules();
    vi.doMock("../utils/build-info.js", () => ({ describeBuild: () => "main@abc1234" }));
    const { logStartup } = await import("../proxy/logger.js");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation(l => { lines.push(String(l)); });
    try {
      logStartup(3456, "127.0.0.1", "proxy", "http://x", counts);
    } finally { spy.mockRestore(); vi.doUnmock("../utils/build-info.js"); }
    expect(lines.join("\n")).toContain("main@abc1234");
  });

  it("omits the line entirely for an install with no build to report", async () => {
    vi.resetModules();
    vi.doMock("../utils/build-info.js", () => ({ describeBuild: () => null }));
    const { logStartup } = await import("../proxy/logger.js");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation(l => { lines.push(String(l)); });
    try {
      logStartup(3456, "127.0.0.1", "proxy", "http://x", counts);
    } finally { spy.mockRestore(); vi.doUnmock("../utils/build-info.js"); }
    // Printing "Build : unknown" on every start of a published install is noise.
    expect(lines.join("\n")).not.toContain("Build");
  });
});
