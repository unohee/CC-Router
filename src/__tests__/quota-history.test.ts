import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DAY_MS, HOUR_MS, RETENTION_DAYS } from "../proxy/usage-history.js";
import {
  QuotaHistory, QUOTA_HISTORY_DEFAULT_DAYS, parseQuotaDays, quotaHistoryView, sanitizeAccountId, type QuotaFile,
} from "../proxy/quota-history.js";
import { createUsageFlusher, readUsageFile, writeUsageFile } from "../config/usage-store.js";
import { waitForListening } from "./helpers/router-process.js";

// Per-account quota readings over time, for the supply model: at most one per
// account per hour, kept 92 days in an atomic 0600 file beside accounts.json,
// restored after a restart with malformed rows skipped, and served read-only.

const T0 = Date.UTC(2026, 10, 4, 12, 10);
const HOUR0 = Math.floor(T0 / HOUR_MS) * HOUR_MS;
const RL = { fiveHourUtil: 0.42, fiveHourReset: 1_762_270_000, sevenDayUtil: 0.58, sevenDayReset: 1_762_700_000 };

function store(now = T0) {
  const at = { now };
  return { q: new QuotaHistory({ now: () => at.now }), at };
}

describe("sampling", () => {
  it("keeps the first reading of each hour per account and ignores the rest", () => {
    const { q, at } = store();
    expect(q.sample("lyra", RL)).toBe(true);
    at.now = T0 + 20 * 60_000;
    expect(q.sample("lyra", { ...RL, fiveHourUtil: 0.6 })).toBe(false);
    expect(q.sample("vega", { ...RL, fiveHourUtil: 0.1 })).toBe(true);
    at.now = T0 + HOUR_MS;
    expect(q.sample("lyra", { ...RL, fiveHourUtil: 0.7 })).toBe(true);
    const rows = q.readings();
    expect(rows.map(r => [r.hour - HOUR0, r.accountId, r.fiveHour.util])).toEqual([
      [0, "lyra", 0.42], [0, "vega", 0.1], [HOUR_MS, "lyra", 0.7],
    ]);
    expect(rows[0]).toMatchObject({
      sampledAt: T0,
      fiveHour: { util: 0.42, resetAt: RL.fiveHourReset },
      sevenDay: { util: 0.58, resetAt: RL.sevenDayReset },
    });
    expect(q.dirty).toBe(true);
  });

  it("does not store a reading with no window, which would read as 0% used", () => {
    const { q } = store();
    expect(q.sample("lyra", { fiveHourUtil: 0, fiveHourReset: 0, sevenDayUtil: 0, sevenDayReset: 0 })).toBe(false);
    expect(q.readings()).toEqual([]);
    expect(q.dirty).toBe(false);
  });

  it("refuses unusable ids and numbers", () => {
    const { q } = store();
    expect(q.sample("", RL)).toBe(false);
    expect(q.sample("bad id", RL)).toBe(false);
    expect(q.sample(42, RL)).toBe(false);
    expect(q.sample("x".repeat(200), RL)).toBe(false);
    expect(q.sample("lyra", { ...RL, fiveHourUtil: Number.NaN })).toBe(false);
    expect(q.sample("lyra", { ...RL, sevenDayUtil: -0.1 })).toBe(false);
    expect(q.sample("lyra", { ...RL, sevenDayReset: Number.POSITIVE_INFINITY })).toBe(false);
    expect(q.readings()).toEqual([]);
    expect(sanitizeAccountId(" kyte ")).toBe("kyte");
  });

  it("caps the number of accounts so a stream of ids cannot grow it", () => {
    const q = new QuotaHistory({ now: () => T0, maxAccounts: 2 });
    expect(q.sample("a", RL)).toBe(true);
    expect(q.sample("b", RL)).toBe(true);
    expect(q.sample("c", RL)).toBe(false);
    expect(q.readings().map(r => r.accountId)).toEqual(["a", "b"]);
  });

  it("is a copy: callers cannot change the store through it", () => {
    const { q } = store();
    q.sample("lyra", RL);
    q.readings()[0].fiveHour.util = 9;
    expect(q.readings()[0].fiveHour.util).toBe(0.42);
  });

  it("ages readings out after the retention", () => {
    const { q, at } = store();
    q.sample("lyra", RL);
    at.now = T0 + (RETENTION_DAYS - 1) * DAY_MS;
    q.prune();
    expect(q.readings()).toHaveLength(1);
    at.now = T0 + RETENTION_DAYS * DAY_MS + HOUR_MS;
    q.prune();
    expect(q.readings()).toEqual([]);
    // An old timestamp is not taken at all.
    expect(q.sample("lyra", RL, at.now - RETENTION_DAYS * DAY_MS - 1)).toBe(false);
  });
});

