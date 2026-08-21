import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export interface BuildInfo {
  branch: string;
  commit: string;
  dirty: boolean;
  builtAt: string;
}

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..");
const INFO_PATH = join(DIST, ".build-info.json");
/** Must match `scripts/build-info.mjs` — see the note on staleness there. */
const ANCHOR_PATH = join(DIST, "cli", "index.js");

function anchorMtimeMs(): number | null {
  try {
    return statSync(ANCHOR_PATH).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * What this `dist/` was built from, when `npm run build` recorded it.
 *
 * Worth surfacing because the proxy is usually `npm link`ed: `dist/` is shared
 * with a working tree, so a build on another branch quietly becomes what the
 * next restart serves. Without this the only way to find out was to compare
 * `git reflog` against the process start time.
 *
 * Null when there is nothing trustworthy to say — no stamp, or a stamp that no
 * longer describes what is in `dist/`. The second case is not hypothetical:
 * building a revision that predates this script leaves the previous stamp in
 * place, still naming a branch whose code has just been replaced. Silence beats
 * a confident wrong answer, so the stamp records the mtime of a file every
 * build re-emits and is discarded when they disagree.
 */
export function readBuildInfo(): BuildInfo | null {
  if (!existsSync(INFO_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(INFO_PATH, "utf8")) as
      Partial<BuildInfo> & { anchorMtimeMs?: unknown };
    if (typeof parsed.branch !== "string" || typeof parsed.commit !== "string") return null;
    if (parsed.anchorMtimeMs !== anchorMtimeMs()) return null;
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

/**
 * Read once, at load.
 *
 * The point of this value is to say what the *running process* loaded. Reading
 * the file per request would make a long-lived router start reporting a branch
 * it is not executing the moment someone rebuilds — the same lie the staleness
 * check exists to prevent, arriving by a different route.
 */
const LOADED = readBuildInfo();

/** One-line form for logs and the dashboard, or null when there is nothing to say. */
export function describeBuild(info: BuildInfo | null = LOADED): string | null {
  if (!info) return null;
  return `${info.branch}@${info.commit}${info.dirty ? "+dirty" : ""}`;
}
