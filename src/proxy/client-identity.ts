/**
 * Whether a request carries Claude Code's identity.
 *
 * Judged from the headers the router forwards, as the 2026-10-15 controlled
 * probes showed upstream judges them: a `user-agent` starting `claude-cli/`, or
 * an `anthropic-beta` naming a `claude-code-` beta. The router only reads this.
 * It never adds identity to a request that lacks it.
 *
 * It matters for bare 429s. Upstream refuses a request without the identity
 * with a 429 that says nothing about quota, and cooling the account for it
 * would rotate one client's refusals through every account in the pool.
 */
export function hasClaudeCodeIdentity(headers: Record<string, string | string[] | undefined>): boolean {
  const first = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  if (first(headers["user-agent"]).some(ua => ua.trim().toLowerCase().startsWith("claude-cli/"))) return true;
  return first(headers["anthropic-beta"])
    .flatMap(v => v.split(","))
    .some(b => b.trim().toLowerCase().startsWith("claude-code-"));
}
