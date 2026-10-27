import type { ChildProcess } from "node:child_process";

/**
 * How long a spawned router may take to print "Listening:".
 *
 * Unloaded it boots in about 0.3 s. Everything above that is headroom for a
 * host busy with parallel test files: boots past 8 s were observed at load
 * average 69, and the eight files that spawn routers had drifted to 5, 8 and
 * 10 s budgets of their own. One number, shared, so they cannot drift again.
 */
export const ROUTER_BOOT_MS = 30_000;

/** Resolves once the router says it is listening; rejects with its output if it exits or the budget runs out. */
export function waitForListening(child: ChildProcess, logs: () => string, budgetMs = ROUTER_BOOT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (logs().includes("Listening:")) { clearInterval(timer); clearTimeout(timeout); resolve(); }
      else if (child.exitCode !== null) { clearInterval(timer); clearTimeout(timeout); reject(new Error(logs())); }
    }, 25);
    const timeout = setTimeout(() => { clearInterval(timer); reject(new Error(logs() || "startup timeout")); }, budgetMs);
  });
}

/**
 * Polls until `check` holds. Use it instead of sleeping a fixed time before
 * asserting on something the router does asynchronously: a fixed sleep is a
 * guess that fails as soon as the host is slower than the guess.
 */
export async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
}
