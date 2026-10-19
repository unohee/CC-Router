import { it, expect } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

it("isolates Fable 429 across the actual proxy, session routing and health endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-model-test-"));
  const seen: string[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { model } = JSON.parse(raw);
    seen.push(model);
    const fable = model.startsWith("claude-fable");
    res.writeHead(fable ? 429 : 200, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-status": fable ? "rate_limited" : "allowed",
      "anthropic-ratelimit-unified-representative-claim": fable ? "seven_day_overage_included" : "five_hour",
      "anthropic-ratelimit-unified-5h-utilization": "0.74",
      "anthropic-ratelimit-unified-7d-utilization": "0.61",
      ...(fable ? { "retry-after": "3600" } : {}),
    });
    res.end(JSON.stringify(fable ? { error: {message: "Fable limit"} } : {content: [{text: "OK"}]}));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as {port: number}).port;
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as {port: number}).port;
  await new Promise<void>(r => reservation.close(() => r()));
  writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
    id: "fixture", accessToken: "fixture", refreshToken: "fixture",
    expiresAt: Date.now() + 86400000, scopes: [], enabled: true,
  }]));
  writeFileSync(join(dir, "config.json"), JSON.stringify({}));
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port},litellmUrl:'http://127.0.0.1:${upstreamPort}'});`], {
    env: {...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
      ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"),
      SESSIONS_PATH: join(dir, "sessions.json")},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", b => { logs += b; });
  child.stderr.on("data", b => { logs += b; });
  const base = `http://127.0.0.1:${port}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (logs.includes("Listening:")) { clearInterval(timer); clearTimeout(timeout); resolve(); }
        else if (child.exitCode !== null) { clearInterval(timer); clearTimeout(timeout); reject(new Error(logs)); }
      }, 25);
      const timeout = setTimeout(() => {clearInterval(timer); reject(new Error(logs || "startup timeout"));}, 5000);
    });
    const send = (model: string) => fetch(base + "/v1/messages", {
      method: "POST", headers: {"content-type": "application/json", "x-claude-code-session-id": "same-session"},
      body: JSON.stringify({model, max_tokens: 8, messages: [{role: "user", content: "OK"}]}),
      signal: AbortSignal.timeout(3000),
    });
    const first = await send("claude-fable-5-1");
    expect(first.status).toBe(429);
    await first.text();
    const second = await send("claude-sonnet-4-6");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({content: [{text: "OK"}]});
    const third = await send("claude-fable-5");
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(3500);
    // The router's own 429 is a retryable wait, never a relayed plan limit.
    expect(third.headers.get("x-should-retry")).toBe("true");
    expect([...third.headers.keys()].filter(k => k.startsWith("anthropic-ratelimit-unified"))).toEqual([]);
    await third.text();
    expect(seen).toEqual(["claude-fable-5-1", "claude-sonnet-4-6"]);
    const health = await (await fetch(base + "/cc-router/health")).json();
    expect(health.accounts[0].busy).toBe(false);
    expect(health.accounts[0].modelCooldowns.fable).toBeGreaterThan(Date.now());
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    if (child.exitCode === null) await exited;
    await new Promise<void>(r => upstream.close(() => r()));
    rmSync(dir, {recursive: true, force: true});
  }
}, 12000);
