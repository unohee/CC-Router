import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Three contracts the build guard depends on that no other test pinned, each
 * confirmed to survive a revert of its production change until now.
 */

describe("isManagedProcess", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env["CC_ROUTER_DAEMON"] = saved["CC_ROUTER_DAEMON"];
    process.env["CC_ROUTER_SERVICE"] = saved["CC_ROUTER_SERVICE"];
  });

  it("recognises the service launcher, not just the daemon launcher", async () => {
    const { isManagedProcess } = await import("../proxy/server.js");
    delete process.env["CC_ROUTER_DAEMON"];
    process.env["CC_ROUTER_SERVICE"] = "1";
    // launchd and systemd set this one. Checking only CC_ROUTER_DAEMON left
    // every service-managed router without a pid file — invisible to
    // `cc-router stop` and to the prebuild guard.
    expect(isManagedProcess()).toBe(true);
  });

  it("still recognises the daemon launcher", async () => {
    const { isManagedProcess } = await import("../proxy/server.js");
    process.env["CC_ROUTER_DAEMON"] = "1";
    delete process.env["CC_ROUTER_SERVICE"];
    expect(isManagedProcess()).toBe(true);
  });

  it("does not claim a plain foreground run", async () => {
    const { isManagedProcess } = await import("../proxy/server.js");
    delete process.env["CC_ROUTER_DAEMON"];
    delete process.env["CC_ROUTER_SERVICE"];
    expect(isManagedProcess()).toBe(false);
  });
});

describe("describeBuild is a snapshot of what this process loaded", () => {
  it("does not follow the stamp when someone rebuilds underneath it", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "build-snap-")));
    mkdirSync(join(dir, "cli"), { recursive: true });
    const anchor = join(dir, "cli", "index.js");
    writeFileSync(anchor, "// compiled\n");
    const write = (branch: string) => writeFileSync(join(dir, ".build-info.json"), JSON.stringify({
      branch, commit: "abc1234", dirty: false, builtAt: "",
      anchor: { mtimeMs: statSync(anchor).mtimeMs, size: statSync(anchor).size },
    }));

    vi.resetModules();
    vi.doMock("url", async () => {
      const actual = await vi.importActual<typeof import("url")>("url");
      return { ...actual, fileURLToPath: () => join(dir, "utils", "build-info.js") };
    });
    write("at-load");

    try {
      const { describeBuild } = await import("../utils/build-info.js");
      expect(describeBuild()).toBe("at-load@abc1234");
      // A long-lived router keeps executing what it loaded. Re-reading per call
      // would make it start announcing a branch it is not running.
      write("rebuilt-since");
      expect(describeBuild()).toBe("at-load@abc1234");
    } finally {
      vi.doUnmock("url");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("packaging", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));

  it("ships the script its own build hooks invoke", () => {
    // prebuild/postbuild travel in the published package.json; without the
    // script they abort `npm run build` with MODULE_NOT_FOUND.
    expect(pkg.scripts.prebuild).toContain("scripts/build-info.mjs");
    expect(pkg.files).toContain("scripts/");
  });

  it("does not publish a stamp naming the maintainer's branch", () => {
    expect(pkg.files).toContain("dist/");           // which would otherwise carry it
    expect(pkg.scripts.prepack).toContain(".build-info.json");
    // …and restores it, so packing from a checkout that is also serving does
    // not silently blind the guard it just used.
    expect(pkg.scripts.postpack).toContain("scripts/build-info.mjs");
  });

  it("copies the script into the Docker builder stage", () => {
    const dockerfile = readFileSync(join(__dirname, "..", "..", "Dockerfile"), "utf8");
    const builder = dockerfile.slice(0, dockerfile.indexOf("AS runtime"));
    expect(builder).toMatch(/COPY\s+scripts\//);
  });
});
