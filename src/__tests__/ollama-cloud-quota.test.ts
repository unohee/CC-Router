import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOllamaQuotaMonitor, parseOllamaBalance, signOllamaRequest } from "../providers/ollama/cloud-quota.js";

const balance = {
  included: { balance_usd: 273.04, allowance_usd: 300, period: { from: "2026-10-23T08:04:57Z", until: "2026-11-23T08:04:57Z" } },
  purchased: { balance_usd: 12.5 },
};

function keyFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
  const pub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const uint = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const str = (b: Buffer | string) => { const v = Buffer.from(b); return Buffer.concat([uint(v.length), v]); };
  const publicWire = Buffer.concat([str("ssh-ed25519"), str(pub)]);
  const inner = Buffer.concat([uint(123), uint(123), str("ssh-ed25519"), str(pub), str(Buffer.concat([seed, pub])), str("test")]);
  const wire = Buffer.concat([Buffer.from("openssh-key-v1\0"), str("none"), str("none"), str(""), uint(1), str(publicWire), str(inner)]);
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wire.toString("base64")}\n-----END OPENSSH PRIVATE KEY-----`,
    publicKey, publicWire,
  };
}

const monitors: ReturnType<typeof createOllamaQuotaMonitor>[] = [];
const monitor = (opts: Parameters<typeof createOllamaQuotaMonitor>[0]) => {
  const m = createOllamaQuotaMonitor(opts); monitors.push(m); return m;
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => { for (const m of monitors.splice(0)) m.stop(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Ollama balance telemetry", () => {
  it("parses remaining included/purchased credits without treating spending as a limit", () => {
    expect(parseOllamaBalance(balance)).toEqual({
      balance: { includedUsd: 273.04, allowanceUsd: 300, purchasedUsd: 12.5 },
      resetsAt: Date.parse("2026-11-23T08:04:57Z"),
    });
    expect(parseOllamaBalance({ totals: { usage_usd: 46.9 } })).toBeNull();
    expect(parseOllamaBalance({ included: { session: { remaining_percent: 80 }, weekly: { remaining_percent: 50 } }, purchased: { balance_usd: 0 } })).toBeNull();
    expect(parseOllamaBalance({ ...balance, purchased: { balance_usd: -1 },
      included: { ...balance.included, balance_usd: -0.1 } })).toMatchObject({
      balance: { includedUsd: -0.1, purchasedUsd: -1 },
    });
    expect(parseOllamaBalance({ ...balance, purchased: { balance_usd: Infinity } })).toBeNull();
    expect(parseOllamaBalance({ ...balance, included: { ...balance.included, allowance_usd: -1 } })).toBeNull();
    expect(parseOllamaBalance({ ...balance, included: { ...balance.included, period: { until: "bad date" } } })).toBeNull();
  });

  it("signs the exact official challenge with a real Ed25519 key", () => {
    const key = keyFixture();
    const challenge = "GET,/api/balance?ts=123456";
    const [pub, signature] = signOllamaRequest(key.privateKey, challenge).split(":");
    expect(pub).toBe(key.publicWire.toString("base64"));
    expect(verify(null, Buffer.from(challenge), key.publicKey, Buffer.from(signature, "base64"))).toBe(true);
    expect(verify(null, Buffer.from("GET,/api/me?ts=123456"), key.publicKey, Buffer.from(signature, "base64"))).toBe(false);
    expect(() => signOllamaRequest("not a private key", challenge)).toThrow();
  });

  it("uses a local daemon's balance endpoint without reading credentials", async () => {
    const readKey = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(json(balance));
    const m = monitor({ config: { baseUrl: "http://127.0.0.1:11434" }, apiKey: () => undefined, readPrivateKey: readKey, fetchImpl: fetchMock });
    await m.refresh();
    expect(m.snapshot()).toMatchObject({ status: "known", source: "http://127.0.0.1:11434/api/balance", balance: { includedUsd: 273.04 } });
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  });

  it("uses signed cloud balance only after matching the daemon account", async () => {
    const key = keyFixture();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(json({ id: 42, email: "private@example.com" }))
      .mockResolvedValueOnce(json({ ID: 42, Email: "private@example.com" }))
      .mockResolvedValueOnce(json(balance));
    const m = monitor({ config: { baseUrl: "http://localhost:11434" }, apiKey: () => undefined,
      readPrivateKey: async () => key.privateKey, fetchImpl: fetchMock, now: () => 123456000 });
    await m.refresh();
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
      "http://localhost:11434/api/balance", "http://localhost:11434/api/me",
      "https://ollama.com/api/me?ts=123456", "https://ollama.com/api/balance?ts=123456",
    ]);
    const [, sig] = fetchMock.mock.calls[3][1].headers.Authorization.split(":");
    expect(verify(null, Buffer.from("GET,/api/balance?ts=123456"), key.publicKey, Buffer.from(sig, "base64"))).toBe(true);
    expect(m.snapshot()).toMatchObject({ status: "known", source: "https://ollama.com/api/balance", checkedAt: 123456000 });
    expect(JSON.stringify(m.snapshot())).not.toMatch(/private@example|PRIVATE KEY|Authorization/);
  });

  it("does not query another user's balance when daemon and key identities differ", async () => {
    const key = keyFixture();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(json({ id: "daemon" })).mockResolvedValueOnce(json({ ID: "different" }));
    const m = monitor({ config: { baseUrl: "http://127.0.0.1:11434" }, apiKey: () => undefined,
      readPrivateKey: async () => key.privateKey, fetchImpl: fetchMock });
    await m.refresh();
    expect(m.snapshot()).toMatchObject({ status: "unavailable", reason: "account-mismatch" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reuses a configured cloud API key only for the official HTTPS host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(balance));
    const m = monitor({ config: { baseUrl: "https://ollama.com" }, apiKey: () => "private-key", fetchImpl: fetchMock });
    await m.refresh();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer private-key");
    expect(JSON.stringify(m.snapshot())).not.toContain("private-key");
    const other = monitor({ config: { baseUrl: "https://remote.example.com" }, apiKey: () => "private-key", fetchImpl: fetchMock });
    await other.refresh();
    expect(other.snapshot()).toMatchObject({ status: "unavailable", reason: "unsupported-host" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable for missing credentials and unsupported balances", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ included: {} }));
    const noKey = monitor({ config: { baseUrl: "https://ollama.com" }, apiKey: () => undefined, fetchImpl: fetchMock });
    await noKey.refresh();
    expect(noKey.snapshot().reason).toBe("no-api-key");
    expect(fetchMock).not.toHaveBeenCalled();
    const bad = monitor({ config: { baseUrl: "http://127.0.0.1:11434" }, apiKey: () => undefined, fetchImpl: fetchMock });
    await bad.refresh();
    expect(bad.snapshot()).toMatchObject({ status: "unavailable", reason: "unsupported-quota-format" });
  });

  it("invalidates a previous reading on failure without exposing the response body", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(balance)).mockResolvedValueOnce(json({ error: "secret-value" }, 401));
    const m = monitor({ config: { baseUrl: "https://ollama.com" }, apiKey: () => "secret-value", fetchImpl: fetchMock });
    await m.refresh();
    expect(m.snapshot().status).toBe("known");
    await m.refresh();
    expect(m.snapshot()).toMatchObject({ status: "unavailable", reason: "http-401" });
    expect(m.snapshot().balance).toBeUndefined();
    expect(JSON.stringify(m.snapshot())).not.toContain("secret-value");
  });

  it("makes stale data unknown without a network request on snapshot", async () => {
    let now = 1000;
    const fetchMock = vi.fn().mockResolvedValue(json(balance));
    const m = monitor({ config: { baseUrl: "https://ollama.com" }, apiKey: () => "key", fetchImpl: fetchMock, now: () => now });
    await m.refresh();
    now += 300001;
    expect(m.snapshot()).toMatchObject({ status: "unavailable", reason: "stale", checkedAt: 1000 });
    expect(m.snapshot().balance).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates in-flight polling and aborts it when stopped", async () => {
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("private-error")), { once: true }));
    });
    const m = monitor({ config: { baseUrl: "https://ollama.com" }, apiKey: () => "key", fetchImpl: fetchMock });
    const first = m.refresh();
    expect(m.refresh()).toBe(first);
    expect(m.snapshot()).toMatchObject({ status: "unavailable", reason: "not-checked" });
    m.stop();
    await first;
    expect(signal?.aborted).toBe(true);
    await m.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes a timed-out request unavailable without leaking fetch errors", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchMock = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("secret-path-or-token")), { once: true });
    }));
    const m = monitor({ config: { baseUrl: "https://ollama.com" }, apiKey: () => "key", fetchImpl: fetchMock });
    const pending = m.refresh();
    deadline.abort();
    await pending;
    expect(m.snapshot()).toMatchObject({ status: "unavailable", reason: "request-timeout" });
    expect(JSON.stringify(m.snapshot())).not.toContain("secret-path-or-token");
  });

  it("polls every minute and a stopped monitor cannot survive a restart", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fetchMock = vi.fn().mockImplementation(async () => json(balance));
    const make = () => monitor({ config: { baseUrl: "https://ollama.com" }, apiKey: () => "key", fetchImpl: fetchMock });
    const old = make();
    await old.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    old.stop();
    const restarted = make();
    await restarted.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    restarted.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
