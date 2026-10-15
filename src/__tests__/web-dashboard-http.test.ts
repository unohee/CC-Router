import { expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

// The page is mounted ahead of the proxy-secret check because a browser
// navigation cannot carry an Authorization header. That is only safe if nothing
// ELSE slid out from in front of the check with it, so this runs the real server
// with a secret set and asks each surface in turn.
it("serves the usage page without the secret while everything else still demands it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-dash-test-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(r => reservation.close(() => r()));

  writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
    id: "fixture", accessToken: "fixture", refreshToken: "fixture",
    expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }]));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ proxySecret: "s3cret-for-the-test" }));

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}});`], {
    env: {
      ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
      ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"),
      SESSIONS_PATH: join(dir, "sessions.json"),
    },
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
      const timeout = setTimeout(() => { clearInterval(timer); reject(new Error(logs || "startup timeout")); }, 8000);
    });
    const get = (path: string, init: RequestInit = {}) =>
      fetch(base + path, { signal: AbortSignal.timeout(3000), redirect: "manual", ...init });

    // The page: open, hardened, and carrying no account data of its own.
    const page = await get("/cc-router/dashboard");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await page.text();
    expect(body).not.toContain("fixture");
    expect(body).not.toContain("s3cret-for-the-test");

    // The data it reads was already open for monitoring; nothing new is.
    expect((await get("/cc-router/health")).status).toBe(200);

    // Everything with a side effect or a token behind it is still shut.
    expect((await get("/cc-router/accounts")).status).toBe(401);
    expect((await get("/cc-router/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await get("/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);

    // ...and opens with the secret, so the 401s above were the check, not a dead route.
    expect((await get("/cc-router/accounts", { headers: { authorization: "Bearer s3cret-for-the-test" } })).status).toBe(200);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
