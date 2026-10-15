import { describe, it, expect } from "vitest";
import {
  normalizeBlockedUserAgents, matchBlockedUserAgent, blockedClientError, createBlockLogGate,
} from "../proxy/client-block.js";

describe("normalizeBlockedUserAgents", () => {
  it("keeps non-empty strings, trimmed", () => {
    expect(normalizeBlockedUserAgents(["omp/", "  other-tool/1  "])).toEqual(["omp/", "other-tool/1"]);
  });

  it("drops empty and whitespace-only entries, which as a prefix would match every client", () => {
    expect(normalizeBlockedUserAgents(["", "   ", "omp/"])).toEqual(["omp/"]);
  });

  it("drops anything that is not a string and tolerates a config that is not an array", () => {
    expect(normalizeBlockedUserAgents(["omp/", 7, null, { a: 1 }, ["x"]])).toEqual(["omp/"]);
    for (const bad of [undefined, null, "omp/", 5, {}, true]) expect(normalizeBlockedUserAgents(bad)).toEqual([]);
  });
});

describe("matchBlockedUserAgent", () => {
  const patterns = ["omp/", "Evil-Tool"];

  it("matches a prefix, case-insensitively, and returns the configured pattern", () => {
    expect(matchBlockedUserAgent("omp/18.9.1", patterns)).toBe("omp/");
    expect(matchBlockedUserAgent("OMP/18.9.1", patterns)).toBe("omp/");
    expect(matchBlockedUserAgent("evil-tool/2", patterns)).toBe("Evil-Tool");
  });

  it("is a prefix match, not a substring match", () => {
    expect(matchBlockedUserAgent("something omp/18.9.1", patterns)).toBeNull();
    expect(matchBlockedUserAgent("homp/1", patterns)).toBeNull();
  });

  it("does not catch Claude Code or an unrelated client", () => {
    expect(matchBlockedUserAgent("claude-cli/2.1.300 (external, cli)", patterns)).toBeNull();
    expect(matchBlockedUserAgent("node", patterns)).toBeNull();
  });

  it("passes everything when nothing is configured or the client sent no user-agent", () => {
    expect(matchBlockedUserAgent("omp/18.9.1", [])).toBeNull();
    expect(matchBlockedUserAgent(undefined, patterns)).toBeNull();
    expect(matchBlockedUserAgent("", patterns)).toBeNull();
  });

  it("tolerates leading whitespace in the header", () => {
    expect(matchBlockedUserAgent("  omp/18.9.1", patterns)).toBe("omp/");
  });

  it("never lets an empty pattern match", () => {
    expect(matchBlockedUserAgent("anything/1", [""])).toBeNull();
  });
});

describe("blockedClientError", () => {
  it("is an Anthropic-shaped permission error that names the pattern and says what to do", () => {
    const body = blockedClientError("omp/");
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("permission_error");
    expect(body.error.message).toContain('blockedUserAgents: "omp/"');
    expect(body.error.message).toContain("own credentials");
  });
});

describe("createBlockLogGate", () => {
  it("logs the first block and swallows the repeats inside the interval", () => {
    const gate = createBlockLogGate(10_000);
    expect(gate("omp/", 1_000)).toEqual({ log: true, suppressed: 0 });
    expect(gate("omp/", 2_000).log).toBe(false);
    expect(gate("omp/", 9_999).log).toBe(false);
  });

  it("reports how many were swallowed when it logs again, then starts counting afresh", () => {
    const gate = createBlockLogGate(10_000);
    gate("omp/", 0);
    gate("omp/", 1_000);
    gate("omp/", 2_000);
    expect(gate("omp/", 10_000)).toEqual({ log: true, suppressed: 2 });
    expect(gate("omp/", 10_001).log).toBe(false);
    expect(gate("omp/", 20_000)).toEqual({ log: true, suppressed: 1 });
  });

  it("keeps each pattern's interval to itself", () => {
    const gate = createBlockLogGate(10_000);
    expect(gate("omp/", 0).log).toBe(true);
    expect(gate("other/", 1).log).toBe(true);
    expect(gate("omp/", 2).log).toBe(false);
  });
});
