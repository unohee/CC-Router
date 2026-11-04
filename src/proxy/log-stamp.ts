/**
 * A calendar date on every line the running router prints.
 *
 * The router's output goes to an append-only file (systemd `StandardOutput=
 * append:`) that spans days. Lines used to carry `[HH:MM:SS]` at best, and many
 * (cross-route failures, token refresh errors, warnings) carried no time at all,
 * so nothing in that file could be attributed to a day: "how many 429s last
 * night" had no answer.
 *
 * Rather than every call site formatting its own time, the console methods of
 * the long-running process are wrapped once, and every non-blank output line —
 * including each line of a multi-line message or a stack trace — gets the same
 * UTC stamp. One source means no line can be missed and none is stamped twice.
 */

import { format } from "util";

/** `2026-11-03 12:42:05Z`: sortable, greppable by day, explicit about UTC. */
export function logStamp(d: Date): string {
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}Z`;
}

// Colour codes only: a line of them alone prints as nothing.
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Prefix every visible line of `text` with `[stamp] `. Blank lines (empty, or
 * only whitespace and colour codes) stay as they are, so a banner's spacing is
 * kept and no stamp sits alone on a line.
 */
export function stampLines(text: string, stamp: string): string {
  return text
    .split("\n")
    .map(line => (line.replace(ANSI, "").trim() === "" ? line : `[${stamp}] ${line}`))
    .join("\n");
}

type ConsoleMethod = "log" | "info" | "warn" | "error";
const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error"];

type Stampable = Pick<Console, ConsoleMethod>;

const installed = new WeakSet<object>();

/**
 * Wrap `target`'s log/info/warn/error so each call's output is stamped with
 * `now()`. Installing twice on the same target is a no-op, so a line is never
 * stamped twice. Returns a function that restores the original methods.
 */
export function installLogStamps(target: Stampable = console, now: () => Date = () => new Date()): () => void {
  if (installed.has(target)) return () => {};
  installed.add(target);

  const originals = new Map<ConsoleMethod, Stampable[ConsoleMethod]>();
  for (const m of METHODS) {
    const original = target[m];
    originals.set(m, original);
    target[m] = (...args: unknown[]) => {
      original.call(target, stampLines(format(...args), logStamp(now())));
    };
  }

  return () => {
    for (const [m, original] of originals) target[m] = original;
    installed.delete(target);
  };
}
