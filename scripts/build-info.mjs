#!/usr/bin/env node
/**
 * Records what `dist/` was built from, and warns before overwriting a build a
 * running router may reload.
 *
 * The proxy is normally installed with `npm link`, so `dist/` is shared between
 * "the branch I have checked out" and "what serves traffic". Building on a
 * feature branch silently replaces the live artifact; the next restart — a
 * crash, a service manager, a laptop waking up — comes back on that branch's
 * code. Nothing announces it. Recovering the fact afterwards meant reading
 * `git reflog` against process start times.
 *
 * Two rules this file must not break, because it runs on every build:
 *
 *  - It never fails the build. This is a hazard worth naming, not one worth
 *    blocking a developer over. Every entry point is wrapped.
 *  - It stays silent where there is no git and no router (CI, a plain npm
 *    install). That includes subprocess stderr — `git` in a non-repo prints its
 *    own complaint, which reads as a build failure even at exit 0.
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import os from "os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INFO_PATH = join(ROOT, "dist", ".build-info.json");
const PID_PATH = join(os.homedir(), ".cc-router", "cc-router.pid");

/**
 * The file whose mtime says when `dist/` was last compiled.
 *
 * `tsc` does not delete stale outputs, so a file that only exists on one branch
 * survives a rebuild of another and keeps its old mtime. The anchor has to be
 * something every build re-emits — the CLI entry point is emitted from `main`
 * onward and is what the launcher runs.
 */
const ANCHOR_PATH = join(ROOT, "dist", "cli", "index.js");

/** stdout only. A silent failure is the contract; the child's stderr is not. */
function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

const git = (...args) => run("git", args, { cwd: ROOT });

function anchorMtimeMs() {
  try {
    return statSync(ANCHOR_PATH).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * A branch name that identifies something.
 *
 * On a detached HEAD `--abbrev-ref` answers the literal string "HEAD", which
 * compares equal to every other detached build and tells a reader nothing.
 */
function branchLabel() {
  const name = git("rev-parse", "--abbrev-ref", "HEAD");
  if (!name || name !== "HEAD") return name;
  const sha = git("rev-parse", "--short", "HEAD");
  return sha ? `detached@${sha}` : null;
}

/**
 * The stamp, or null when it does not describe the code sitting in `dist/`.
 *
 * A stamp goes stale whenever a build runs without this script — checking out a
 * branch that predates it, or any older revision. The recorded anchor mtime
 * then no longer matches the compiled output, and the stamp is describing a
 * build that has been replaced. A stamp that lies is worse than no stamp, so
 * mismatch means null, not "probably fine".
 */
function readStamp() {
  try {
    if (!existsSync(INFO_PATH)) return null;
    const parsed = JSON.parse(readFileSync(INFO_PATH, "utf8"));
    if (typeof parsed?.branch !== "string" || typeof parsed?.commit !== "string") return null;
    if (parsed.anchorMtimeMs !== anchorMtimeMs()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The running router's pid, but only when it is serving from this checkout.
 *
 * Only a managed process records one (see `isManagedProcess` in the server).
 * A router someone started by hand with `--foreground` in a terminal is
 * invisible here and gets no warning.
 */
function livePidFromThisCheckout() {
  try {
    if (!existsSync(PID_PATH)) return null;
    const pid = Number.parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    // `ps -o command=` is the only portable way to see which dist it loaded;
    // a pid alone cannot distinguish this checkout from another install.
    const cmd = run("ps", ["-p", String(pid), "-o", "command="]);
    return cmd?.includes(join(ROOT, "dist")) ? pid : null;
  } catch {
    return null;
  }
}

function stamp() {
  const commit = git("rev-parse", "--short", "HEAD");
  if (!commit) return;                 // not a git checkout — nothing to record
  const info = {
    branch: branchLabel(),
    commit,
    dirty: git("status", "--porcelain") !== "",
    builtAt: new Date().toISOString(),
    // Written last so it reflects the compile this stamp belongs to.
    anchorMtimeMs: anchorMtimeMs(),
  };
  try {
    writeFileSync(INFO_PATH, JSON.stringify(info, null, 2) + "\n");
  } catch {
    /* a stamp is a convenience; never fail a build over it */
  }
}

function check() {
  const pid = livePidFromThisCheckout();
  if (!pid) return;

  const previous = readStamp();
  const branch = branchLabel();
  const commit = git("rev-parse", "--short", "HEAD");

  // Same branch AND same commit is a plain rebuild of what is already running.
  // Anything else replaces it with different code — including a fast-forward on
  // the branch you are already on, which is the easiest one to not notice.
  if (previous && previous.branch === branch && previous.commit === commit) return;

  const from = previous
    ? `came from "${previous.branch}" (${previous.commit})`
    : "cannot be identified";
  const to = branch ? `you are on "${branch}" (${commit})` : "this tree is not a git checkout";

  process.stderr.write(
    `\n  A router (pid ${pid}) is serving from this checkout's dist/.\n` +
    `  That build ${from}; ${to}.\n` +
    `  Continuing replaces what it will load on its next restart.\n\n`,
  );
}

try {
  if (process.argv[2] === "check") check();
  else stamp();
} catch {
  /* Nothing this script can discover is worth breaking a build over. */
}
