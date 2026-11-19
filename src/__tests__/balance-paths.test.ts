import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { SessionRouter, type SessionTarget, type TargetMetrics } from "../proxy/session-router.js";
import { createSeats, type SeatSources } from "../proxy/seat-metrics.js";
import type { Account } from "../proxy/types.js";
import { waitForListening } from "./helpers/router-process.js";

// The paths around placement that used to have their own idea of a good
// seat: the failover pick now ranks as a new session would (under the balance
// rules), and a session follows the seat that failover served it from, so it
// pays one cache rewrite rather than one for failover and another for the
// re-placement on its next request. A request without a session id goes
// through the same ranking in rotate mode: the seats a session could be placed
// on, in turn (it leaves no cache behind, so it is spent on a seat's last
// stretch under the cap rather than held off it).

const NOW = Date.UTC(2026, 10, 19, 4, 29);
const nowSec = NOW / 1000;
const H = 3600;
const T = (accountId: string): SessionTarget => ({ provider: "anthropic", accountId });

function acct(id: string, weekUtil: number, weekHoursLeft: number, fiveUtil = 0.1): Account {
  return {
    id, enabled: true, healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0,
    rateLimits: { fiveHourUtil: fiveUtil, fiveHourReset: nowSec + 3 * H, sevenDayUtil: weekUtil, sevenDayReset: nowSec + weekHoursLeft * H },
  } as unknown as Account;
}

function sources(accounts: Account[], router: SessionRouter | null): SeatSources {
  return {
    pool: {
      getAll: () => accounts,
      getById: (id: string) => accounts.find(a => a.id === id),
      canServe: (id: string) => accounts.some(a => a.id === id),
      canRetain: (id: string) => accounts.some(a => a.id === id),
      canServeLastResort: () => false,
    } as unknown as SeatSources["pool"],
    openAIAccounts: [],
    canServeOpenAI: () => false,
    rank: router ? (c, usable, utilOf, mode) => router.rank(c, usable, utilOf, mode) : undefined,
  };
}

describe("the failover pick", () => {
  // coolest: worst window 0.2 with 150 h left on its week. urgent: 0.4 spent
  // but only 10 h left, so its remaining 58% is lost unless spent now. The old
  // pick took the coolest; a new session goes where the quota is about to go.
  const accounts = [acct("coolest", 0.2, 150, 0.05), acct("urgent", 0.4, 10, 0.3), acct("tried", 0.1, 100, 0.0)];

  it("ranks as a new session would under the balance rules", () => {
    const r = new SessionRouter({ now: () => NOW, softCapUtil: 0.98 });
    const seats = createSeats(sources(accounts, r));
    expect(seats.failoverPick(new Set(["tried"]), undefined)?.id).toBe("urgent");
  });

  it("is coolest-first under the legacy rules, or with no ranking wired", () => {
    const legacy = new SessionRouter({ now: () => NOW, softCapUtil: 0.98, balance: false });
    expect(createSeats(sources(accounts, legacy)).failoverPick(new Set(["tried"]), undefined)?.id).toBe("coolest");
    expect(createSeats(sources(accounts, null)).failoverPick(new Set(["tried"]), undefined)?.id).toBe("coolest");
  });

  it("does not pin or count the request", () => {
    const r = new SessionRouter({ now: () => NOW, softCapUtil: 0.98 });
    const seats = createSeats(sources(accounts, r));
    seats.failoverPick(new Set(), undefined);
    expect(r.size()).toBe(0);
    expect(accounts.every(a => a.requestCount === 0)).toBe(true);
  });
});

describe("a request without a session id", () => {
  const accounts = [acct("over", 0.985, 50, 0.1), acct("a", 0.3, 100, 0.1), acct("b", 0.3, 100, 0.1)];

  it("takes the seats under the cap in turn, and every usable seat only when none is", () => {
    const r = new SessionRouter({ now: () => NOW, softCapUtil: 0.98 });
    const seats = createSeats(sources(accounts, r));
    const picks = Array.from({ length: 4 }, () => seats.pickForRequest(undefined)?.id);
    expect(picks).toEqual(["a", "b", "a", "b"]);
    const allOver = [acct("x", 0.99, 50), acct("y", 0.985, 50)];
    const r2 = new SessionRouter({ now: () => NOW, softCapUtil: 0.98 });
    const s2 = createSeats(sources(allOver, r2));
    expect([s2.pickForRequest(undefined)?.id, s2.pickForRequest(undefined)?.id].sort()).toEqual(["x", "y"]);
  });

  it("counts as load on the seat, like a pinned request, and is null under the legacy rules", () => {
    const r = new SessionRouter({ now: () => NOW, softCapUtil: 0.98 });
    const seats = createSeats(sources(accounts, r));
    for (let i = 0; i < 20; i++) seats.pickForRequest(undefined);
    expect(r.size()).toBe(0);
    const legacy = new SessionRouter({ now: () => NOW, softCapUtil: 0.98, balance: false });
    expect(createSeats(sources(accounts, legacy)).pickForRequest(undefined)).toBeNull();
    expect(createSeats(sources(accounts, null)).pickForRequest(undefined)).toBeNull();
  });
});

