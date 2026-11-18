import { execFileSync } from "node:child_process";

/**
 * Claude Code keeps its account login and its MCP server logins (`mcpOAuth`) in
 * the same Keychain item. Deleting the item to drop a login therefore also
 * signs the user out of every MCP server, so only the account part is removed.
 */
export const KEYCHAIN_SERVICE = "Claude Code-credentials";

export type KeychainRewrite =
  /** Nothing but the account login was stored: the item can go. */
  | { action: "delete" }
  /** Other entries share the item: write this back. */
  | { action: "rewrite"; json: string }
  /** No account login in it, or unreadable: leave it alone. */
  | { action: "keep" };

/** Decide what to do with the item's JSON once `claudeAiOauth` is taken out. Pure. */
export function withoutAccountLogin(raw: string): KeychainRewrite {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { action: "keep" };
    obj = parsed as Record<string, unknown>;
  } catch {
    return { action: "keep" };
  }
  if (!("claudeAiOauth" in obj)) return { action: "keep" };
  const { claudeAiOauth: _removed, ...rest } = obj;
  return Object.keys(rest).length === 0 ? { action: "delete" } : { action: "rewrite", json: JSON.stringify(rest) };
}

/**
 * Remove the account login from the default Keychain item, keeping everything
 * else in it. Returns what was done, for the caller to report.
 */
export function removeAccountLoginFromKeychain(): "deleted" | "rewritten" | "kept" {
  let raw: string;
  let account: string | undefined;
  try {
    raw = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf-8" }).trim();
    const attrs = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], { encoding: "utf-8" });
    account = /"acct"<blob>="([^"]*)"/.exec(attrs)?.[1];
  } catch {
    return "kept";
  }
  const plan = withoutAccountLogin(raw);
  if (plan.action === "keep") return "kept";
  if (plan.action === "delete") {
    execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE], { stdio: "ignore" });
    return "deleted";
  }
  const args = ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, ...(account ? ["-a", account] : []), "-w", plan.json];
  execFileSync("security", args, { stdio: "ignore" });
  return "rewritten";
}
