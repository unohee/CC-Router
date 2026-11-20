#!/usr/bin/env node
// Writes dist/build-info.json after `tsc`: the commit the build came from, whether
// tracked files differed from it, when, and the package version. The router
// reports it in /cc-router/health as `build` (src/proxy/build-info.ts). Also
// copies the data files the router reads at runtime into dist/.
//
// CC_ROUTER_BUILD_SHA overrides the sha, for builds made outside a git checkout.
// CC_ROUTER_BUILD_OUT_DIR writes into that directory instead of dist/: the tests
// use it so parallel test files do not race on one dist/build-info.json.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const sha = process.env.CC_ROUTER_BUILD_SHA || git(["rev-parse", "HEAD"]);
const status = git(["status", "--porcelain", "--untracked-files=no"]);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const info = {
  sha: sha && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null,
  dirty: Boolean(status),
  builtAt: new Date().toISOString(),
  version: typeof pkg.version === "string" ? pkg.version : null,
};

const outDir = process.env.CC_ROUTER_BUILD_OUT_DIR || join(root, "dist");
const out = join(outDir, "build-info.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(info, null, 2) + "\n");
console.log(`build-info: ${info.sha ?? "unknown"}${info.dirty ? " (dirty)" : ""}`);

// Data the running router reads beside its code: the Claude Code versions the
// real-client conformance suite passed for (src/proxy/continuity-ledger.ts).
const verifiedSrc = join(root, "src", "continuity", "verified-clients.json");
const verifiedOut = join(outDir, "continuity", "verified-clients.json");
mkdirSync(dirname(verifiedOut), { recursive: true });
copyFileSync(verifiedSrc, verifiedOut);
