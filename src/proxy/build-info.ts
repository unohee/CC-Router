/**
 * Which build is running.
 *
 * `npm run build` writes `dist/build-info.json` (scripts/write-build-info.mjs)
 * next to the compiled sources. Health reports it as `build`, so a deploy can
 * wait until the router answering is the one it just shipped, and a smoke check
 * can tell a stale process from a fresh one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  /** Full commit sha the build was made from, or null when unknown (run from source). */
  sha: string | null;
  /** True when tracked files differed from the commit at build time. */
  dirty: boolean;
  /** ISO time the build was made, or null. */
  builtAt: string | null;
  /** package.json version, or null. */
  version: string | null;
}

export const UNKNOWN_BUILD: BuildInfo = { sha: null, dirty: false, builtAt: null, version: null };

/**
 * Where build-info.json is expected: one level above this module, i.e.
 * `dist/build-info.json` for `dist/proxy/build-info.js`. Tests and unusual
 * layouts can point elsewhere with CC_ROUTER_BUILD_INFO.
 */
export function buildInfoPath(): string {
  const override = process.env["CC_ROUTER_BUILD_INFO"];
  if (override) return override;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "build-info.json");
}

/** Parses a build-info document; anything malformed yields the unknown build. */
export function parseBuildInfo(raw: unknown): BuildInfo {
  if (!raw || typeof raw !== "object") return { ...UNKNOWN_BUILD };
  const r = raw as Record<string, unknown>;
  const sha = typeof r["sha"] === "string" && /^[0-9a-f]{7,64}$/.test(r["sha"]) ? r["sha"] : null;
  return {
    sha,
    dirty: r["dirty"] === true,
    builtAt: typeof r["builtAt"] === "string" ? r["builtAt"] : null,
    version: typeof r["version"] === "string" ? r["version"] : null,
  };
}

/** Reads build info once; a missing or unreadable file is the unknown build, never an error. */
export function readBuildInfo(path: string = buildInfoPath()): BuildInfo {
  try {
    return parseBuildInfo(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...UNKNOWN_BUILD };
  }
}
