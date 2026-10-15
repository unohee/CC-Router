/**
 * Opt-in refusal of named clients, decided before any account is chosen.
 *
 * The accounts behind this router are subscription OAuth tokens, and upstream
 * only accepts requests on them that identify as Claude Code. A client that
 * does not (omp is one: it adds that identification only when its own key is an
 * OAuth token, and behind the router its key is the router secret) is answered
 * with a header-less 429. The router cannot tell that from a quota problem, so
 * it cooled the account the request landed on, rotated the retry to the next
 * account, and cooled that one too. One such client could take the whole pool
 * out from under every Claude Code session.
 *
 * Refusing the client here, with a message that says why, costs no account and
 * no upstream call, and the client learns what is wrong instead of retrying.
 */

/**
 * Turn the raw `blockedUserAgents` config value into usable patterns.
 *
 * config.json is hand-edited, so anything that is not a non-empty string is
 * dropped rather than trusted. An empty pattern in particular must never
 * survive: as a prefix it would match every client and lock out all traffic.
 */
export function normalizeBlockedUserAgents(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const pattern = item.trim();
    if (pattern !== "") out.push(pattern);
  }
  return out;
}

/**
 * The configured pattern the User-Agent starts with, or null when none does.
 *
 * Case-insensitive prefix match. A prefix, not a substring, so a pattern such
 * as "omp/" cannot catch an unrelated client that merely mentions it, and a
 * short pattern cannot accidentally match Claude Code's own "claude-cli/...".
 */
export function matchBlockedUserAgent(
  userAgent: string | undefined,
  patterns: readonly string[],
): string | null {
  if (!userAgent || patterns.length === 0) return null;
  const ua = userAgent.trimStart().toLowerCase();
  for (const pattern of patterns) {
    if (pattern !== "" && ua.startsWith(pattern.toLowerCase())) return pattern;
  }
  return null;
}

/** The Anthropic-shaped error a blocked client receives. */
export function blockedClientError(pattern: string): { type: "error"; error: { type: string; message: string } } {
  return {
    type: "error",
    error: {
      type: "permission_error",
      message:
        `This client is blocked by the router (blockedUserAgents: "${pattern}"). The accounts behind this router `
        + "only accept requests from Claude Code, so the request would be refused upstream. "
        + "Connect this client to its own credentials instead of the router.",
    },
  };
}

/**
 * Lets the first block through per client and swallows the repeats.
 *
 * A refused client typically retries every few seconds. Logging each one would
 * fill the console and, worse, push real events out of the dashboard's short
 * activity list. Returns how many were swallowed since the last logged one so
 * the next line can say so.
 */
export function createBlockLogGate(intervalMs = 10_000): (key: string, now?: number) => { log: boolean; suppressed: number } {
  const state = new Map<string, { lastLogged: number; suppressed: number }>();
  return (key, now = Date.now()) => {
    const entry = state.get(key);
    if (!entry || now - entry.lastLogged >= intervalMs) {
      const suppressed = entry?.suppressed ?? 0;
      state.set(key, { lastLogged: now, suppressed: 0 });
      return { log: true, suppressed };
    }
    entry.suppressed++;
    return { log: false, suppressed: 0 };
  };
}
