import { describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { installLogStamps, logStamp, stampLines } from "../proxy/log-stamp.js";
import { log429Diagnostic, logRoute, logThrottleWait } from "../proxy/logger.js";

const AT = new Date("2026-11-03T12:42:05.789Z");
const STAMP = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z\] /;

/** A console stand-in that records what reached the underlying methods. */
function fakeConsole() {
  const out: { method: string; text: string }[] = [];
  const target = {
    log: (...a: unknown[]) => { out.push({ method: "log", text: a.join(" ") }); },
    info: (...a: unknown[]) => { out.push({ method: "info", text: a.join(" ") }); },
    warn: (...a: unknown[]) => { out.push({ method: "warn", text: a.join(" ") }); },
    error: (...a: unknown[]) => { out.push({ method: "error", text: a.join(" ") }); },
  };
  return { target, out };
}

describe("logStamp", () => {
  it("is the UTC calendar date and time, marked as UTC", () => {
    expect(logStamp(AT)).toBe("2026-11-03 12:42:05Z");
  });

  it("uses UTC across a local midnight", () => {
    expect(logStamp(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12-31 23:59:59Z");
    expect(logStamp(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027-01-01 00:00:00Z");
  });
});

describe("stampLines", () => {
  it("stamps every visible line of a multi-line message", () => {
    expect(stampLines("first\n  second", "S")).toBe("[S] first\n[S]   second");
  });

  it("leaves blank and colour-only lines alone", () => {
    const coloured = "\u001b[33m\u001b[39m\n\u001b[33mShutting down\u001b[39m\n";
    expect(stampLines(coloured, "S")).toBe("\u001b[33m\u001b[39m\n[S] \u001b[33mShutting down\u001b[39m\n");
    expect(stampLines("", "S")).toBe("");
    expect(stampLines("   ", "S")).toBe("   ");
  });
});

describe("installLogStamps", () => {
  it("stamps log, info, warn and error with the date and time", () => {
    const { target, out } = fakeConsole();
    const restore = installLogStamps(target, () => AT);
    target.log("a");
    target.info("b");
    target.warn("c");
    target.error("d");
    restore();
    expect(out).toEqual([
      { method: "log", text: "[2026-11-03 12:42:05Z] a" },
      { method: "info", text: "[2026-11-03 12:42:05Z] b" },
      { method: "warn", text: "[2026-11-03 12:42:05Z] c" },
      { method: "error", text: "[2026-11-03 12:42:05Z] d" },
    ]);
  });

  it("formats arguments as console does and stamps each line of a stack trace", () => {
    const { target, out } = fakeConsole();
    const restore = installLogStamps(target, () => AT);
    target.error("status %d:", 429, { retry: 8 });
    const err = new Error("boom");
    target.error("  Error:", err);
    restore();
    expect(out[0]!.text).toBe("[2026-11-03 12:42:05Z] status 429: { retry: 8 }");
    const lines = out[1]!.text.split("\n").filter(l => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).toMatch(STAMP);
  });

  it("reads the clock at each call, not at install", () => {
    const { target, out } = fakeConsole();
    let now = AT;
    const restore = installLogStamps(target, () => now);
    target.log("before");
    now = new Date("2026-11-04T00:00:01Z");
    target.log("after");
    restore();
    expect(out.map(o => o.text)).toEqual([
      "[2026-11-03 12:42:05Z] before",
      "[2026-11-04 00:00:01Z] after",
    ]);
  });

  it("never stamps a line twice, and restores the original methods", () => {
    const { target, out } = fakeConsole();
    const original = target.log;
    const restore = installLogStamps(target, () => AT);
    const second = installLogStamps(target, () => AT);
    target.log("once");
    second();
    restore();
    expect(out[0]!.text).toBe("[2026-11-03 12:42:05Z] once");
    expect(target.log).toBe(original);
  });

  it("dates the router's own lines: routes, 429s and throttle waits", () => {
    const original = console.log;
    const seen: string[] = [];
    console.log = (...a: unknown[]) => { seen.push(a.join(" ")); };
    const restore = installLogStamps(console, () => AT);
    try {
      logRoute("lyra", 12, 300);
      log429Diagnostic({
        accountId: "lyra", bare: true, cooldownSeconds: 8, streak: 1, retryAfter: undefined,
        limitStatus: "none", claim: "none", userAgent: "claude-cli/2.1", sessionId: undefined, model: "claude-opus-5-5",
      });
      logThrottleWait({ accountId: "vega", waitedMs: 2251, inFlight: 4, limit: 4, util: 0.73, short: false, bypassed: false });
    } finally {
      restore();
      console.log = original;
    }
    expect(seen).toHaveLength(3);
    for (const line of seen) {
      // Exactly one stamp, and it carries the date: no leftover time-only prefix.
      const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
      expect(plain).toMatch(/^\[2026-11-03 12:42:05Z\] \S/);
      expect(plain.slice(1)).not.toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    }
  });
});

describe("the running router", () => {
  it("dates the lines `cc-router start --foreground` prints", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "cc-router-stamp-"));
    const accounts = path.join(home, "accounts.json");
    writeFileSync(accounts, "[]");
    const tsx = path.resolve("node_modules/.bin/tsx");
    // An empty account list makes the server print its error and exit at once.
    const run = promisify(execFile)(tsx, ["src/cli/index.ts", "start", "--foreground", "--port", "0", "--accounts", accounts], {
      env: { ...process.env, HOME: home, FORCE_COLOR: "0", NO_COLOR: "1" },
      timeout: 30_000,
    });
    const result = await run.then(
      () => { throw new Error("expected the router to exit with an error"); },
      (err: { stdout: string; stderr: string; code: number }) => err,
    );
    expect(result.code).toBe(1);
    const lines = (result.stdout + result.stderr).split("\n").filter(l => l.trim() !== "" && !l.startsWith("npm "));
    expect(lines.some(l => l.includes("No accounts found"))).toBe(true);
    for (const line of lines) expect(line).toMatch(STAMP);
  }, 40_000);
});
