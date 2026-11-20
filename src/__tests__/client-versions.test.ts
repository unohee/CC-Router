import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityLedger, claudeCliVersion, loadVerifiedClients } from "../proxy/continuity-ledger.js";
import { renderDashboardHtml } from "../proxy/web-dashboard.js";
import { FakeUpstream, listen, startRouter, type RouterRun } from "./helpers/continuity-harness.js";
import { ROUTER_BOOT_MS } from "./helpers/router-process.js";

// The continuity guarantee holds for the Claude Code versions the real-client
// conformance suite passed for. The router counts the versions that actually
// send traffic, so one that was never verified is visible before it matters.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 19, 12, 30);

describe("reading the version from a user agent", () => {
  it("takes the version Claude Code sends, and nothing else", () => {
    expect(claudeCliVersion("claude-cli/2.1.327 (external, cli)")).toBe("2.1.327");
    expect(claudeCliVersion("claude-cli/2.1.327 (external, sdk-cli)")).toBe("2.1.327");
    expect(claudeCliVersion(["claude-cli/2.2.0"])).toBe("2.2.0");
    for (const ua of [undefined, "", "curl/8.4.0", "omp/1.0", "claude-cli/latest", "claude-cli/2.1.327evil", "xclaude-cli/2.1.3"]) {
      expect(claudeCliVersion(ua)).toBeNull();
    }
  });
});

describe("the verified list", () => {
  it("is what the conformance suite wrote, bundled into dist by the build", () => {
    const src = JSON.parse(readFileSync(join("src", "continuity", "verified-clients.json"), "utf8")) as { verified: { version: string }[] };
    expect(src.verified.length).toBeGreaterThan(0);
    // The build's own output dir is dist/; a directory of this test's own keeps
    // parallel test files from racing on dist/ (build-info.test.ts writes it too).
    const out = mkdtempSync(join(tmpdir(), "cc-build-out-"));
    try {
      execFileSync(process.execPath, ["scripts/write-build-info.mjs"], { stdio: "ignore", env: { ...process.env, CC_ROUTER_BUILD_OUT_DIR: out } });
      expect(readFileSync(join(out, "continuity", "verified-clients.json"), "utf8"))
        .toBe(readFileSync(join("src", "continuity", "verified-clients.json"), "utf8"));
      expect([...loadVerifiedClients(join(out, "continuity", "verified-clients.json"))])
        .toEqual(src.verified.map(v => v.version));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("treats a missing or malformed list as nothing verified", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-verified-"));
    try {
      expect(loadVerifiedClients(join(dir, "none.json")).size).toBe(0);
      writeFileSync(join(dir, "bad.json"), "{");
      expect(loadVerifiedClients(join(dir, "bad.json")).size).toBe(0);
      writeFileSync(join(dir, "odd.json"), JSON.stringify({ verified: [{ version: "2.1.327" }, "2.2.0", { version: "x; rm" }, 3] }));
      expect([...loadVerifiedClients(join(dir, "odd.json"))].sort()).toEqual(["2.1.327", "2.2.0"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the ledger's client view", () => {
  it("lists the last day's versions, newest first, and which were never verified", () => {
    let now = T0;
    const l = new ContinuityLedger(() => now, new Set(["2.1.327"]));
    l.recordClient("2.1.327", 3, T0 - HOUR);
    l.recordClient("2.1.330", 1, T0 - 10 * 60_000);
    l.recordClient("2.1.300", 5, T0 - 30 * HOUR); // outside the day
    l.recordClient("not a version");
    l.recordClient(null);
    const c = l.snapshot().clients;
    expect(c.versions.map(v => [v.version, v.requestsLastDay, v.verified])).toEqual([["2.1.330", 1, false], ["2.1.327", 3, true]]);
    expect(c.unverified).toEqual(["2.1.330"]);
    expect(c.verified).toEqual(["2.1.327"]);
    now = T0 + 26 * HOUR;
    expect(l.snapshot().clients.versions).toEqual([]);
  });

  it("orders versions numerically, not as text", () => {
    const l = new ContinuityLedger(() => T0);
    for (const v of ["2.1.9", "2.1.10", "2.10.0"]) l.recordClient(v, 1, T0);
    expect(l.snapshot().clients.versions.map(v => v.version)).toEqual(["2.10.0", "2.1.10", "2.1.9"]);
  });

  it("survives a restart through the ledger file, and reads files written before clients were kept", () => {
    const a = new ContinuityLedger(() => T0, new Set(["2.1.327"]));
    a.recordClient("2.1.327", 4, T0 - HOUR);
    const b = new ContinuityLedger(() => T0, new Set(["2.1.327"]));
    expect(b.restore(JSON.parse(JSON.stringify(a.toFile())))).toBe(true);
    expect(b.snapshot().clients.versions).toMatchObject([{ version: "2.1.327", requestsLastDay: 4, verified: true }]);
    const old = new ContinuityLedger(() => T0);
    expect(old.restore({ version: 1, hours: [], handoffs: [] })).toBe(true);
    expect(old.snapshot().clients.versions).toEqual([]);
  });
});

describe("the dashboard", () => {
  it("shows the client versions on the Continuity card and marks unverified ones", () => {
    const html = renderDashboardHtml();
    expect(html).toContain("Claude Code: unverified");
    expect(html).toContain("(unverified)");
    for (const src of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])) {
      expect(() => new Function(src)).not.toThrow();
    }
  });
});

// Spawns a real router: the process-test budget, not the 5 s unit default.
describe("a real router counts who calls it", { timeout: 4 * ROUTER_BOOT_MS }, () => {
  let router: RouterRun | undefined;
  let up: FakeUpstream | undefined;
  afterEach(async () => {
    await router?.stop();
    if (up) { up.server.closeAllConnections(); await new Promise<void>(r => up!.server.close(() => r())); }
    router = up = undefined;
  });

  it("reports each version with its requests and whether it was verified", async () => {
    up = new FakeUpstream();
    const upstreamPort = await listen(up.server);
    // The router reads the list from beside its code; tests run from src/, so point it at the source list.
    router = await startRouter({
      mode: "standalone", upstreamPort, seats: [{ id: "lyra", expiresAt: Date.now() + 8 * HOUR }],
      env: { CC_ROUTER_VERIFIED_CLIENTS: join(process.cwd(), "src", "continuity", "verified-clients.json") },
    });
    const send = (ua: string) => fetch(`${router!.base}/v1/messages`, {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": ua },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    const verified = [...loadVerifiedClients(join("src", "continuity", "verified-clients.json"))][0]!;
    for (let i = 0; i < 3; i++) expect((await send(`claude-cli/${verified} (external, cli)`)).status).toBe(200);
    expect((await send("claude-cli/99.0.1 (external, cli)")).status).toBe(200);
    expect((await send("curl/8.4.0")).status).toBe(200);
    const h = await router.health() as unknown as { continuity: { clients: { versions: { version: string; requestsLastDay: number; verified: boolean }[]; unverified: string[] } } };
    expect(h.continuity.clients.versions.map(v => [v.version, v.requestsLastDay, v.verified]))
      .toEqual([["99.0.1", 1, false], [verified, 3, true]]);
    expect(h.continuity.clients.unverified).toEqual(["99.0.1"]);
  });
});
