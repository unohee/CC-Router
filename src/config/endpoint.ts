import { readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { ENDPOINT_PATH } from "./paths.js";

/** Where a running router listens, as recorded by the server itself. */
export interface RouterEndpoint {
  host: string;
  port: number;
  pid: number;
}

/** True when a process with this pid exists (EPERM: it exists but is someone else's). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Record the listening address; atomic, owner-only. Failure is not fatal to the server. */
export function writeEndpoint(endpoint: RouterEndpoint, file: string = ENDPOINT_PATH): void {
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(endpoint), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    console.warn(`Warning: cannot write ${file}: ${(err as Error).message}`);
  }
}

export function removeEndpoint(file: string = ENDPOINT_PATH): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/** The recorded endpoint, only while the process that wrote it is alive. */
export function readLiveEndpoint(file: string = ENDPOINT_PATH): RouterEndpoint | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<RouterEndpoint>;
    if (typeof raw.host !== "string" || typeof raw.port !== "number" || typeof raw.pid !== "number") return null;
    if (!Number.isInteger(raw.port) || raw.port <= 0 || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    return pidAlive(raw.pid) ? { host: raw.host, port: raw.port, pid: raw.pid } : null;
  } catch {
    return null;
  }
}

/** A bind-all address is reached through loopback; any other bind address is reached as is. */
export function connectHost(bindHost: string): string {
  return bindHost === "0.0.0.0" || bindHost === "::" || bindHost === "" ? "127.0.0.1" : bindHost;
}
