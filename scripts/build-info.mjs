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
 * Neither mode ever fails the build: this is a hazard worth naming, not one
 * worth blocking a developer over, and it must stay silent where there is no
 * git and no router (CI, a plain npm install).
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import os from "os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INFO_PATH = join(ROOT, "dist", ".build-info.json");
const PID_PATH = join(os.homedir(), ".cc-router", "cc-router.pid");

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** The running router's pid, but only when it is serving from this checkout. */
// Only the background path records a pid (daemon/launcher.js writes it for the
// child it spawns). Someone running `cc-router start --foreground` by hand in a
// terminal is invisible here and gets no warning.
function livePidFromThisCheckout() {
  if (!existsSync(PID_PATH)) return null;
  const pid = Number.parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // `ps -o command=` is the only portable way to see which dist it loaded;
    // a pid alone cannot distinguish this checkout from another install.
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return cmd.includes(join(ROOT, "dist")) ? pid : null;
  } catch {
    return null;                       // not running, or ps unavailable
  }
}

function stamp() {
  const info = {
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    commit: git("rev-parse", "--short", "HEAD"),
    dirty: git("status", "--porcelain") !== "",
    builtAt: new Date().toISOString(),
  };
  if (!info.commit) return;            // not a git checkout — nothing to record
  try {
    writeFileSync(INFO_PATH, JSON.stringify(info, null, 2) + "\n");
  } catch {
    /* a stamp is a convenience; never fail a build over it */
  }
}

function check() {
  const pid = livePidFromThisCheckout();
  if (!pid || !existsSync(INFO_PATH)) return;

  let previous;
  try {
    previous = JSON.parse(readFileSync(INFO_PATH, "utf8"));
  } catch {
    return;
  }

  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (!branch || !previous.branch || branch === previous.branch) return;

  process.stderr.write(
    `\n  A router (pid ${pid}) is serving from this checkout's dist/.\n` +
    `  That build came from "${previous.branch}" (${previous.commit}); you are on "${branch}".\n` +
    `  Continuing replaces what it will load on its next restart.\n\n`,
  );
}

if (process.argv[2] === "check") check();
else stamp();
