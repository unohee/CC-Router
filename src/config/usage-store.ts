/**
 * Reading and writing the usage history file.
 *
 * Kept apart from `manager.ts` and taking the path as a parameter: the path
 * constants live in a module several tests replace wholesale, and a store that
 * reads them at import time would break those tests for no gain.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UsageFile } from "../proxy/usage-history.js";

export type UsageRead =
  | { status: "missing" }
  | { status: "ok"; data: unknown }
  /** The file existed but was not JSON; it was moved aside (movedTo is null if even that failed). */
  | { status: "corrupt"; movedTo: string | null };

/**
 * Move an unusable file out of the way instead of leaving it to be overwritten.
 *
 * Starting empty is right for a file that cannot be read, but the next flush
 * would then replace it, and up to ninety days of history could be gone because
 * of one bad byte. One slot is enough: a second corruption replaces the first
 * copy, which was already unusable.
 */
export function quarantineUsageFile(path: string): string | null {
  const target = `${path}.corrupt`;
  try {
    renameSync(path, target);
    return target;
  } catch {
    return null;
  }
}

export function readUsageFile(path: string): UsageRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // Missing, or unreadable for a reason a rename would not fix either.
    return { status: "missing" };
  }
  try {
    return { status: "ok", data: JSON.parse(raw) };
  } catch {
    return { status: "corrupt", movedTo: quarantineUsageFile(path) };
  }
}

/**
 * Replace the file in one step so a crash mid-write cannot leave half a file.
 * Never throws: history is not worth taking the proxy down for, and the caller
 * decides what a failure means (it keeps the data dirty and tries again).
 */
export function writeUsageFile(path: string, file: UsageFile): { ok: true } | { ok: false; error: string } {
  const data = JSON.stringify(file);
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
    // `mode` above is ignored if a stale tmp file already exists, so set it again.
    chmodSync(tmp, 0o600);
    try {
      renameSync(tmp, path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A file bind-mounted into a container cannot be replaced by rename. Fall
      // back to writing it in place: not atomic, but better than never saving.
      if (code !== "EBUSY" && code !== "EXDEV") throw err;
      writeFileSync(path, data, { encoding: "utf-8", mode: 0o600 });
      chmodSync(path, 0o600);
      try { unlinkSync(tmp); } catch { /* the leftover is harmless */ }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

interface Flushable {
  readonly dirty: boolean;
  toFile(): UsageFile;
  markClean(): void;
}

/**
 * A `flush()` that writes the history only when it has changed.
 *
 * The store is marked clean only after a write succeeded: a failed write must
 * leave it dirty so the next tick tries again, otherwise one bad moment (a full
 * disk, a read-only mount) would silently stop history for good. A failure is
 * reported once, then again only after a success has re-armed it, so a disk that
 * stays broken does not print a line every thirty seconds.
 */
export function createUsageFlusher(
  history: Flushable,
  path: string,
  onWarn: (message: string) => void,
  write: typeof writeUsageFile = writeUsageFile,
): () => void {
  let warned = false;
  return () => {
    if (!history.dirty) return;
    const result = write(path, history.toFile());
    if (result.ok) {
      history.markClean();
      warned = false;
      return;
    }
    if (!warned) {
      warned = true;
      onWarn(`could not save usage history to ${path}: ${result.error}`);
    }
  };
}
