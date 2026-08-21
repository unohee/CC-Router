import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  CLIENT_CONTEXT_CEILING,
  CODEX_CONTEXT_WINDOW,
  CODEX_MAX_CONTEXT_WINDOW,
} from "../providers/openai/context-limits.js";

const README = readFileSync(join(process.cwd(), "README.md"), "utf8");

describe("context limits", () => {
  it("leaves headroom below the ceiling Codex actually enforces", () => {
    // The request that triggers compaction is still sent, and one large tool
    // result can land on top of it. A ceiling flush against the limit refuses.
    expect(CLIENT_CONTEXT_CEILING).toBeLessThan(CODEX_MAX_CONTEXT_WINDOW);
    expect(CODEX_MAX_CONTEXT_WINDOW - CLIENT_CONTEXT_CEILING).toBeGreaterThanOrEqual(50_000);
  });

  it("stays inside the range Claude Code accepts for autoCompactWindow", () => {
    // Verified against the 2.1.237 build: values outside this are rejected.
    expect(CLIENT_CONTEXT_CEILING).toBeGreaterThanOrEqual(100_000);
    expect(CLIENT_CONTEXT_CEILING).toBeLessThanOrEqual(1_000_000);
  });

  it("orders the two measured Codex windows correctly", () => {
    expect(CODEX_CONTEXT_WINDOW).toBeLessThan(CODEX_MAX_CONTEXT_WINDOW);
  });

  it("keeps the headroom figure the README quotes in step with the constants", () => {
    // README:405 states the gap in prose. Lowering a constant and updating only
    // the limit it appears next to would leave that sentence quietly wrong.
    const headroomK = (CODEX_MAX_CONTEXT_WINDOW - CLIENT_CONTEXT_CEILING) / 1_000;
    expect(README).toContain(`${headroomK}k of headroom`);
  });

  it("keeps the README's numbers equal to the constants", () => {
    // The README tells an operator what to put in settings.json, and nothing
    // imports these constants at runtime — so a drift between the two would be
    // silent, and the advice is what people actually follow.
    expect(README).toContain(String(CLIENT_CONTEXT_CEILING));
    expect(README).toContain(CODEX_MAX_CONTEXT_WINDOW.toLocaleString("en-US"));
    expect(README).toContain(CODEX_CONTEXT_WINDOW.toLocaleString("en-US"));
  });
});
