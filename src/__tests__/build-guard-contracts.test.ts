import { describe, expect, it, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Three contracts the build guard depends on that no other test pinned, each
 * confirmed to survive a revert of its production change until now.
 */

describe("isManagedProcess", () => {
  afterEach(() => {
    // `process.env.X = undefined` stores the string "undefined", which any
    // child process would then inherit. In a file about these two variables
    // that is a landmine, so unstub rather than reassign.
    vi.unstubAllEnvs();
  });

  it("recognises the service launcher, not just the daemon launcher", async () => {
    const { isManagedProcess } = await import("../proxy/server.js");
    vi.stubEnv("CC_ROUTER_DAEMON", undefined);
    vi.stubEnv("CC_ROUTER_SERVICE", "1");
    // launchd and systemd set this one. Checking only CC_ROUTER_DAEMON left
    // every service-managed router without a pid file — invisible to
    // `cc-router stop` and to the prebuild guard.
    expect(isManagedProcess()).toBe(true);
  });

  it("still recognises the daemon launcher", async () => {
    const { isManagedProcess } = await import("../proxy/server.js");
    vi.stubEnv("CC_ROUTER_DAEMON", "1");
    vi.stubEnv("CC_ROUTER_SERVICE", undefined);
    expect(isManagedProcess()).toBe(true);
  });

  it("does not claim a plain foreground run", async () => {
    const { isManagedProcess } = await import("../proxy/server.js");
    vi.stubEnv("CC_ROUTER_DAEMON", undefined);
    vi.stubEnv("CC_ROUTER_SERVICE", undefined);
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
      anchorMtimeMs: statSync(anchor).mtimeMs,
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
      vi.resetModules();   // else the mocked instance outlives this test
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("packaging", () => {
  const root = join(__dirname, "..", "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  it("ships the script its own build hooks invoke", () => {
    // Asserting on package.json alone would just restate the config next to
    // itself. Ask npm what it would actually put in the tarball.
    const packed = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
    const files: string[] = JSON.parse(packed)[0].files.map((f: { path: string }) => f.path);
    expect(pkg.scripts.prebuild).toContain("scripts/build-info.mjs");
    // Without it, `npm run build` in a published install aborts with
    // MODULE_NOT_FOUND before tsc starts.
    expect(files).toContain("scripts/build-info.mjs");
  }, 60_000);

  it("does not publish a stamp naming the maintainer's branch", () => {
    const packed = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
    const files: string[] = JSON.parse(packed)[0].files.map((f: { path: string }) => f.path);
    expect(pkg.files).toContain("dist/");            // which would otherwise carry it
    expect(files).not.toContain("dist/.build-info.json");
  }, 60_000);

  it("copies the script into the builder stage before it builds", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    const marker = dockerfile.indexOf("AS runtime");
    // A renamed stage would make indexOf return -1, and slice(0, -1) is almost
    // the whole file — the assertion would silently weaken to "appears
    // somewhere". Fail loudly instead.
    expect(marker).toBeGreaterThan(0);
    const builder = dockerfile.slice(0, marker);
    const copy = builder.search(/^COPY\s+scripts\//m);
    const build = builder.search(/^RUN\s+npm run build/m);
    expect(copy).toBeGreaterThan(-1);
    // Ordering is the whole point: a COPY after the RUN reproduces the bug.
    expect(copy).toBeLessThan(build);
  });
});
