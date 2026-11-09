import type { Command } from "commander";
import chalk from "chalk";
import { loadAccounts, loadOpenAIAccounts, accountsFileExists, upsertAccountRecord, removeAccountRecordById } from "../config/manager.js";
import { saveAccounts } from "../proxy/token-refresher.js";
import { formatExpiry, redactToken } from "../utils/token-extractor.js";
import { PROXY_PORT } from "../config/paths.js";
import { probeRouter, addAccountToRouter, removeAccountFromRouter, replaceAccountInRouter, listLiveAccounts } from "./live-router.js";
import { reloginSeat } from "./relogin.js";
import { extractFromCredentialsDir, extractFromKeychain } from "../utils/token-extractor.js";
import { fetchOAuthProfile, describeProfile } from "../utils/oauth-profile.js";
import { DEFAULT_RATE_LIMITS, ACCOUNT_USER_DEFAULTS } from "../proxy/types.js";
import { spawnSync } from "node:child_process";
import { removeAccountLoginFromKeychain } from "../utils/keychain-login.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { createOpenAIAccountRecord } from "../providers/openai/account-record.js";
import { loginOpenAIWithDeviceCode } from "../providers/openai/device-oauth.js";
import type { Account } from "../proxy/types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

export function registerAccounts(program: Command): void {
  const accounts = program
    .command("accounts")
    .description("Manage Claude Max accounts in the token pool");

  // ── accounts list ────────────────────────────────────────────────────────
  accounts
    .command("list")
    .description("List all configured accounts and their status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      // Try to get live stats from the running proxy first
      const liveStats = await fetchLiveStats();

      if (!accountsFileExists()) {
        console.log(chalk.yellow("No accounts configured. Run: cc-router setup"));
        return;
      }

      const stored = loadAccounts();
      const openAIStored = loadOpenAIAccounts();
      if (stored.length === 0 && openAIStored.length === 0) {
        console.log(chalk.yellow("accounts.json is empty. Run: cc-router setup"));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(liveStats ?? buildStoredAccountsJson(stored, openAIStored), null, 2));
        return;
      }

      console.log(chalk.bold(`\n  Accounts (${stored.length + openAIStored.length} configured)\n`));

      if (liveStats) {
        console.log(chalk.green("  ● Proxy is running — showing live stats\n"));
        for (const s of liveStats) {
          const provider = s.provider === "openai_subscription"
            ? chalk.cyan("openai".padEnd(9))
            : chalk.gray("claude".padEnd(9));
          const status = s.healthy
            ? chalk.green("✓ healthy")
            : chalk.red("✗ unhealthy");
          const busy = s.busy ? chalk.yellow(" [busy]") : "";
          const exp = s.expiresInMs > 0
            ? chalk.yellow(formatMs(s.expiresInMs))
            : chalk.red("EXPIRED");
          console.log(
            `  ${chalk.bold(s.id.padEnd(24))}` +
            `  ${provider}` +
            `  ${status}${busy}` +
            `  requests: ${chalk.cyan(String(s.requestCount).padStart(5))}` +
            `  errors: ${chalk.red(String(s.errorCount).padStart(3))}` +
            `  expires: ${exp}`
          );
        }
      } else {
        console.log(chalk.gray("  (Proxy not running — showing stored configuration)\n"));
        for (const a of stored) {
          const exp = formatExpiry(a.tokens.expiresAt);
          const expColor = a.tokens.expiresAt > Date.now()
            ? chalk.yellow(exp)
            : chalk.red(exp);
          console.log(
            `  ${chalk.bold(a.id.padEnd(24))}` +
            `  ${redactToken(a.tokens.accessToken).padEnd(26)}` +
            `  expires: ${expColor}` +
            `  scopes: ${chalk.gray(a.tokens.scopes.join(" "))}`
          );
        }
        for (const a of openAIStored) {
          const exp = a.expiresAt > Date.now()
            ? chalk.yellow(formatExpiry(a.expiresAt))
            : chalk.red("EXPIRED");
          console.log(
            `  ${chalk.bold(a.id.padEnd(24))}` +
            `  ${chalk.magenta("openai".padEnd(10))}` +
            `  ${redactToken(a.accessToken).padEnd(26)}` +
            `  expires: ${exp}`
          );
        }
      }

      console.log();
    });

  // ── accounts add ─────────────────────────────────────────────────────────
  accounts
    .command("add")
    .description("Add a new Claude Max account interactively")
    .action(async () => {
      const { setupSingleAccount } = await import("./cmd-setup.js");

      // A running router owns accounts.json: it rewrites every Anthropic record
      // from its in-memory pool on each refresh and on shutdown. Writing the file
      // here would hand the new account to the next such save to delete, so when
      // a router is up the account goes in through its API instead.
      const probe = await probeRouter(PROXY_PORT);
      if (probe.state === "unreachable") {
        console.error(chalk.red(`\n✗ A router seems to be running but its API did not answer.`));
        console.error(chalk.gray(`  ${probe.reason}`));
        console.error(chalk.gray("  Adding to accounts.json now would be undone when it next saves."));
        console.error(chalk.gray("  Stop it (cc-router stop) and re-run, or fix the API first.\n"));
        process.exitCode = 1;
        return;
      }

      const existing = accountsFileExists() ? loadAccounts() : [];
      const account = await setupSingleAccount(existing.length + 1);

      if (!account) {
        console.log(chalk.yellow("\nNo account added.\n"));
        return;
      }

      if (probe.state === "live") {
        const result = await addAccountToRouter(probe.router, account);
        if (!result.ok) {
          console.error(chalk.red(`\n✗ The running router rejected "${account.id}": HTTP ${result.status}`));
          console.error(chalk.gray(`  ${result.message}`));
          console.error(chalk.gray("  Nothing was written — the account was not added.\n"));
          process.exitCode = 1;
          return;
        }
        const total = (await listLiveAccounts(probe.router).catch(() => [])).length;
        console.log(chalk.green(`\n✓ Account "${account.id}" added to the running router${total ? ` (${total} total)` : ""}.\n`));
        console.log(chalk.gray("  It is in the pool and on disk. No restart needed.\n"));
        return;
      }

      // Merge: replace by ID if already exists, otherwise append
      const merged = [
        ...existing.filter(a => a.id !== account.id),
        account,
      ];

      saveAccounts(merged);
      console.log(chalk.green(`\n✓ Account "${account.id}" added (${merged.length} total).\n`));
      console.log(chalk.gray("  Start the proxy to load it: cc-router start\n"));
    });

  // ── accounts relogin ─────────────────────────────────────────────────────
  accounts
    .command("relogin <id>")
    .description("Replace a seat whose refresh token was refused, after a fresh login (keeps pins and caps)")
    .option("--from-dir <dir>", "Read the login from a Claude config directory instead of running one")
    .option("--from-keychain", "macOS: use the default Keychain login, then remove the account login from it so nothing else can rotate the token")
    .option("--expect <text>", "Abort unless the logged-in email contains this text")
    .option("-y, --yes", "Do not ask for confirmation (needed without a terminal)")
    .action(async (id: string, flags: { fromDir?: string; fromKeychain?: boolean; expect?: string; yes?: boolean }) => {
      let tempDir: string | undefined;
      const obtainTokens = async () => {
        if (flags.fromDir) return extractFromCredentialsDir(flags.fromDir);
        if (flags.fromKeychain) return extractFromKeychain();
        // A throwaway config dir keeps this login from touching, or being
        // refreshed by, the login the machine normally uses. The real `claude`
        // does the OAuth/PKCE exchange; run it over ssh and open its URL anywhere.
        tempDir = mkdtempSync(join(tmpdir(), "cc-router-relogin-"));
        const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: tempDir };
        for (const k of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[k];
        console.log(chalk.gray(`  Running: claude auth login  (config dir ${tempDir})`));
        const run = spawnSync("claude", ["auth", "login"], { stdio: "inherit", env });
        if (run.error || run.status !== 0) {
          console.error(chalk.red(`  claude auth login failed${run.error ? `: ${run.error.message}` : ` (exit ${run.status})`}`));
          return null;
        }
        const tokens = extractFromCredentialsDir(tempDir);
        if (!tokens && process.platform === "darwin") {
          console.error(chalk.yellow("  On macOS the login is kept in the Keychain, not in a file. Log in on the server (ssh), or use --from-keychain."));
        }
        return tokens;
      };

      const result = await reloginSeat(
        { id, expect: flags.expect, yes: flags.yes },
        {
          probe: () => probeRouter(PROXY_PORT),
          knownIds: async (probe) =>
            probe.state === "live"
              ? (await listLiveAccounts(probe.router)).filter(a => a.provider === "anthropic_subscription").map(a => a.id)
              : (accountsFileExists() ? loadAccounts() : []).map(a => a.id),
          obtainTokens,
          fetchProfile: fetchOAuthProfile,
          describe: describeProfile,
          confirm: process.stdin.isTTY ? (message) => confirm({ message, default: false }) : undefined,
          replaceLive: (probe, account) => replaceAccountInRouter(probe.router, account),
          replaceInFile: (seat, tokens) => {
            const all = loadAccounts();
            saveAccounts(all.map(a => a.id === seat
              ? { ...a, tokens, healthy: true, consecutiveErrors: 0, authState: "ok" as const }
              : a));
          },
          cleanup: () => {
            if (tempDir) rmSync(tempDir, { recursive: true, force: true });
            if (flags.fromKeychain) {
              // Only the account login goes; MCP server logins share that Keychain item.
              const done = removeAccountLoginFromKeychain();
              if (done !== "kept") console.log(chalk.gray("  Removed the account login from the Keychain (the router now owns this refresh token); MCP logins were left in place."));
            }
          },
          log: (line) => console.log(line),
        },
        (seat, tokens): Account => ({
          id: seat, tokens, healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0,
          lastRefresh: 0, consecutiveErrors: 0, rateLimits: { ...DEFAULT_RATE_LIMITS }, ...ACCOUNT_USER_DEFAULTS,
        }),
      );

      // A login that did not end in a replacement still left a credentials directory behind.
      if (!result.ok && tempDir) rmSync(tempDir, { recursive: true, force: true });
      if (!result.ok) {
        console.error(chalk.red(`\n✗ ${result.reason}\n`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(`\n✓ "${result.id}" replaced (${result.identity}) ${result.via === "router" ? "in the running router" : "in accounts.json"}.\n`));
    });

  // ── accounts add-openai ──────────────────────────────────────────────────
  accounts
    .command("add-openai")
    .description("Add an OpenAI ChatGPT/Codex subscription account manually")
    .action(async () => {
      const { input, password } = await import("@inquirer/prompts");

      const id = await input({
        message: "OpenAI account ID:",
        default: `openai-account-${loadOpenAIAccounts().length + 1}`,
        validate: (v) => /^[a-zA-Z0-9_-]+$/.test(v) || "Only letters, numbers, _ and - allowed",
      });
      const accessToken = await password({
        message: "OpenAI access token:",
        mask: "*",
        validate: (v) => v.trim().length > 0 || "Access token is required",
      });
      const refreshToken = await password({
        message: "OpenAI refresh token:",
        mask: "*",
        validate: (v) => v.trim().length > 0 || "Refresh token is required",
      });
      const expiresAt = await input({
        message: "Access token expiry (Unix ms):",
        default: String(Date.now() + 60 * 60 * 1000),
        validate: (v) => Number.isFinite(Number(v)) && Number(v) > 0 || "Enter a positive Unix timestamp in milliseconds",
      });
      const scopes = await input({
        message: "Scopes:",
        default: "openid profile email offline_access",
      });

      const record = createOpenAIAccountRecord({
        id,
        accessToken,
        refreshToken,
        expiresAt,
        scopes,
      });
      upsertAccountRecord(record);

      console.log(chalk.green(`\n✓ OpenAI account "${record.id}" saved.\n`));
      console.log(chalk.gray("  Restart the proxy to load the new account: cc-router start\n"));
      console.log(chalk.yellow("  Treat this as experimental until the OAuth login wizard lands.\n"));
    });

  // ── accounts login-openai ────────────────────────────────────────────────
  accounts
    .command("login-openai")
    .description("Sign in to an OpenAI ChatGPT/Codex subscription account with device code")
    .action(async () => {
      const { input } = await import("@inquirer/prompts");
      const accountId = await input({
        message: "OpenAI account ID:",
        default: `openai-account-${loadOpenAIAccounts().length + 1}`,
        validate: (v) => /^[a-zA-Z0-9_-]+$/.test(v) || "Only letters, numbers, _ and - allowed",
      });

      console.log(chalk.cyan("\nOpenAI Codex device login"));
      console.log(chalk.gray("This will open no local callback server. You will approve the login in your browser.\n"));

      const record = await loginOpenAIWithDeviceCode({
        accountId,
        onDeviceCode: (code) => {
          console.log(chalk.bold("1. Open this URL:"));
          console.log(`   ${chalk.cyan(code.verificationUrl)}`);
          console.log(chalk.bold("2. Enter this code:"));
          console.log(`   ${chalk.cyan(code.userCode)}\n`);
          console.log(chalk.gray("Waiting for authorization..."));
        },
      });

      upsertAccountRecord(record);

      console.log(chalk.green(`\n✓ OpenAI account "${record.id}" saved via device login.\n`));
      console.log(chalk.gray("  Restart the proxy to load the new account: cc-router start\n"));
    });

  // ── accounts remove ───────────────────────────────────────────────────────
  accounts
    .command("remove <id>")
    .description("Remove an account by its ID")
    .action(async (id: string) => {
      if (!accountsFileExists()) {
        console.log(chalk.yellow("No accounts configured."));
        return;
      }

      const anthropicAccounts = loadAccounts();
      const openAIAccounts = loadOpenAIAccounts();
      const existingIds = [
        ...anthropicAccounts.map(a => a.id),
        ...openAIAccounts.map(a => a.id),
      ];

      if (!existingIds.includes(id)) {
        console.log(chalk.red(`✗ Account "${id}" not found.`));
        console.log(chalk.gray(`  Available: ${existingIds.join(", ")}`));
        process.exit(1);
      }

      const { confirm } = await import("@inquirer/prompts");
      const sure = await confirm({
        message: `Remove "${id}"? This cannot be undone.`,
        default: false,
      });
      if (!sure) { console.log(chalk.gray("Cancelled.")); return; }

      // Same ownership rule as `add`: deleting the record from disk under a
      // running router only lasts until its next save rewrites the file from
      // the pool, which still holds the account.
      const probe = await probeRouter(PROXY_PORT);
      if (probe.state === "unreachable") {
        console.error(chalk.red(`✗ A router seems to be running but its API did not answer.`));
        console.error(chalk.gray(`  ${probe.reason}`));
        console.error(chalk.gray("  Removing from accounts.json now would be undone when it next saves.\n"));
        process.exit(1);
      }
      if (probe.state === "live") {
        const result = await removeAccountFromRouter(probe.router, id);
        if (!result.ok) {
          console.error(chalk.red(`✗ The running router refused to remove "${id}": HTTP ${result.status}`));
          console.error(chalk.gray(`  ${result.message}\n`));
          process.exit(1);
        }
        console.log(chalk.green(`✓ Removed "${id}" from the running router. No restart needed.`));
        return;
      }

      const removed = removeAccountRecordById(id);
      if (!removed) {
        console.log(chalk.red(`✗ Account "${id}" disappeared before it could be removed.`));
        process.exit(1);
      }

      const remaining = loadAccounts().length + loadOpenAIAccounts().length;
      const providerLabel = removed.provider === "openai_subscription" ? "OpenAI account" : "Account";

      console.log(chalk.green(`✓ Removed ${providerLabel} "${id}". ${remaining} account(s) remaining.`));
      if (remaining === 0) {
        console.log(chalk.yellow("  No accounts left. Run: cc-router setup"));
      }
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function buildStoredAccountsJson(
  anthropicAccounts: Account[],
  openAIAccounts: OpenAISubscriptionAccount[],
): Array<{
  id: string;
  provider: "anthropic_subscription" | "openai_subscription";
  enabled: boolean;
  expiresAt: number;
  scopes?: string[];
}> {
  return [
    ...anthropicAccounts.map(a => ({
      id: a.id,
      provider: "anthropic_subscription" as const,
      enabled: a.enabled,
      expiresAt: a.tokens.expiresAt,
      scopes: a.tokens.scopes,
    })),
    ...openAIAccounts.map(a => ({
      id: a.id,
      provider: "openai_subscription" as const,
      enabled: a.enabled !== false,
      expiresAt: a.expiresAt,
    })),
  ];
}

async function fetchLiveStats(): Promise<null | Array<{
  id: string; provider?: string; healthy: boolean; busy: boolean;
  requestCount: number; errorCount: number; expiresInMs: number;
}>> {
  try {
    const res = await fetch(`http://localhost:${PROXY_PORT}/cc-router/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { accounts: unknown[] };
    return data.accounts as typeof fetchLiveStats extends () => Promise<null | Array<infer T>> ? T[] : never;
  } catch {
    return null;
  }
}

function formatMs(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
