import { expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { waitForListening } from "./helpers/router-process.js";

// A re-login replaces a seat's credentials in place. DELETE+POST would drop the
// seat's caps and session pins and leave a gap with no such seat; PUT must not.
// The same run checks that the router records where it listens, beside
// accounts.json, and takes the record away when it shuts down.
it("replaces tokens in place, keeps the seat's caps, and records its endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-replace-test-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(r => reservation.close(() => r()));

  const seat = (id: string) => ({
    id, accessToken: `old-access-${id}`, refreshToken: `old-refresh-${id}`,
    expiresAt: Date.now() + 86_400_000, scopes: ["user:inference"], enabled: true,
  });
  writeFileSync(join(dir, "accounts.json"), JSON.stringify([seat("alpha"), seat("beta")]));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ proxySecret: "s3cret" }));

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
  const auth = { authorization: "Bearer s3cret", "content-type": "application/json" };
  const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = auth) =>
    fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  const fresh = { accessToken: "new-access-alpha", refreshToken: "new-refresh-alpha", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference", "user:profile"] };

  try {
    await waitForListening(child, () => logs);

    // The router says where it listens, in the same directory as accounts.json.
    const endpoint = JSON.parse(readFileSync(join(dir, "router.json"), "utf-8")) as { host: string; port: number; pid: number };
    expect(endpoint).toEqual({ host: "127.0.0.1", port, pid: child.pid });

    expect((await call("/cc-router/accounts/alpha", "PUT", fresh, {})).status).toBe(401);

    // A cap the user set on the seat...
    expect((await call("/cc-router/accounts/alpha", "PATCH", { sessionLimitPercent: 50 })).status).toBe(200);

    // ...survives the replacement.
    const put = await call("/cc-router/accounts/alpha", "PUT", fresh);
    expect(put.status).toBe(200);
    const view = (await put.json() as { account: { id: string; sessionLimitPercent: number; auth: { state: string } } }).account;
    expect(view.id).toBe("alpha");
    expect(view.sessionLimitPercent).toBe(50);
    expect(view.auth.state).toBe("ok");

    const onDisk = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf-8")) as Array<{ id: string; accessToken: string; refreshToken: string }>;
    expect(onDisk.find(a => a.id === "alpha")).toMatchObject({ accessToken: "new-access-alpha", refreshToken: "new-refresh-alpha" });
    expect(onDisk.find(a => a.id === "beta")).toMatchObject({ accessToken: "old-access-beta" });
    expect(onDisk).toHaveLength(2);

    // Refusals leave everything as it was.
    expect((await call("/cc-router/accounts/nobody", "PUT", fresh)).status).toBe(404);
    expect((await call("/cc-router/accounts/alpha", "PUT", { accessToken: "x" })).status).toBe(400);
    expect((await call("/cc-router/accounts/alpha", "PUT", { ...fresh, id: "beta" })).status).toBe(400);
    const after = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf-8")) as Array<{ id: string; accessToken: string }>;
    expect(after.find(a => a.id === "alpha")?.accessToken).toBe("new-access-alpha");
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  // A clean shutdown takes its record with it, so a stale file never points at a dead router.
  expect(existsSync(join(dir, "router.json"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
}, 60_000);
