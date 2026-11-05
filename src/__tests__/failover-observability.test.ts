import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { FAILOVER_OUTCOMES, FAILOVER_REASONS, FailoverCounters, reasonOfStatus } from "../proxy/failover.js";
import { countRecent429s } from "../proxy/severity.js";
import { renderDashboardHtml } from "../proxy/web-dashboard.js";
import { waitForListening } from "./helpers/router-process.js";

// Failover is visible: health counts requests that entered it by how they
// ended and by what refused them, the dashboard draws that, a refusal the
// router failed over from does not count as a 429 the client saw, and the docs
// describe the chain and the supply controls with their config keys.

describe("failover counters", () => {
  it("count entries, retries, outcomes and reasons", () => {
    const c = new FailoverCounters(true, () => 1234);
    expect(c.snapshot()).toEqual({
      enabled: true, requests: 0, retries: 0, lastAt: null,
      byOutcome: Object.fromEntries(FAILOVER_OUTCOMES.map(o => [o, 0])),
      byReason: Object.fromEntries(FAILOVER_REASONS.map(r => [r, 0])),
    });
    c.entered(); c.refused("429"); c.retried(); c.ended("recovered");
    c.entered(); c.refused("503"); c.retried(); c.refused("503"); c.ended("exhausted");
    const s = c.snapshot();
    expect(s).toMatchObject({ requests: 2, retries: 2, lastAt: 1234 });
    expect(s.byOutcome).toMatchObject({ recovered: 1, exhausted: 1, ollama: 0 });
    expect(s.byReason).toMatchObject({ "429": 1, "503": 2, connection: 0 });
  });

  it("name every failed-over status, and nothing else as a status", () => {
    for (const s of [429, 529, 500, 502, 503, 504]) expect(reasonOfStatus(s)).toBe(String(s));
    expect(reasonOfStatus(0)).toBe("connection");
  });

  it("leave a failed-over 429 out of the burst count the severity reads", () => {
    const now = 1_000_000;
    const logs = [
      { ts: now - 1000, type: "error", statusCode: 429 },
      { ts: now - 900, type: "error", statusCode: 429, failedOver: true },
      { ts: now - 800, type: "error", statusCode: 429, failedOver: true },
    ];
    expect(countRecent429s(logs, now)).toBe(1);
  });
});

describe("the dashboard", () => {
  it("has a Failover card drawn from health, validated before use", () => {
    const html = renderDashboardHtml();
    expect(html).toContain('id="focard"');
    expect(html).toContain("function renderFailover");
    expect(html).toContain("renderFailover(h)");
    expect(html).toContain("validFailover(f)");
    for (const label of ["Recovered on another account", "Answered by Ollama", "Refusal passed on", "Refused by"]) expect(html).toContain(label);
    for (const src of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])) {
      expect(() => new Function(src)).not.toThrow();
    }
  });
});

describe("the docs", () => {
  const readme = readFileSync("README.md", "utf-8");
  const trouble = readFileSync("docs/troubleshooting.md", "utf-8");

  it("README describes the failover chain, pacing, spill, supply model and governor with their keys", () => {
    for (const key of ["routing.failover.enabled", "routing.weeklyPace", "fiveHourSlack", "ollamaFallback.spill", "routing.governor", "enforce", "stageOverride", "/cc-router/quota-history"]) {
      expect(readme).toContain(key);
    }
    expect(readme).toMatch(/supply model/i);
  });

  it("troubleshooting explains failover and the governor", () => {
    expect(trouble).toMatch(/failover/i);
    expect(trouble).toMatch(/governor/i);
    expect(trouble).toContain("routing.failover.enabled");
    expect(trouble).toContain("account-state.json");
  });
});

// ─── Through a real router, against a fake upstream ─────────────────────────

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

interface FailoverView {
  enabled: boolean; requests: number; retries: number; lastAt: number | null;
  byOutcome: Record<string, number>; byReason: Record<string, number>;
}

describe("failover in health, through a real router", () => {
  it("counts a recovered request and an exhausted one, by outcome and reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-failover-obs-"));
    // alpha always 429s (stated wait), beta answers once, then 503s.
    let betaCalls = 0;
    const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      const id = String(req.headers["authorization"] ?? "").replace(/^Bearer /, "");
      req.resume();
      req.on("end", () => {
        if (id === "alpha") {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
          res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow" } }));
          return;
        }
        betaCalls++;
        if (betaCalls === 1) {
          res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" });
          res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
          return;
        }
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "down" } }));
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    writeFileSync(join(dir, "accounts.json"), JSON.stringify(["alpha", "beta"].map(id => ({
      id, accessToken: id, refreshToken: id, expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
    }))));
    writeFileSync(join(dir, "config.json"), "{}");
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${(upstream.address() as { port: number }).port}'});`], {
      env: { ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
        ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"), SESSIONS_PATH: join(dir, "sessions.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", b => { logs += b; });
    child.stderr.on("data", b => { logs += b; });
    const base = `http://127.0.0.1:${port}`;
    const send = () => fetch(`${base}/v1/messages`, {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.317 (external, cli)" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    const health = async () => (await (await fetch(`${base}/cc-router/health`, { signal: AbortSignal.timeout(5000) })).json()) as
      { failover: FailoverView; severity: { recent429s: number } };
    try {
      await waitForListening(child, () => logs);
      let h = await health();
      expect(h.failover).toMatchObject({ enabled: true, requests: 0, retries: 0, lastAt: null });

      // Send until alpha has refused one and beta has served it.
      let recovered = false;
      for (let i = 0; i < 3 && !recovered; i++) {
        const res = await send();
        await res.text();
        h = await health();
        recovered = h.failover.byOutcome["recovered"] === 1;
      }
      expect(recovered).toBe(true);
      expect(h.failover.byReason["429"]).toBe(1);
      expect(h.failover.retries).toBe(1);
      // The client never saw alpha's 429.
      expect(h.severity.recent429s).toBe(0);

      // Wait out alpha's 1 s cooldown so both accounts are tried and both refuse.
      await new Promise(r => setTimeout(r, 1200));
      const last = await send();
      expect([429, 503]).toContain(last.status);
      await last.text();
      h = await health();
      expect(h.failover.byOutcome["exhausted"]).toBe(1);
      expect(h.failover.requests).toBe(2);
      expect(h.failover.byReason["503"]).toBeGreaterThanOrEqual(1);
      expect(h.failover.lastAt).toBeGreaterThan(0);
    } finally {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await new Promise<void>(r => upstream.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
