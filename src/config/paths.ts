import os from "os";
import path from "path";

// All paths support env var overrides so Docker can inject them via environment
export const CONFIG_DIR = path.join(os.homedir(), ".cc-router");

export const ACCOUNTS_PATH =
  process.env["ACCOUNTS_PATH"] ??
  path.join(CONFIG_DIR, "accounts.json");

/**
 * Session -> account assignments, so they survive a restart. Overridable for
 * the same reason as ACCOUNTS_PATH: a container has no ~/.cc-router, so a bind
 * mount alone would be written past.
 */
export const SESSIONS_PATH =
  process.env["SESSIONS_PATH"] ??
  path.join(CONFIG_DIR, "sessions.json");

/**
 * Hourly token usage history, so the dashboard can show more than the current
 * process's totals. Defaults to sit beside accounts.json rather than at a fixed
 * ~/.cc-router path: anything that already points ACCOUNTS_PATH somewhere
 * disposable (a container volume, a test's temp directory) then gets its usage
 * file there too, instead of writing into the real config directory.
 */
export const USAGE_PATH =
  // `||`, not `??`: an empty USAGE_PATH (an ENV line with no value) would
  // otherwise be taken as the path "", and the save would then write ".tmp"
  // into whatever directory the process happens to be in.
  process.env["USAGE_PATH"] ||
  path.join(path.dirname(ACCOUNTS_PATH), "usage.json");

/** Ollama daily-budget spend, so a restart does not reset the day. */
export const OLLAMA_BUDGET_PATH =
  process.env["OLLAMA_BUDGET_PATH"] ??
  path.join(path.dirname(ACCOUNTS_PATH), "ollama-budget.json");

export const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

export const PROXY_PORT = parseInt(process.env["PORT"] ?? "3456", 10);
export const LITELLM_PORT = 4000;

// When set, the server forwards to LiteLLM instead of Anthropic directly
export const LITELLM_URL = process.env["LITELLM_URL"];

// Proxy-level config (password, future settings) — separate from accounts.json
export const CONFIG_PATH =
  process.env["CONFIG_PATH"] ??
  path.join(CONFIG_DIR, "config.json");

// Daemon PID file — written by daemon process, read by stop/status
export const PID_PATH = path.join(CONFIG_DIR, "cc-router.pid");

// Log file — daemon stdout/stderr redirect here
export const LOG_PATH = path.join(CONFIG_DIR, "cc-router.log");
