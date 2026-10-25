import { createPrivateKey, sign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedOllamaFallbackConfig } from "./fallback-policy.js";

export interface OllamaCloudQuota {
  status: "known" | "unavailable";
  source: string | null;
  checkedAt: number | null;
  /** Included and purchased are remaining credits, not spending. */
  balance?: { includedUsd: number; allowanceUsd: number; purchasedUsd: number };
  resetsAt: number | null;
  reason?: string;
}

const CLOUD = "https://ollama.com";
const POLL_MS = 60_000;
const STALE_MS = 5 * POLL_MS;
const TIMEOUT_MS = 10_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The monthly-credit variant of the official /api/balance schema. */
export function parseOllamaBalance(value: unknown): Pick<OllamaCloudQuota, "balance" | "resetsAt"> | null {
  const body = record(value);
  const included = record(body?.included);
  const purchased = record(body?.purchased);
  const period = record(included?.period);
  if (!included || !purchased || !period
      || !finite(included.balance_usd) || !finite(included.allowance_usd) || included.allowance_usd < 0
      || !finite(purchased.balance_usd) || typeof period.until !== "string") return null;
  const resetsAt = Date.parse(period.until);
  if (!Number.isFinite(resetsAt)) return null;
  return {
    balance: {
      includedUsd: included.balance_usd,
      allowanceUsd: included.allowance_usd,
      purchasedUsd: purchased.balance_usd,
    },
    resetsAt,
  };
}

/** Ollama auth.Sign wire format: SSH public key blob + raw Ed25519 signature.
 *  Only the unencrypted, single-key format created by Ollama is accepted.
 *  https://github.com/ollama/ollama/blob/main/auth/auth.go */
export function signOllamaRequest(privateKey: string, challenge: string): string {
  const lines = privateKey.trim().split(/\r?\n/);
  if (lines.shift() !== "-----BEGIN OPENSSH PRIVATE KEY-----"
      || lines.pop() !== "-----END OPENSSH PRIVATE KEY-----") throw new Error("unsupported-key");
  const data = Buffer.from(lines.join(""), "base64");
  const reader = (buffer: Buffer, start = 0) => {
    let offset = start;
    const uint = () => {
      if (offset + 4 > buffer.length) throw new Error("invalid-key");
      const value = buffer.readUInt32BE(offset);
      offset += 4;
      return value;
    };
    const bytes = () => {
      const size = uint();
      if (offset + size > buffer.length) throw new Error("invalid-key");
      const value = buffer.subarray(offset, offset + size);
      offset += size;
      return value;
    };
    return { uint, bytes };
  };
  if (data.subarray(0, 15).toString() !== "openssh-key-v1\0") throw new Error("invalid-key");
  const outer = reader(data, 15);
  if (outer.bytes().toString() !== "none" || outer.bytes().toString() !== "none"
      || outer.bytes().length !== 0 || outer.uint() !== 1) throw new Error("unsupported-key");
  const publicWire = outer.bytes();
  const inner = reader(outer.bytes());
  if (inner.uint() !== inner.uint() || inner.bytes().toString() !== "ssh-ed25519") throw new Error("invalid-key");
  const publicRaw = inner.bytes();
  const privateRaw = inner.bytes();
  const publicFields = reader(publicWire);
  if (publicRaw.length !== 32 || privateRaw.length !== 64
      || !privateRaw.subarray(32).equals(publicRaw)
      || publicFields.bytes().toString() !== "ssh-ed25519"
      || !publicFields.bytes().equals(publicRaw)) throw new Error("invalid-key");
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateRaw.subarray(0, 32)]),
    format: "der", type: "pkcs8",
  });
  return `${publicWire.toString("base64")}:${sign(null, Buffer.from(challenge), key).toString("base64")}`;
}

async function readLocalPrivateKey(): Promise<string> {
  const file = join(homedir(), ".ollama", "id_ed25519");
  const info = await stat(file);
  // Never reach into a different service user's home or relax key permissions.
  if ((typeof process.getuid === "function" && info.uid !== process.getuid())
      || (info.mode & 0o077) !== 0) throw new Error("key-not-private");
  return readFile(file, "utf8");
}

export interface OllamaQuotaMonitorOptions {
  config: Pick<ResolvedOllamaFallbackConfig, "baseUrl">;
  apiKey: () => string | undefined;
  fetchImpl?: typeof fetch;
  readPrivateKey?: () => Promise<string>;
  now?: () => number;
}

