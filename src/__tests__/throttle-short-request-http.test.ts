import { it, expect } from "vitest";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { waitFor, waitForListening } from "./helpers/router-process.js";

// End to end through the real proxy: with the account's only throttle slot held
// by a long streaming turn, a classifier-shaped request is admitted at once
// (and logged as a bypass), while an ordinary request waits and is logged.
it("lets a short request skip the throttle wait and logs every wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-throttle-short-"));
  const held: ServerResponse[] = [];
  const seen: string[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { stream?: boolean };
    seen.push(body.stream ? "stream" : "oneshot");
    if (body.stream) {
      // The long main-loop turn: headers out, then hold until the test ends.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hold\n\n");
      held.push(res);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "trivial" }] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as { port: number }).port;
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(r => reservation.close(() => r()));
  writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
    id: "fixture", accessToken: "fixture", refreshToken: "fixture",
    expiresAt: Date.now() + 86400000, scopes: [], enabled: true,
  }]));
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    throttle: { enabled: true, perAccountMaxInFlight: 1, minIntervalMs: 0, maxWaitMs: 1500 },
  }));
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port},litellmUrl:'http://127.0.0.1:${upstreamPort}'});`], {
    env: { ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
      ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"),
      SESSIONS_PATH: join(dir, "sessions.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", b => { logs += b; });
  child.stderr.on("data", b => { logs += b; });
  const base = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const send = (body: object) => fetch(base + "/v1/messages?beta=true", {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": "same-session" },
    body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }], ...body }),
    signal: controller.signal,
  });
  try {
    await waitForListening(child, () => logs);

    const long = await send({ stream: true, max_tokens: 32_000, tools: [{ name: "Bash", input_schema: { type: "object" } }] });
    expect(long.status).toBe(200);
    await waitFor(() => seen.length === 1, "long turn reached upstream");

    const short = await send({ max_tokens: 2068, system: [{ type: "text", text: "classify" }] });
    expect(short.status).toBe(200);
    await short.text();
    expect(logs).toMatch(/throttle bypass fixture waitMs=0 inFlight=1\/1 util=0% short=yes/);
    expect(logs).not.toMatch(/throttle wait/);

    const normal = await send({ max_tokens: 32_000 });
    expect(normal.status).toBe(200);
    await normal.text();
    const wait = /throttle wait fixture waitMs=(\d+) inFlight=1\/1 util=0% short=no/.exec(logs);
    expect(wait).not.toBeNull();
    expect(Number(wait![1])).toBeGreaterThanOrEqual(1_400);
    expect(seen).toEqual(["stream", "oneshot", "oneshot"]);
  } finally {
    controller.abort();
    for (const res of held) res.end();
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    if (child.exitCode === null) await exited;
    await new Promise<void>(r => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
