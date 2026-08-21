import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * `scripts/build-info.mjs` runs on every build and shells out to git and ps.
 * Its two promises — never fail a build, stay silent where there is nothing to
 * say — are only checkable by running it, so these tests do.
 *
 * POSIX only, and skipped rather than adapted on Windows. The fixtures need
 * `ps -p N -o command=` (no equivalent on Windows) and drive the script's
 * `os.homedir()` through HOME, which Windows ignores in favour of USERPROFILE —
 * the silence assertions would still pass there, but against the runner's real
 * profile instead of the fixture, which is worse than not running them.
 */
const posixOnly = process.platform === "win32" ? describe.skip : describe;
const SCRIPT_SRC = join(__dirname, "..", "..", "scripts", "build-info.mjs");

let root: string;
let home: string;

/** A throwaway checkout with the script installed where it expects to live. */
function makeRoot(opts: { git?: boolean } = { git: true }): string {
  // realpath, not the raw temp path: node resolves a module's own URL, so the
  // script sees /private/var/... while `ps` would report /var/... for anything
  // spawned with the unresolved path, and the substring test would miss.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bi-root-")));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "dist", "cli"), { recursive: true });
  cpSync(SCRIPT_SRC, join(dir, "scripts", "build-info.mjs"));
  writeFileSync(join(dir, "dist", "cli", "index.js"), "// compiled\n");
  if (opts.git !== false) {
    const g = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    writeFileSync(join(dir, "f.txt"), "x");
    g("add", "-A");
    g("commit", "-qm", "init");
  }
  return dir;
}

// spawnSync, not execFileSync: the warning is written to stderr and exits 0,
// and execFileSync only surfaces stderr when the child fails. Every assertion
// about silence would have passed vacuously.
function run(dir: string, ...args: string[]): { out: string; err: string; code: number } {
  const r = spawnSync("node", [join(dir, "scripts", "build-info.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status ?? 1 };
}

/** Claim a live router serving from `dir` by pointing the pid file at us. */
function pretendRouterIsRunning(dir: string): void {
  mkdirSync(join(home, ".cc-router"), { recursive: true });
  // This test process's own command line does not contain `<dir>/dist`, so the
  // script would reject it. Spawn a sleeper whose argv does contain it.
  const pid = spawnSleeper(dir);
  writeFileSync(join(home, ".cc-router", "cc-router.pid"), String(pid));
  // spawn() hands back a pid before the child has exec'd, and until it does
  // `ps` reports the shell/loader, not our argv. Wait for what the script reads.
  const deadline = Date.now() + 5000;
  for (;;) {
    let cmd = "";
    try {
      cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    } catch { /* not visible yet */ }
    if (cmd.includes(join(dir, "dist"))) return;
    if (Date.now() > deadline) throw new Error(`sleeper never showed up in ps: ${cmd}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

const sleepers: number[] = [];
function spawnSleeper(dir: string): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawn } = require("child_process") as typeof import("child_process");
  const child = spawn("node", ["-e", "setTimeout(()=>{},60000)", join(dir, "dist", "cli", "index.js")], {
    stdio: "ignore",
  });
  sleepers.push(child.pid!);
  return child.pid!;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "bi-home-")));
  root = makeRoot();
});

afterEach(() => {
  for (const pid of sleepers.splice(0)) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

posixOnly("build-info.mjs — stamping", () => {
  it("records the branch, commit and the anchor it belongs to", () => {
    expect(run(root).code).toBe(0);
    const info = JSON.parse(readFileSync(join(root, "dist", ".build-info.json"), "utf8"));
    expect(info.branch).toBe("main");
    expect(info.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(typeof info.anchor.mtimeMs).toBe("number");
    expect(typeof info.anchor.size).toBe("number");
  });

  it("names a detached HEAD by its commit, not the word HEAD", () => {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
    run(root);
    const info = JSON.parse(readFileSync(join(root, "dist", ".build-info.json"), "utf8"));
    // "HEAD" compares equal between two unrelated detached builds and tells a
    // reader nothing, so the check would never fire.
    expect(info.branch).toBe(`detached@${sha}`);
  });

  it("writes nothing and says nothing outside a git checkout", () => {
    const plain = makeRoot({ git: false });
    try {
      const r = run(plain);
      expect(r.code).toBe(0);
      // git prints its own complaint on stderr; leaking it reads as a build failure.
      expect(r.err).toBe("");
      expect(() => readFileSync(join(plain, "dist", ".build-info.json"))).toThrow();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

posixOnly("build-info.mjs — the warning", () => {
  it("says nothing when no router is running", () => {
    run(root);
    const r = run(root, "check");
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  it("warns when a live router's build came from another branch", () => {
    run(root);
    pretendRouterIsRunning(root);
    execFileSync("git", ["checkout", "-qb", "other"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
    const r = run(root, "check");
    expect(r.code).toBe(0);
    expect(r.err).toContain('came from "main"');
    expect(r.err).toContain('you are on "other"');
  });

  it("warns when the branch is unchanged but the commit moved", () => {
    run(root);
    pretendRouterIsRunning(root);
    writeFileSync(join(root, "f.txt"), "y");
    execFileSync("git", ["commit", "-qam", "move"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
    // A fast-forward on the branch you are already on replaces the live build
    // just as thoroughly, and is the easiest one to miss.
    expect(run(root, "check").err).toContain("Continuing replaces");
  });

  it("says nothing when rebuilding the very same commit", () => {
    run(root);
    pretendRouterIsRunning(root);
    expect(run(root, "check").err).toBe("");
  });

  it("does not vouch for a stamp that no longer describes dist/", () => {
    run(root);
    pretendRouterIsRunning(root);
    // Stand in for a build that ran without this script: dist/ is recompiled,
    // the stamp is left behind still naming the previous branch.
    const later = Date.now() / 1000 + 60;
    utimesSync(join(root, "dist", "cli", "index.js"), later, later);
    const r = run(root, "check");
    expect(r.err).toContain("cannot be identified");
    expect(r.err).not.toContain('came from "main"');
  });

  it("stays silent, and exits zero, when the pid file cannot be read", () => {
    run(root);
    mkdirSync(join(home, ".cc-router", "cc-router.pid"), { recursive: true });  // a directory, not a file
    const r = run(root, "check");
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  it("stays silent for a pid that is not running", () => {
    run(root);
    mkdirSync(join(home, ".cc-router"), { recursive: true });
    writeFileSync(join(home, ".cc-router", "cc-router.pid"), "2147483646");
    const r = run(root, "check");
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });
});
