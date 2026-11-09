import type { Account, OAuthTokens } from "../proxy/types.js";
import type { OAuthProfile } from "../utils/oauth-profile.js";
import type { RouterEdit, RouterProbe } from "./live-router.js";

/**
 * Replace one seat's credentials after a fresh login.
 *
 * The login itself is done by the real `claude auth login` (see `loginWithClaude`
 * in cmd-accounts.ts): the router never performs or imitates the OAuth/PKCE
 * exchange. This function only decides whether the resulting tokens may take
 * the seat's place, and puts them there.
 */

export interface ReloginOptions {
  id: string;
  /** Substring the logged-in email must contain; a mismatch aborts. */
  expect?: string;
  /** Skip the confirmation (needed when there is no terminal). */
  yes?: boolean;
}

export interface ReloginDeps {
  probe: () => Promise<RouterProbe>;
  /** IDs the target (live router or accounts.json) knows. */
  knownIds: (probe: RouterProbe) => Promise<string[]>;
  /** Obtain fresh tokens (login, or read a directory / the Keychain). */
  obtainTokens: () => Promise<OAuthTokens | null>;
  fetchProfile: (accessToken: string) => Promise<OAuthProfile | null>;
  describe: (p: OAuthProfile) => string;
  /** Ask a person; absent when there is no terminal. */
  confirm?: (message: string) => Promise<boolean>;
  replaceLive: (probe: Extract<RouterProbe, { state: "live" }>, account: Account) => Promise<RouterEdit>;
  replaceInFile: (id: string, tokens: OAuthTokens) => void;
  /** Called once the seat has been replaced, to remove what the login left behind. */
  cleanup: () => void;
  log: (line: string) => void;
}

export type ReloginResult =
  | { ok: true; id: string; identity: string; via: "router" | "file" }
  | { ok: false; reason: string };

export async function reloginSeat(
  opts: ReloginOptions,
  deps: ReloginDeps,
  makeAccount: (id: string, tokens: OAuthTokens) => Account,
): Promise<ReloginResult> {
  const probe = await deps.probe();
  if (probe.state === "unreachable") {
    return { ok: false, reason: `A router seems to be running but did not answer: ${probe.reason}. Nothing was changed.` };
  }

  const known = await deps.knownIds(probe);
  if (!known.includes(opts.id)) {
    return { ok: false, reason: `No account "${opts.id}" (known: ${known.join(", ") || "none"}). Use "accounts add" for a new seat.` };
  }

  const tokens = await deps.obtainTokens();
  if (!tokens) return { ok: false, reason: "No credentials were found after the login." };

  const profile = await deps.fetchProfile(tokens.accessToken);
  if (!profile) return { ok: false, reason: "The new token was refused by Anthropic's profile endpoint; nothing was changed." };
  const identity = deps.describe(profile);
  deps.log(`  Logged in as: ${identity}`);

  if (opts.expect && !(profile.email ?? "").toLowerCase().includes(opts.expect.toLowerCase())) {
    return { ok: false, reason: `Logged-in account (${identity}) does not match --expect "${opts.expect}". Nothing was changed.` };
  }
  if (!opts.yes) {
    if (!deps.confirm) {
      return { ok: false, reason: `Check that "${identity}" is the "${opts.id}" seat, then re-run with --yes (or --expect <email>). Nothing was changed.` };
    }
    if (!(await deps.confirm(`Replace "${opts.id}" with ${identity}?`))) {
      return { ok: false, reason: "Cancelled. Nothing was changed." };
    }
  }

  if (probe.state === "live") {
    const result = await deps.replaceLive(probe, makeAccount(opts.id, tokens));
    if (!result.ok) return { ok: false, reason: `The router rejected the replacement: HTTP ${result.status} ${result.message}` };
    deps.cleanup();
    return { ok: true, id: opts.id, identity, via: "router" };
  }

  deps.replaceInFile(opts.id, tokens);
  deps.cleanup();
  return { ok: true, id: opts.id, identity, via: "file" };
}
