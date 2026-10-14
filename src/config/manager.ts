import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "fs";
import { randomBytes } from "crypto";
import { CONFIG_DIR, ACCOUNTS_PATH, CONFIG_PATH, SESSIONS_PATH } from "./paths.js";
import type { Account, AccountRecord } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS, ACCOUNT_USER_DEFAULTS, clampPercent } from "../proxy/types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";
import { DEFAULT_THROTTLE } from "../proxy/throttle.js";
import type { ThrottleConfig } from "../proxy/throttle.js";

export const DEFAULT_PROXY_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function accountsFileExists(path?: string): boolean {
  return existsSync(path ?? ACCOUNTS_PATH);
}

export function readAccountsRaw(): unknown[] {
  return readRawFromPath(ACCOUNTS_PATH);
}

function readRawFromPath(path: string): unknown[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

/** Deserialize Account[] from an explicit file path */
export function readAccountsFromPath(path: string): Account[] {
  return deserialize(readRawFromPath(path) as AccountRecord[]);
}

// Escritura atómica: escribe a .tmp y renombra — evita JSON corrupto si el proceso muere mid-write
/**
 * Session assignments survive a restart here. Without this the router forgets
 * which account each live conversation belongs to, reassigns it, and the whole
 * prompt cache is re-written into the new account — measured at 917K tokens
 * for a single session.
 */
export function readSessionAssignments(): unknown[] {
  try {
    const raw = readFileSync(SESSIONS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { sessions?: unknown[] };
    return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch {
    // Missing, unreadable or corrupt: start empty rather than fail to boot.
    return [];
  }
}

export function writeSessionAssignments(sessions: unknown[]): void {
  try {
    ensureConfigDir();
    const tmp = SESSIONS_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions }), "utf-8");
    renameSync(tmp, SESSIONS_PATH);
  } catch {
    // Losing the snapshot costs one round of reassignment, not correctness.
  }
}

export function writeAccountsAtomic(data: unknown[]): void {
  ensureConfigDir();
  writeAccountsAtomicToPath(ACCOUNTS_PATH, data);
}

function writeAccountsAtomicToPath(path: string, data: unknown[]): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function writeAnthropicAccountsPreservingOtherProviders(data: AccountRecord[]): void {
  ensureConfigDir();
  const existing = readAccountsRaw() as AccountRecord[];
  const nonAnthropic = existing.filter(a =>
    a.provider !== undefined && a.provider !== "anthropic_subscription"
  );
  writeAccountsAtomicToPath(ACCOUNTS_PATH, [...data, ...nonAnthropic]);
}

/**
 * Copy off the Anthropic records on disk that the running pool does not hold.
 *
 * The server's saves replace every Anthropic record with its in-memory pool, so
 * a record that reached disk by another route (a hand edit, an older CLI) is
 * destroyed by the next save with no trace. Calling this just before such a
 * save makes that loss recoverable: the records go to a sibling file, 0600 like
 * accounts.json itself. Returns where they went, or null if there was nothing
 * to keep.
 */