/** Cached telemetry only: neither health nor request routing waits for the cloud. */
export function createOllamaQuotaMonitor(opts: OllamaQuotaMonitorOptions): {
  snapshot(): OllamaCloudQuota;
  refresh(): Promise<void>;
  stop(): void;
} {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  let current: OllamaCloudQuota = {
    status: "unavailable", source: null, checkedAt: null, resetsAt: null, reason: "not-checked",
  };
  let stopped = false;
  let pending: Promise<void> | null = null;
  let active: AbortController | null = null;

  const check = async (): Promise<void> => {
    let source: string | null = null;
    let failure = "request-failed";
    const controller = new AbortController();
    active = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const request = (url: string, init: RequestInit = {}) => fetchImpl(url, {
      ...init, signal, redirect: "error", headers: { Accept: "application/json", ...init.headers },
    });
    try {
      const base = new URL(opts.config.baseUrl);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
        && ["http:", "https:"].includes(base.protocol);
      const directCloud = base.origin === CLOUD;
      if ((!local && !directCloud) || base.username || base.password) {
        failure = "unsupported-host";
        throw new Error(failure);
      }
      let response: Response;
      if (directCloud) {
        source = `${CLOUD}/api/balance`;
        const apiKey = opts.apiKey();
        if (!apiKey) { failure = "no-api-key"; throw new Error(failure); }
        response = await request(source, { headers: { Authorization: `Bearer ${apiKey}` } });
      } else {
        source = `${base.origin}/api/balance`;
        response = await request(source);
        if (response.status === 404) {
          // Older daemons have no balance proxy. Verify the local daemon and
          // this user's signed cloud account match before reading its balance.
          const localUserResponse = await request(`${base.origin}/api/me`, { method: "POST" });
          if (!localUserResponse.ok) { failure = "local-account-unavailable"; throw new Error(failure); }
          const localUser = record(await localUserResponse.json());
          failure = "local-key-unavailable";
          const privateKey = await (opts.readPrivateKey ?? readLocalPrivateKey)();
          const signed = (path: string, method: string) => {
            const queryPath = `${path}?ts=${Math.floor(now() / 1000)}`;
            return request(`${CLOUD}${queryPath}`, {
              method, headers: { Authorization: signOllamaRequest(privateKey, `${method},${queryPath}`) },
            });
          };
          failure = "cloud-account-unavailable";
          const cloudUserResponse = await signed("/api/me", "POST");
          if (!cloudUserResponse.ok) throw new Error(failure);
          const cloudUser = record(await cloudUserResponse.json());
          const localId = localUser?.id ?? localUser?.ID;
          const cloudId = cloudUser?.id ?? cloudUser?.ID;
          if ((typeof localId !== "string" && typeof localId !== "number")
              || String(localId) === "" || String(localId) !== String(cloudId)) {
            failure = "account-mismatch";
            throw new Error(failure);
          }
          source = `${CLOUD}/api/balance`;
          failure = "request-failed";
          response = await signed("/api/balance", "GET");
        }
      }
      if (!response.ok) { failure = `http-${response.status}`; throw new Error(failure); }
      const balance = parseOllamaBalance(await response.json());
      if (!balance) { failure = "unsupported-quota-format"; throw new Error(failure); }
      if (!stopped) current = { status: "known", source, checkedAt: now(), ...balance, resetsAt: balance.resetsAt };
    } catch {
      // Never publish upstream bodies, identity fields, file paths or auth errors.
      if (!stopped) current = {
        status: "unavailable", source, checkedAt: now(), resetsAt: null,
        reason: signal.aborted ? "request-timeout" : failure,
      };
    } finally {
      if (active === controller) active = null;
    }
  };

  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    pending = check().finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(() => { void refresh(); }, POLL_MS);
  timer.unref();
  queueMicrotask(() => { void refresh(); });
  return {
    snapshot() {
      if (current.status === "known" && current.checkedAt !== null && now() - current.checkedAt > STALE_MS) {
        return { status: "unavailable", source: current.source, checkedAt: current.checkedAt, resetsAt: null, reason: "stale" };
      }
      return { ...current, ...(current.balance ? { balance: { ...current.balance } } : {}) };
    },
    refresh,
    stop() { stopped = true; clearInterval(timer); active?.abort(); },
  };
}