describe("on disk", () => {
  it("round-trips through an atomic 0600 file a restart reads back", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-quota-"));
    try {
      const path = join(dir, "quota-history.json");
      const { q, at } = store();
      q.sample("lyra", RL);
      at.now = T0 + HOUR_MS;
      q.sample("lyra", { ...RL, fiveHourUtil: 0.5 });
      q.sample("heewon", { ...RL, sevenDayUtil: 0.33 });
      const flush = createUsageFlusher(q, path, () => {}, undefined, "quota history");
      flush();
      expect(q.dirty).toBe(false);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(existsSync(`${path}.tmp`)).toBe(false);
      const file = JSON.parse(readFileSync(path, "utf-8")) as QuotaFile;
      expect(file.version).toBe(1);
      expect(file.rows[0]).toEqual([HOUR0 / 1000, "lyra", Math.floor(T0 / 1000), 0.42, RL.fiveHourReset, 0.58, RL.sevenDayReset, 0]);

      const read = readUsageFile(path);
      expect(read.status).toBe("ok");
      const { q: after } = store(T0 + HOUR_MS);
      expect(after.restore((read as { data: unknown }).data)).toBe(true);
      expect(after.readings().map(r => ({ ...r, sampledAt: Math.floor(r.sampledAt / 1000) })))
        .toEqual(q.readings().map(r => ({ ...r, sampledAt: Math.floor(r.sampledAt / 1000) })));
      // A restored hour is not sampled again.
      expect(after.sample("lyra", { ...RL, fiveHourUtil: 0.9 })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips malformed rows and keeps the rest", () => {
    const { q } = store();
    const h = HOUR0 / 1000;
    expect(q.restore({
      version: 1,
      rows: [
        [h, "lyra", h + 60, 0.1, 100, 0.2, 200],
        [h, "lyra", h + 120, 0.9, 100, 0.9, 200], // same hour and account: the first is kept
        [h, "bad id", h, 0.1, 1, 0.1, 1],
        [h, "vega", h, "x", 1, 0.1, 1],
        [h, "vega", h, 0.1, 1, 0.1],
        ["h", "vega", h, 0.1, 1, 0.1, 1],
        [h, "vega", h, -1, 1, 0.1, 1],
        null,
        [h - 3600, "rigel", h + 99_999, 0.3, 1, 0.4, 2], // sample time clamped into its hour
      ],
    })).toBe(true);
    const rows = q.readings();
    expect(rows.map(r => [r.accountId, r.fiveHour.util])).toEqual([["rigel", 0.3], ["lyra", 0.1]]);
    expect(rows[0].sampledAt).toBe(HOUR0 - 1);
  });

  it("rejects a file that is not a quota history", () => {
    const { q } = store();
    expect(q.restore(null)).toBe(false);
    expect(q.restore({ version: 2, rows: [] })).toBe(false);
    expect(q.restore({ version: 1, rows: {} })).toBe(false);
    expect(q.readings()).toEqual([]);
  });

  it("keeps a failed write dirty so the next tick tries again", () => {
    const { q } = store();
    q.sample("lyra", RL);
    const warnings: string[] = [];
    const flush = createUsageFlusher(q, "/nonexistent/x.json", m => warnings.push(m), () => ({ ok: false, error: "disk full" }), "quota history");
    flush();
    flush();
    expect(q.dirty).toBe(true);
    expect(warnings).toEqual(["could not save quota history to /nonexistent/x.json: disk full"]);
    expect(writeUsageFile).toBeTypeOf("function");
  });
});

describe("the view the endpoint serves", () => {
  it("groups by account and keeps only the requested days", () => {
    const { q, at } = store();
    q.sample("lyra", RL, T0 - 10 * DAY_MS);
    q.sample("lyra", RL);
    q.sample("heewon", RL);
    at.now = T0;
    const v = quotaHistoryView(q, { now: T0, days: 7 });
    expect(v.days).toBe(7);
    expect(v.retentionDays).toBe(RETENTION_DAYS);
    expect(v.accounts.map(a => [a.id, a.readings.length])).toEqual([["heewon", 1], ["lyra", 1]]);
    expect(quotaHistoryView(q, { now: T0, days: 30 }).accounts.find(a => a.id === "lyra")!.readings).toHaveLength(2);
  });

  it("parses ?days= within the retention", () => {
    expect(parseQuotaDays(undefined)).toBe(QUOTA_HISTORY_DEFAULT_DAYS);
    expect(parseQuotaDays("30")).toBe(30);
    expect(parseQuotaDays("500")).toBe(RETENTION_DAYS);
    expect(parseQuotaDays("0")).toBe(QUOTA_HISTORY_DEFAULT_DAYS);
    expect(parseQuotaDays("-3")).toBe(QUOTA_HISTORY_DEFAULT_DAYS);
    expect(parseQuotaDays("1e3")).toBe(QUOTA_HISTORY_DEFAULT_DAYS);
  });
});

// ─── Through a real router, against a fake upstream ─────────────────────────

const SECRET = "s3cret-for-the-quota-test";

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

interface Router { base: string; child: ChildProcess; stop: () => Promise<void> }

async function startRouter(dir: string, upstreamPort: number): Promise<Router> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
    ACCOUNTS_PATH: join(dir, "accounts.json"), CONFIG_PATH: join(dir, "config.json"),
    SESSIONS_PATH: join(dir, "sessions.json"),
  };
  // Left unset on purpose: the default must land beside accounts.json.
  delete env["QUOTA_HISTORY_PATH"];
  delete env["USAGE_PATH"];
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${upstreamPort}'});`], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout!.on("data", b => { logs += b; });
  child.stderr!.on("data", b => { logs += b; });
  await waitForListening(child, () => logs);
  return {
    base: `http://127.0.0.1:${port}`, child,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 4000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

interface View { days: number; accounts: Array<{ id: string; readings: Array<{ fiveHour: { util: number; resetAt: number }; sevenDay: { util: number; resetAt: number } }> }> }

describe("quota history through a real router", () => {
  it("samples upstream headers once per hour, serves them behind the secret, and keeps them across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-quota-http-"));
    let util = 0.25;
    const upstream: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": String(util),
          "anthropic-ratelimit-unified-5h-reset": "1762270000",
          "anthropic-ratelimit-unified-7d-utilization": "0.5",
          "anthropic-ratelimit-unified-7d-reset": "1762700000",
        });
        res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
      id: "fixture", accessToken: "fixture", refreshToken: "fixture",
      expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
    }]));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ proxySecret: SECRET }));
    const auth = { authorization: `Bearer ${SECRET}` };
    const send = (base: string) => fetch(`${base}/v1/messages`, {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...auth },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    const view = async (base: string, query = ""): Promise<View> =>
      (await fetch(`${base}/cc-router/quota-history${query}`, { headers: auth, signal: AbortSignal.timeout(5000) })).json() as Promise<View>;

    let r = await startRouter(dir, upstreamPort);
    try {
      expect((await send(r.base)).status).toBe(200);
      util = 0.3;
      expect((await send(r.base)).status).toBe(200);
      const v = await view(r.base);
      expect(v.days).toBe(QUOTA_HISTORY_DEFAULT_DAYS);
      expect(v.accounts).toHaveLength(1);
      expect(v.accounts[0].id).toBe("fixture");
      // Two responses in one hour: one reading, the first.
      expect(v.accounts[0].readings).toHaveLength(1);
      expect(v.accounts[0].readings[0]).toMatchObject({
        fiveHour: { util: 0.25, resetAt: 1762270000 }, sevenDay: { util: 0.5, resetAt: 1762700000 },
      });

      // Behind the secret, and read-only.
      expect((await fetch(`${r.base}/cc-router/quota-history`, { signal: AbortSignal.timeout(5000) })).status).toBe(401);
      const post = await fetch(`${r.base}/cc-router/quota-history`, { method: "POST", headers: auth, signal: AbortSignal.timeout(5000) });
      expect(post.status).toBeGreaterThanOrEqual(400);

      await r.stop();
      const path = join(dir, "quota-history.json");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect((JSON.parse(readFileSync(path, "utf-8")) as QuotaFile).rows).toHaveLength(1);

      r = await startRouter(dir, upstreamPort);
      const after = await view(r.base, "?days=1");
      expect(after.days).toBe(1);
      expect(after.accounts[0].readings).toHaveLength(1);
      expect(after.accounts[0].readings[0].fiveHour.util).toBe(0.25);
    } finally {
      await r.stop();
      await new Promise<void>(res => upstream.close(() => res()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps an unreadable file aside instead of overwriting it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-quota-corrupt-"));
    const upstream: Server = createServer((_req, res) => { res.writeHead(500); res.end(); });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    writeFileSync(join(dir, "accounts.json"), JSON.stringify([{
      id: "fixture", accessToken: "fixture", refreshToken: "fixture",
      expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
    }]));
    writeFileSync(join(dir, "config.json"), "{}");
    writeFileSync(join(dir, "quota-history.json"), "{not json");
    const r = await startRouter(dir, (upstream.address() as { port: number }).port);
    try {
      expect(readFileSync(join(dir, "quota-history.json.corrupt"), "utf-8")).toBe("{not json");
      const v = await (await fetch(`${r.base}/cc-router/quota-history`, { signal: AbortSignal.timeout(5000) })).json() as View;
      expect(v.accounts).toEqual([]);
    } finally {
      await r.stop();
      await new Promise<void>(res => upstream.close(() => res()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
