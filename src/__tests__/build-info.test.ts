import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { parseBuildInfo, readBuildInfo, UNKNOWN_BUILD } from "../proxy/build-info.js";
import { InFlightCounter, countsAsInFlight } from "../proxy/in-flight.js";
import { ROUTER_BOOT_MS, waitForListening, waitFor } from "./helpers/router-process.js";

// A deploy waits until health reports the sha it shipped, and before a cold
// restart for no request in flight. Both have to be right on the wire.

describe("build info", () => {
  it("parses what scripts/write-build-info.mjs writes", () => {
    expect(parseBuildInfo({ sha: "a".repeat(40), dirty: false, builtAt: "2026-11-19T00:00:00.000Z", version: "1.0.0" }))
      .toEqual({ sha: "a".repeat(40), dirty: false, builtAt: "2026-11-19T00:00:00.000Z", version: "1.0.0" });
  });

  it("treats a malformed or missing file as the unknown build, never an error", () => {
    expect(parseBuildInfo(null)).toEqual(UNKNOWN_BUILD);
    expect(parseBuildInfo({ sha: "not a sha; rm -rf /" }).sha).toBeNull();
    expect(readBuildInfo(join(tmpdir(), "cc-router-no-such-build-info.json"))).toEqual(UNKNOWN_BUILD);
    const dir = mkdtempSync(join(tmpdir(), "cc-router-build-info-"));
    try {
      writeFileSync(join(dir, "b.json"), "{ not json");
      expect(readBuildInfo(join(dir, "b.json"))).toEqual(UNKNOWN_BUILD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the build script records the commit it was built from", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync(process.execPath, ["scripts/write-build-info.mjs"], { stdio: "ignore" });
    const info = readBuildInfo(join("dist", "build-info.json"));
    expect(info.sha).toBe(head);
    expect(info.version).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
    expect(Number.isNaN(Date.parse(info.builtAt ?? ""))).toBe(false);
  });

  it("CC_ROUTER_BUILD_SHA overrides git, for builds outside a checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-build-sha-"));
    try {
      execFileSync(process.execPath, ["scripts/write-build-info.mjs"], {
        stdio: "ignore", env: { ...process.env, CC_ROUTER_BUILD_SHA: "b".repeat(40) },
      });
      expect(readBuildInfo(join("dist", "build-info.json")).sha).toBe("b".repeat(40));
    } finally {
      // Leave dist/build-info.json describing the real HEAD again.
      execFileSync(process.execPath, ["scripts/write-build-info.mjs"], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("in-flight counter", () => {
  it("counts a response until it closes, once", () => {
    const c = new InFlightCounter();
    const res = new EventEmitter() as unknown as ServerResponse;
    c.track(res);
    expect(c.snapshot()).toEqual({ requests: 1, served: 0 });
    res.emit("close");
    res.emit("close");
    expect(c.snapshot()).toEqual({ requests: 0, served: 1 });
  });

  it("counts model traffic only", () => {
    expect(countsAsInFlight({ url: "/v1/messages" } as IncomingMessage)).toBe(true);
    expect(countsAsInFlight({ url: "/cc-router/health" } as IncomingMessage)).toBe(false);
    expect(countsAsInFlight({ url: "/cc-router/dashboard" } as IncomingMessage)).toBe(false);
  });
});

interface Health {
  build: { sha: string | null; dirty: boolean; builtAt: string | null; version: string | null };
  inFlight: { requests: number; served: number };
}

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

// Spawns a real router: the process-test budget, not the 5 s unit default.
it("health reports the build and the requests still being answered", { timeout: 4 * ROUTER_BOOT_MS }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-build-health-"));
  // The upstream holds each reply until released, so a request stays in flight.
  const held: (() => void)[] = [];
  const upstream: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      held.push(() => {
        res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" });
        res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as { port: number }).port;
  const port = await freePort();
  const sha = "c".repeat(40);
  writeFileSync(join(dir, "build-info.json"), JSON.stringify({ sha, dirty: false, builtAt: "2026-11-19T00:00:00.000Z", version: "1.0.0" }));
  writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
    id: "fixture", accessToken: "fixture", refreshToken: "fixture",
    expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }]));
  writeFileSync(join(dir, "config.json"), JSON.stringify({}));

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${upstreamPort}'});`], {
    env: {
      ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
      ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"),
      SESSIONS_PATH: join(dir, "sessions.json"), CC_ROUTER_BUILD_INFO: join(dir, "build-info.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", b => { logs += b; });
  child.stderr.on("data", b => { logs += b; });
  const base = `http://127.0.0.1:${port}`;
  const health = async () => (await fetch(`${base}/cc-router/health`, { signal: AbortSignal.timeout(3000) })).json() as Promise<Health>;

  try {
    await waitForListening(child, () => logs);
    const idle = await health();
    expect(idle.build).toEqual({ sha, dirty: false, builtAt: "2026-11-19T00:00:00.000Z", version: "1.0.0" });
    expect(idle.inFlight).toEqual({ requests: 0, served: 0 });

    const pending = fetch(`${base}/v1/messages`, {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.317 (external, cli)" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    await waitFor(() => held.length === 1, "the request to reach upstream");
    expect((await health()).inFlight.requests).toBe(1);

    held.shift()!();
    expect((await pending).status).toBe(200);
    await waitFor(async () => (await health()).inFlight.requests === 0, "the request to close");
    expect((await health()).inFlight).toEqual({ requests: 0, served: 1 });
  } finally {
    held.forEach(f => f());
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>(r => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
