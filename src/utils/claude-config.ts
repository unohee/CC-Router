import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { CLAUDE_SETTINGS_PATH } from "../config/paths.js";
import { readConfig } from "../config/manager.js";

/**
 * Write ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN into ~/.claude/settings.json.
 *
 * Rules from official Claude Code docs:
 *   - ANTHROPIC_AUTH_TOKEN is sent as "Authorization: Bearer <value>"
 *   - Do NOT append /v1 to ANTHROPIC_BASE_URL — Claude Code adds it automatically
 *   - Merges with existing settings, preserving all other keys
 */
/**
 * @param port - proxy port (used only when baseUrl is not provided)
 * @param baseUrl - full proxy URL e.g. "http://192.168.1.50:3456" or "https://cc-router.example.com"
 *                  If omitted, defaults to http://localhost:<port>
 * @param authToken - explicit auth token; when omitted, reads proxySecret from config or uses "proxy-managed"
 * @param defaultModel - optional Claude Code model, e.g. "openai/default"
 */
export function writeClaudeSettings(port: number, baseUrl?: string, authToken?: string, defaultModel?: string): void {
  const dir = dirname(CLAUDE_SETTINGS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      existing = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
    } catch {
      existing = {};
    }
  }

  const existingEnv = (existing["env"] as Record<string, unknown>) ?? {};
  // ANTHROPIC_BASE_URL: no trailing /v1 — Claude Code appends it automatically
  const resolvedUrl = baseUrl ?? `http://localhost:${port}`;

  const updated = {
    ...existing,
    ...(defaultModel ? { model: defaultModel } : {}),
    env: {
      ...existingEnv,
      ANTHROPIC_BASE_URL: resolvedUrl,
      // ANTHROPIC_AUTH_TOKEN has higher precedence than ANTHROPIC_API_KEY in Claude Code.
      // Explicit authToken wins (client mode points at a remote secret); otherwise
      // uses the local proxy secret, or the open placeholder if neither is set.
      ANTHROPIC_AUTH_TOKEN: authToken ?? readConfig().proxySecret ?? "proxy-managed",
    },
  };

  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(updated, null, 2), "utf-8");
}

/**
 * Remove cc-router settings from ~/.claude/settings.json.
 * Called when uninstalling cc-router so Claude Code goes back to its default auth.
 */
export function removeClaudeSettings(): void {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return;
  try {
    const existing = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    const env = existing["env"] as Record<string, unknown> | undefined;
    if (env) {
      delete env["ANTHROPIC_BASE_URL"];
      delete env["ANTHROPIC_AUTH_TOKEN"];
      // Only meaningful against the router's pool 429; see setRetryWatchdog.
      delete env[RETRY_WATCHDOG_ENV];
      if (Object.keys(env).length === 0) delete existing["env"];
    }
    writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(existing, null, 2), "utf-8");
  } catch {
    // If we can't parse it, leave it alone
  }
}

export const RETRY_WATCHDOG_ENV = "CLAUDE_CODE_RETRY_WATCHDOG";

/**
 * Opt in to (or out of) Claude Code's retry watchdog in ~/.claude/settings.json.
 *
 * When every account is limited the router answers 429 with Retry-After set to
 * the earliest reset in the pool. Without the watchdog Claude Code gives up on
 * a Retry-After above 60s; with it, the client keeps retrying until an account
 * is free again. Other env keys and settings are left untouched.
 */
export function setRetryWatchdog(enabled: boolean): void {
  const dir = dirname(CLAUDE_SETTINGS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      existing = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
    } catch {
      // Refuse to overwrite a file we cannot parse.
      throw new Error(`Cannot parse ${CLAUDE_SETTINGS_PATH}; fix it before changing the retry watchdog.`);
    }
  }

  const env = { ...((existing["env"] as Record<string, unknown>) ?? {}) };
  if (enabled) env[RETRY_WATCHDOG_ENV] = "1";
  else delete env[RETRY_WATCHDOG_ENV];

  const updated: Record<string, unknown> = { ...existing, env };
  if (Object.keys(env).length === 0) delete updated["env"];
  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(updated, null, 2), "utf-8");
}

/** Read whether the retry watchdog is enabled in ~/.claude/settings.json. */
export function readRetryWatchdog(): boolean {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return false;
  try {
    const raw = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    const env = raw["env"] as Record<string, unknown> | undefined;
    return env?.[RETRY_WATCHDOG_ENV] === "1";
  } catch {
    return false;
  }
}

/** Read current Claude Code proxy settings (for display) */
export function readClaudeProxySettings(): { baseUrl?: string; authToken?: string; model?: string } {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    const env = raw["env"] as Record<string, unknown> | undefined;
    if (!env) return {};
    return {
      baseUrl: env?.["ANTHROPIC_BASE_URL"] as string | undefined,
      authToken: env?.["ANTHROPIC_AUTH_TOKEN"] as string | undefined,
      model: raw["model"] as string | undefined,
    };
  } catch {
    return {};
  }
}