describe("SessionRouter.pinTo", () => {
  it("pins the session to the seat that answered, replacing the pin failover left behind", () => {
    const changes: number[] = [];
    const r = new SessionRouter({ now: () => NOW, onAssignmentsChanged: () => changes.push(1) });
    const pool = [T("a"), T("b")];
    r.resolve("s", pool, t => t.accountId === "a");
    expect(r.peek("s")).toEqual(T("a"));
    r.pinTo("s", T("b"));
    expect(r.peek("s")).toEqual(T("b"));
    // Idempotent: pinning where it already is changes nothing.
    const n = changes.length;
    r.pinTo("s", T("b"));
    expect(changes).toHaveLength(n);
    // The next resolve keeps b (no re-placement).
    expect(r.resolve("s", pool, () => true)).toEqual(T("b"));
  });

  it("is a fresh pin for dwell: a just-pinned session is not moved for pace at once", () => {
    const clock = { now: NOW };
    const moves: string[] = [];
    const r = new SessionRouter({ now: () => clock.now, softCapUtil: 0.98, weeklyPace: { slack: 0.1, migrateAhead: 0.15, fiveHour: false, fiveHourSlack: 0.2 }, onReassign: ({ reason }) => moves.push(reason) });
    const pool = [T("a"), T("b")];
    const m = (t: SessionTarget): TargetMetrics => t.accountId === "a"
      ? { util: 0.85, resetAtSec: nowSec + 100 * H, weekly: { util: 0.85, resetAtSec: nowSec + 100 * H } }
      : { util: 0.3, resetAtSec: nowSec + 100 * H, weekly: { util: 0.3, resetAtSec: nowSec + 100 * H } };
    r.pinTo("s", T("a"));
    expect(r.resolve("s", pool, () => true, m)).toEqual(T("a"));
    expect(moves).toEqual([]);
  });
});

describe("server wiring", () => {
  it("ranks the failover pick through the session router and re-pins after failover", () => {
    const src = readFileSync(fileURLToPath(new URL("../proxy/server.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/rank: \(c, usable, utilOf, mode\) => sessionRouter\.rank\(c, usable, utilOf, mode\)/);
    expect(src).toMatch(/sessionRouter\.pinTo\(sid, \{ provider: "anthropic", accountId: answered\.id \}\)/);
    // Requests without a session id go through the same ranking first.
    expect(src).toMatch(/seats\.pickForRequest\(req\._ccAnthropicModel\)/);
    expect(src).toMatch(/account = pinnedAccount \?\? ranked \?\? pool\.getNext\(req\._ccAnthropicModel\)/);
  });
});

// ─── Through a real router, against a fake upstream ─────────────────────────

const SECRET = "s3cret-for-the-balance-paths-test";
const SESSION = "sess-ba1a-0000-4000-8000-000000000002";

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

interface Fixture { dir: string; refuse: Set<string>; served: string[]; upstream: Server; upstreamPort: number }

function reply(res: ServerResponse, ok: boolean): void {
  if (!ok) {
    res.writeHead(429, {
      "content-type": "application/json", "retry-after": "120",
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3600),
    });
    res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" });
  res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 1, output_tokens: 1 } }));
}

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "cc-router-balance-paths-"));
  const refuse = new Set<string>();
  const served: string[] = [];
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const seat = String(req.headers["authorization"] ?? "").replace(/^Bearer fixture-/, "");
      const ok = !refuse.has(seat);
      if (ok) served.push(seat);
      reply(res, ok);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  writeFileSync(join(dir, "accounts.json"), JSON.stringify(["one", "two", "three"].map(id => ({
    id, accessToken: `fixture-${id}`, refreshToken: "fixture",
    expiresAt: Date.now() + 86_400_000, scopes: [], enabled: true,
  }))));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ proxySecret: SECRET, routing: { softCapUtil: 0.98 } }));
  return { dir, refuse, served, upstream, upstreamPort: (upstream.address() as { port: number }).port };
}

interface Router { base: string; child: ChildProcess; stop: () => Promise<void> }

async function startRouter(f: Fixture): Promise<Router> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOST: "127.0.0.1", CC_ROUTER_DAEMON: "0",
    ACCOUNTS_PATH: join(f.dir, "accounts.json"), CONFIG_PATH: join(f.dir, "config.json"),
    SESSIONS_PATH: join(f.dir, "sessions.json"),
  };
  delete env["USAGE_PATH"];
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {startServer} from './src/proxy/server.ts'; await startServer({port:${port}, litellmUrl:'http://127.0.0.1:${f.upstreamPort}'});`], {
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

const send = (base: string) => fetch(`${base}/v1/messages`, {
  method: "POST", signal: AbortSignal.timeout(8000),
  headers: {
    "content-type": "application/json", "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/2.1.327 (external, cli)",
    "x-claude-code-session-id": SESSION, authorization: `Bearer ${SECRET}`,
  },
  body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
});

describe("after failover, through a real router", () => {
  it("the session stays on the seat that answered, so the next request pays no second move", async () => {
    const f = await fixture();
    const r = await startRouter(f);
    try {
      expect((await send(r.base)).status).toBe(200);
      const first = f.served[0];
      // The pinned seat refuses: failover answers from another one.
      f.refuse.add(first);
      expect((await send(r.base)).status).toBe(200);
      const answered = f.served[1];
      expect(answered).not.toBe(first);
      // The next two requests go straight to that seat: no third seat, no re-placement.
      expect((await send(r.base)).status).toBe(200);
      expect((await send(r.base)).status).toBe(200);
      expect(f.served.slice(2)).toEqual([answered, answered]);
      const health = await (await fetch(`${r.base}/cc-router/health`)).json() as { placements: { lastHour: Record<string, number> } };
      expect(health.placements.lastHour).toMatchObject({ placed: 1, unservable: 1 });
    } finally {
      await r.stop();
      await new Promise<void>(res => f.upstream.close(() => res()));
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 45_000);
});