export function setAsideUnloadedAnthropicAccounts(
  loadedIds: readonly string[],
  path: string = ACCOUNTS_PATH,
): { file: string; ids: string[] } | null {
  const raw = readRawFromPath(path);
  if (!Array.isArray(raw)) return null;
  const loaded = new Set(loadedIds);
  const orphans = (raw as AccountRecord[]).filter(a =>
    (a.provider === undefined || a.provider === "anthropic_subscription") && !loaded.has(a.id),
  );
  if (orphans.length === 0) return null;

  const file = `${path}.unloaded-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  writeFileSync(file, JSON.stringify(orphans, null, 2), { encoding: "utf-8", mode: 0o600 });
  return { file, ids: orphans.map(a => a.id) };
}

export function upsertAccountRecord(record: AccountRecord): void {
  ensureConfigDir();
  const existing = readAccountsRaw() as AccountRecord[];
  const next = [
    ...existing.filter(a => !(a.id === record.id && a.provider === record.provider)),
    record,
  ];
  writeAccountsAtomicToPath(ACCOUNTS_PATH, next);
}

export function removeAccountRecordById(id: string): AccountRecord | null {
  ensureConfigDir();
  const existing = readAccountsRaw() as AccountRecord[];
  const removed = existing.find(a => a.id === id) ?? null;
  if (!removed) return null;

  writeAccountsAtomicToPath(ACCOUNTS_PATH, existing.filter(a => a.id !== id));
  return removed;
}

export type AccountProvider = "anthropic_subscription" | "openai_subscription";

function normalizeAccountProvider(record: AccountRecord): AccountProvider {
  return record.provider === "openai_subscription"
    ? "openai_subscription"
    : "anthropic_subscription";
}

export function migrateLegacyAccountProviders(path = ACCOUNTS_PATH): boolean {
  const records = readRawFromPath(path) as AccountRecord[];
  let changed = false;
  const migrated = records.map(record => {
    if (record.provider !== undefined) return record;
    changed = true;
    return { ...record, provider: "anthropic_subscription" as const };
  });
  if (changed) writeAccountsAtomicToPath(path, migrated);
  return changed;
}

export function setProviderAccountsEnabled(
  provider: AccountProvider,
  enabled: boolean,
  path = ACCOUNTS_PATH,
): number {
  const records = readRawFromPath(path) as AccountRecord[];
  let changed = 0;
  const next = records.map(record => {
    if (normalizeAccountProvider(record) !== provider) return record;
    changed++;
    return { ...record, provider: normalizeAccountProvider(record), enabled };
  });
  if (changed > 0) writeAccountsAtomicToPath(path, next);
  return changed;
}

/** Deserialize flat AccountRecord[] from the default path into runtime Account[] */
export function loadAccounts(): Account[] {
  return deserialize(readAccountsRaw() as AccountRecord[]);
}

/** Load OpenAI ChatGPT/Codex subscription accounts without mixing them into the Anthropic pool. */
export function loadOpenAIAccounts(path?: string): OpenAISubscriptionAccount[] {
  const records = readRawFromPath(path ?? ACCOUNTS_PATH) as AccountRecord[];
  return records
    .filter(a => a.provider === "openai_subscription")
    .map(a => ({
      id: a.id,
      provider: "openai_subscription" as const,
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      enabled: a.enabled !== false,
    }));
}

export function saveOpenAIAccounts(accounts: OpenAISubscriptionAccount[]): void {
  ensureConfigDir();
  const existing = readAccountsRaw() as AccountRecord[];
  const nonOpenAI = existing.filter(a => a.provider !== "openai_subscription");
  const records: AccountRecord[] = accounts.map(a => ({
    id: a.id,
    provider: "openai_subscription",
    accessToken: a.accessToken,
    refreshToken: a.refreshToken,
    expiresAt: a.expiresAt,
    scopes: ["openid", "profile", "email", "offline_access"],
    enabled: a.enabled,
  }));
  writeAccountsAtomicToPath(ACCOUNTS_PATH, [...nonOpenAI, ...records]);
}

// ─── Proxy config (password, future settings) ─────────────────────────────────

/**
 * Client mode config — when present, this machine is acting as a CLIENT to a
 * remote (or local) CC-Router instance instead of running its own proxy.
 * Claude Code's ANTHROPIC_BASE_URL points at `remoteUrl`; Claude Desktop
 * (optionally) is intercepted via mitmproxy and redirected to the same URL.
 */
export interface ClientConfig {
  /** Full URL of the CC-Router server, e.g. "http://192.168.1.50:3456" or "https://proxy.example.com" */
  remoteUrl: string;
  /** Optional Bearer secret for authenticating against the remote proxy */
  remoteSecret?: string;
  /** True once `cc-router client connect --desktop` has successfully provisioned mitmproxy */
  desktopEnabled?: boolean;
  /** True when the mitmproxy interceptor is installed as an OS service (auto-starts on boot) */
  desktopAutoStart?: boolean;
}

/** Persisted run preferences — asked once on first `cc-router start`, reused afterwards. */
export interface RunPreferences {
  /** How the proxy runs: foreground terminal, detached background, or OS-level auto-start service */
  mode: "foreground" | "background" | "service";
  /** Bind to 0.0.0.0 (true) vs 127.0.0.1 (false) — true when serving other devices on the network */
  serverMode: boolean;
  /** Port to listen on (default 3456) */
  port: number;
  /** Automatically configure Claude Code (~/.claude/settings.json) to use the proxy on start */
  configureClaudeCode?: boolean;
}

export interface ProxyConfig {
  proxySecret?: string;
  /** Upstream proxy request timeout in milliseconds. Default: 300000 (5 minutes). */
  proxyRequestTimeoutMs?: number;
  /** Deprecated typo-compatible alias for proxyRequestTimeoutMs. */
  proxyRequesTime?: number;
  /** Auto-update on patch/minor releases. Default: true (enabled). Set to false to disable. */
  /** Default and alias model routing for Claude and OpenAI subscription providers. */
  modelRouting?: ModelRoutingConfig;
  /** Opt-in automatic fallback: when every Anthropic account is exhausted, reroute
   *  a /v1/messages request to a healthy OpenAI subscription account instead of
   *  degrading. Requires modelRouting.openAIDefaultModel to be set. Default: false (disabled). */
  crossProviderFallback?: boolean;
  /** Pin each Claude Code session to one account so its prompt cache survives.
   *  Default: true. Sessions without the header keep plain round-robin. */
  sessionAffinity?: boolean;
  /** Let session assignment also hand whole sessions to an OpenAI subscription
   *  account, not just Anthropic ones. Off by default — it changes which model
   *  answers, so it must be opted into. Requires modelRouting.openAIDefaultModel. */
  sessionPoolIncludesOpenAI?: boolean;
  /** Opt-in request pacing / admission throttle. OFF by default: absent (or
   *  `enabled: false`) leaves the proxy's scheduling behavior byte-identical to
   *  no-throttle. When on, requests to an account are spaced out and their
   *  concurrency is capped as that account's quota utilization rises. This is
   *  scheduling only — it does not reduce token consumption. */
  throttle?: Partial<ThrottleConfig>;
  /** How the router prices moving a large session between accounts.
   *
   *  `holdOnCooldown` keeps a large session on its own account while that
   *  account is briefly cooling down, answering 429 + Retry-After instead of
   *  re-writing the whole prompt cache elsewhere. Default: true — it only ever
   *  delays a request that was going to be re-routed anyway.
   *
   *  `askClientToCompact` answers a 400 "prompt is too long" before an
   *  unavoidable move, so Claude Code compacts its own history and the move
   *  carries a small prefix. Default: FALSE. It deliberately induces client
   *  compaction, which is the one failure mode this whole area exists to avoid,
   *  and that the client compacts-and-retries rather than surfacing an error to
   *  the user rests on a single observation (2026-09-18). Opt in once that is
   *  confirmed on a long session; the flag exists so it can be switched off
   *  again without rebuilding a proxy that other machines depend on. */
  contextMigration?: {
    holdOnCooldown?: boolean;
    askClientToCompact?: boolean;
  };
  /** Session placement tuning. */
  routing?: {
    /** Utilization (0–1) at which an account stops taking new sessions and
     *  hands its pinned ones to an account with room — only while one exists.
     *  Opt-in: absent, or outside (0, 1), keeps placement as it was. */
    softCapUtil?: number;
  };
  /** Present only when this machine is in "client" mode (connected to a remote CC-Router) */
  client?: ClientConfig;
  /** Run preferences — asked once on first start, reused on subsequent starts */
  runPreferences?: RunPreferences;
}

export function readConfig(): ProxyConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProxyConfig;
  } catch (err) {
    console.warn(`Warning: ${CONFIG_PATH} contains invalid JSON: ${(err as Error).message}`);
    try {
      const backupPath = CONFIG_PATH + ".bak";
      copyFileSync(CONFIG_PATH, backupPath);
      console.warn(`  Backup saved to ${backupPath}`);
    } catch { /* best-effort backup */ }
    console.warn(`  Using default configuration for this session.`);
    return {};
  }
}

export function getProxyRequestTimeoutMs(): number {
  const { proxyRequestTimeoutMs, proxyRequesTime } = readConfig();
  const timeoutMs = proxyRequestTimeoutMs ?? proxyRequesTime;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_PROXY_REQUEST_TIMEOUT_MS;
}

/**
 * Resolve the throttle settings, merged over `DEFAULT_THROTTLE` and normalized.
 * Absent config yields a disabled throttle with the documented defaults, so the
 * proxy's behavior is unchanged until an operator opts in. config.json is
 * hand-editable, so every field is coerced: a stray string/null must not become
 * NaN, an instant timeout, or an unbounded wait.
 */
export function getThrottleConfig(): ThrottleConfig {
  const raw = readConfig().throttle ?? {};
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = (value: unknown, fallback: number, min: number, max: number): number =>
    Math.min(Math.max(num(value, fallback), min), max);

  const startUtil = clamped(raw.startUtil, DEFAULT_THROTTLE.startUtil, 0, 1);
  const hardUtil = clamped(raw.hardUtil, DEFAULT_THROTTLE.hardUtil, 0, 1);
  // A degenerate range would make the ramp divide by zero; treat it as an
  // operator error and fall back to the pair of documented defaults.
  const rampValid = hardUtil > startUtil;
  return {
    enabled: raw.enabled === true,
    perAccountMaxInFlight: Math.max(0, num(raw.perAccountMaxInFlight, DEFAULT_THROTTLE.perAccountMaxInFlight)),
    startUtil: rampValid ? startUtil : DEFAULT_THROTTLE.startUtil,
    hardUtil: rampValid ? hardUtil : DEFAULT_THROTTLE.hardUtil,
    maxWaitMs: Math.max(0, num(raw.maxWaitMs, DEFAULT_THROTTLE.maxWaitMs)),
    pollMaxDelayMs: Math.max(0, num(raw.pollMaxDelayMs, DEFAULT_THROTTLE.pollMaxDelayMs)),
    minIntervalMs: Math.max(0, num(raw.minIntervalMs, DEFAULT_THROTTLE.minIntervalMs)),
    logSaturation: raw.logSaturation === false ? false : DEFAULT_THROTTLE.logSaturation,
  };
}

/**
 * The session soft cap, or undefined when it is off. config.json is
 * hand-editable, so anything that is not a number strictly between 0 and 1 —
 * including a percent like 90 — reads as off rather than as a cap that would
 * evict every account.
 */
export function getSoftCapUtil(): number | undefined {
  const v = readConfig().routing?.softCapUtil;
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1 ? v : undefined;
}

function normalizeProxyConfig(cfg: ProxyConfig): ProxyConfig {
  const { proxyRequesTime, ...normalized } = cfg;
  const timeoutMs = normalized.proxyRequestTimeoutMs ?? proxyRequesTime;
  normalized.proxyRequestTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_PROXY_REQUEST_TIMEOUT_MS;
  return normalized;
}

export function writeConfig(cfg: ProxyConfig): void {
  ensureConfigDir();
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(normalizeProxyConfig(cfg), null, 2), "utf-8");
  renameSync(tmp, CONFIG_PATH);
}

export function generateProxySecret(): string {
  return "cc-rtr-" + randomBytes(16).toString("hex");
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

function deserialize(records: AccountRecord[]): Account[] {
  return records.filter(a => a.provider === undefined || a.provider === "anthropic_subscription").map(a => ({
    id: a.id,
    tokens: {
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      scopes: a.scopes ?? ["user:inference", "user:profile"],
    },
    healthy: true,
    busy: false,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
    rateLimits: { ...DEFAULT_RATE_LIMITS },
    enabled: a.enabled !== false,                         // default true
    sessionLimitPercent: a.sessionLimitPercent !== undefined
      ? clampPercent(a.sessionLimitPercent)
      : ACCOUNT_USER_DEFAULTS.sessionLimitPercent,
    weeklyLimitPercent: a.weeklyLimitPercent !== undefined
      ? clampPercent(a.weeklyLimitPercent)
      : ACCOUNT_USER_DEFAULTS.weeklyLimitPercent,
  }));
}

/** Serialize runtime Account[] back to the flat on-disk AccountRecord[] shape. */
export function serialize(accounts: Account[]): AccountRecord[] {
  return accounts.map(a => ({
    id: a.id,
    provider: "anthropic_subscription",
    accessToken: a.tokens.accessToken,
    refreshToken: a.tokens.refreshToken,
    expiresAt: a.tokens.expiresAt,
    scopes: a.tokens.scopes,
    enabled: a.enabled,
    sessionLimitPercent: a.sessionLimitPercent,
    weeklyLimitPercent: a.weeklyLimitPercent,
  }));
}
