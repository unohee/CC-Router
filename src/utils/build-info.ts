import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export interface BuildInfo {
  branch: string;
  commit: string;
  dirty: boolean;
  builtAt: string;
}

const INFO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".build-info.json");

/**
 * What this `dist/` was built from, when `npm run build` recorded it.
 *
 * Worth surfacing because the proxy is usually `npm link`ed: `dist/` is shared
 * with a working tree, so a build on another branch quietly becomes what the
 * next restart serves. Without this the only way to find out was to compare
 * `git reflog` against the process start time.
 *
 * Null for an install that was published rather than built in place.
 */
export function readBuildInfo(): BuildInfo | null {
  if (!existsSync(INFO_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(INFO_PATH, "utf8")) as Partial<BuildInfo>;
    if (typeof parsed.branch !== "string" || typeof parsed.commit !== "string") return null;
    return {
      branch: parsed.branch,
      commit: parsed.commit,
      dirty: parsed.dirty === true,
      builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : "",
    };
  } catch {
    return null;
  }
}

/** One-line form for logs and the dashboard, or null when there is nothing to say. */
export function describeBuild(info: BuildInfo | null = readBuildInfo()): string | null {
  if (!info) return null;
  return `${info.branch}@${info.commit}${info.dirty ? "+dirty" : ""}`;
}
