import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  BYTES_PER_TOKEN,
  CODEX_CONTEXT_WINDOW,
  CODEX_MAX_CONTEXT_WINDOW,
  CODEX_ESTIMATED_WALL,
  CODEX_SESSION_CEILING,
  codexCanHold,
  estimatePromptTokens,
} from "../providers/openai/context-limits.js";

const README = readFileSync(join(process.cwd(), "README.md"), "utf8");

describe("context limits", () => {
  it("leaves headroom below the wall Codex actually enforces", () => {
    // The ceiling is in estimate units (body bytes / BYTES_PER_TOKEN), so it is
    // compared against the measured real-token wall, not the advertised one.
    // The estimate carries error, and the session grows by another turn before
    // the guard is consulted again. A ceiling flush against the wall refuses.
    expect(CODEX_SESSION_CEILING).toBeLessThan(CODEX_ESTIMATED_WALL);
    expect(CODEX_ESTIMATED_WALL - CODEX_SESSION_CEILING).toBeGreaterThanOrEqual(150_000);
  });

  it("orders the two measured Codex windows correctly", () => {
    expect(CODEX_CONTEXT_WINDOW).toBeLessThan(CODEX_MAX_CONTEXT_WINDOW);
  });

  it("keeps the headroom figure the README quotes in step with the constants", () => {
    // The README states the gap in prose. Lowering a constant and updating only
    // the limit it appears next to would leave that sentence quietly wrong.
    const headroomK = (CODEX_ESTIMATED_WALL - CODEX_SESSION_CEILING) / 1_000;
    expect(README).toContain(`${headroomK}K of estimate`);
  });

  it("keeps the README's numbers equal to the constants", () => {
    // The README explains to an operator what the router will do on their
    // behalf. A drift between the two would send them chasing a limit that is
    // not the one being applied.
    expect(README).toContain(CODEX_SESSION_CEILING.toLocaleString("en-US"));
    expect(README).toContain(CODEX_MAX_CONTEXT_WINDOW.toLocaleString("en-US"));
    expect(README).toContain(CODEX_CONTEXT_WINDOW.toLocaleString("en-US"));
    expect(README).toContain(CODEX_ESTIMATED_WALL.toLocaleString("en-US"));
  });
});

describe("estimatePromptTokens", () => {
  it("sizes a body by the measured bytes-per-token ratio", () => {
    expect(estimatePromptTokens(Buffer.alloc(1_000))).toBe(278);
  });

  it("rounds up, so a body is never sized as smaller than it is", () => {
    expect(estimatePromptTokens(Buffer.alloc(BYTES_PER_TOKEN + 1))).toBe(2);
  });

  it("reports an absent or empty body as unknown, not as zero", () => {
    // Zero would read as "fits anywhere" — the one answer a missing measurement
    // must never give.
    expect(estimatePromptTokens(undefined)).toBeNull();
    expect(estimatePromptTokens(null)).toBeNull();
    expect(estimatePromptTokens(Buffer.alloc(0))).toBeNull();
  });

  it("stays below the ceiling for a body Codex can hold, and above it for one it cannot", () => {
    // The two sides of the decision the guard exists to make, in wire bytes.
    const holds = Buffer.alloc(CODEX_SESSION_CEILING * BYTES_PER_TOKEN);
    const doesNot = Buffer.alloc((CODEX_SESSION_CEILING + 1) * BYTES_PER_TOKEN);
    expect(codexCanHold(estimatePromptTokens(holds))).toBe(true);
    expect(codexCanHold(estimatePromptTokens(doesNot))).toBe(false);
  });
});

describe("codexCanHold", () => {
  it("admits a conversation at the ceiling and refuses the one past it", () => {
    expect(codexCanHold(CODEX_SESSION_CEILING)).toBe(true);
    expect(codexCanHold(CODEX_SESSION_CEILING + 1)).toBe(false);
  });

  it("admits an unmeasured request rather than disabling the route", () => {
    // "Not measured" is not evidence of being too big. Refusing it would take
    // every path that does not buffer a body out of cross-provider routing.
    expect(codexCanHold(null)).toBe(true);
  });

  it("refuses a conversation past the measured wall too", () => {
    // The ceiling is deliberately below the wall; what matters is that a
    // conversation sized past the wall is refused whatever the constant says.
    expect(codexCanHold(CODEX_ESTIMATED_WALL)).toBe(false);
    // The ordinary window Codex advertises is comfortably inside the ceiling;
    // the ceiling follows the measured wall, not either advertised number.
    expect(codexCanHold(CODEX_CONTEXT_WINDOW)).toBe(true);
  });
});
