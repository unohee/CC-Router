import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezePersistence, thawPersistence, persistenceFrozen } from "../config/persistence-gate.js";
import { writeUsageFile } from "../config/usage-store.js";
import { refreshAccountToken } from "../proxy/token-refresher.js";
import { ACCOUNT_USER_DEFAULTS, DEFAULT_RATE_LIMITS, type Account } from "../proxy/types.js";
import {
  FakeOAuth, FakeUpstream, isCompleteStream, listen, readStream, sendMessage, startRouter, type RouterRun,
} from "./helpers/continuity-harness.js";
import { waitFor } from "./helpers/router-process.js";

// A reload must drop nothing: the supervisor keeps the socket, the new worker
// takes new requests, the old one finishes its streams. And only one of them
// may write state or rotate tokens, or the reload itself kills a seat.

describe("the persistence gate", () => {
  afterEach(() => thawPersistence());

  it("turns history writes into no-ops while frozen", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-router-gate-"));
    try {
      freezePersistence();
      expect(persistenceFrozen()).toBe(true);
      expect(writeUsageFile(join(dir, "usage.json"), { version: 1 })).toEqual({ ok: true });
      expect(existsSync(join(dir, "usage.json"))).toBe(false);
      thawPersistence();
      expect(writeUsageFile(join(dir, "usage.json"), { version: 1 })).toEqual({ ok: true });
      expect(existsSync(join(dir, "usage.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declines a refresh without asking the server or marking the seat", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const account: Account = {
      id: "a", tokens: { accessToken: "x", refreshToken: "y", expiresAt: Date.now() + 60_000, scopes: [] },
      healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0,
      consecutiveErrors: 0, rateLimits: { ...DEFAULT_RATE_LIMITS }, ...ACCOUNT_USER_DEFAULTS,
    };
    try {
      freezePersistence();
      expect(await refreshAccountToken(account)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(account.authState).toBeUndefined();
      expect(account.consecutiveErrors).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

const HOUR = 3_600_000;
const CHUNKS = 12;

describe("reload under the supervisor", { timeout: 90_000 }, () => {
  let router: RouterRun | undefined;
  let upstream: FakeUpstream | undefined;
  let oauth: FakeOAuth | undefined;
  afterEach(async () => {
    await router?.stop();
    await new Promise<void>(r => (upstream ? upstream.server.close(() => r()) : r()));
    await new Promise<void>(r => (oauth ? oauth.server.close(() => r()) : r()));
    router = upstream = oauth = undefined;
  });

  let releaseStream: () => void = () => {};
  async function boot() {
    const gate = new Promise<void>(resolve => { releaseStream = resolve; });
    // Tokens live two hours and the lead window is seven, so every worker
    // refreshes each seat as it starts: the new worker can only succeed if the
    // old one saved the rotated refresh tokens before it froze.
    oauth = new FakeOAuth(2 * 3600);
    const oauthPort = await listen(oauth.server);
    upstream = new FakeUpstream({ chunks: CHUNKS, gapMs: 120, oauth, gate });
    const upstreamPort = await listen(upstream.server);
    router = await startRouter({
      mode: "supervised", upstreamPort,
      seats: [{ id: "lyra", expiresAt: Date.now() + 2 * HOUR }, { id: "vega", expiresAt: Date.now() + 2 * HOUR }],
      config: { tokenRefresh: { leadMinutes: 420 } },
      env: { CC_ROUTER_OAUTH_TOKEN_URL: `http://127.0.0.1:${oauthPort}/v1/oauth/token`, CC_ROUTER_DRAIN_LIMIT_MS: "20000" },
    });
    const r = router;
    await waitFor(async () => (await r.health()).supervisor?.generation === 1, "the first worker");
    await waitFor(() => oauth!.calls >= 2, "the first worker's refreshes");
    return r;
  }

  it("finishes a stream that was running across the reload, and the new worker takes over", async () => {
    const r = await boot();
    const first = await r.health();
    expect(first.supervisor).toMatchObject({ supervised: true, generation: 1, lastHandoff: null });

    const res = await sendMessage(r.base, { stream: true, session: "long" });
    expect(res.status).toBe(200);
    const streamed = readStream(res, () => { process.kill(r.child.pid!, "SIGHUP"); });

    await waitFor(async () => (await r.health()).supervisor?.generation === 2, "the new worker", 30_000);
    const after = await r.health();
    expect(after.worker.pid).not.toBe(first.worker.pid);
    // Only now let the stream run on: it finishes while its worker drains,
    // however long the new worker took to come up on a loaded host.
    releaseStream();

    // New requests are answered (by the new worker) while the old one drains.
    for (let i = 0; i < 3; i++) expect((await sendMessage(r.base, { session: `new${i}` })).status).toBe(200);

    const { text, broken } = await streamed;
    expect(broken).toBe(false);
    expect(isCompleteStream(text, CHUNKS)).toBe(true);

    await waitFor(async () => (await r.health()).supervisor?.lastHandoff != null, "the drain report", 30_000);
    const report = (await r.health()).supervisor!.lastHandoff!;
    expect(report).toMatchObject({ generation: 2, fromPid: first.worker.pid, toPid: after.worker.pid, dropped: 0 });
    expect(report.finished).toBeGreaterThanOrEqual(1);

    // One writer at a time: no refresh token was used twice, no stale access
    // token reached upstream, and the new worker refreshed from what the old
    // one saved.
    expect(oauth!.reuses).toBe(0);
    expect(upstream!.staleTokens).toBe(0);
    expect(oauth!.calls).toBe(4);
    expect(after.accounts.every(a => a.auth.state === "ok")).toBe(true);
  });

  it("replaces a worker that crashes, on the same port", async () => {
    const r = await boot();
    const first = await r.health();
    process.kill(first.worker.pid, "SIGKILL");
    await waitFor(async () => {
      try { return (await r.health()).supervisor?.generation === 2; } catch { return false; }
    }, "a replacement worker", 30_000);
    const h = await r.health();
    expect(h.worker.pid).not.toBe(first.worker.pid);
    expect((await sendMessage(r.base, { session: "after-crash" })).status).toBe(200);
    expect(oauth!.reuses).toBe(0);
  });

  it("keeps the old worker serving when the new one cannot start", async () => {
    const r = await boot();
    const first = await r.health();
    // The next release is broken: the new worker cannot even load.
    mkdirSync(join(r.dir, "broken"));
    unlinkSync(join(r.dir, "release"));
    symlinkSync(join(r.dir, "broken"), join(r.dir, "release"));
    process.kill(r.child.pid!, "SIGHUP");
    await waitFor(async () => (await r.health()).supervisor?.failedReloads === 1, "the reload to be abandoned", 60_000);
    const h = await r.health();
    expect(h.worker.pid).toBe(first.worker.pid);
    expect(h.worker.frozen).toBe(false);
    expect(h.supervisor?.generation).toBe(1);
    expect((await sendMessage(r.base, { session: "still" })).status).toBe(200);
  });
});
