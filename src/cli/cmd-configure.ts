import type { Command } from "commander";
import chalk from "chalk";
import { writeClaudeSettings, removeClaudeSettings, readClaudeProxySettings } from "../utils/claude-config.js";
import { writeCodexRouterConfig } from "../utils/codex-config.js";
import { readConfig, writeConfig, generateProxySecret } from "../config/manager.js";
import { PROXY_PORT, CLAUDE_SETTINGS_PATH } from "../config/paths.js";
import { buildModelRoutingUpdate } from "../protocol/model-routing-config.js";

export function registerConfigure(program: Command): void {
  program
    .command("configure")
    .description("Configure Claude Code or Codex to point to the proxy")
    .argument("[target]", "Optional target to configure: codex, models")
    .option("--remove", "Remove cc-router settings from ~/.claude/settings.json")
    .option("--port <port>", "Proxy port to configure", String(PROXY_PORT))
    .option("--model <model>", "Default model for the configured target")
    .option("--claude-model <model>", "Default Claude/Anthropic model for router aliases")
    .option("--openai-model <model>", "Default OpenAI/Codex model for router aliases")
    .option("--show", "Show current Claude Code proxy settings")
    .option("--generate-password", "Generate a new proxy secret and sync Claude Code settings")
    .option("--set-password <secret>", "Set a specific proxy secret and sync Claude Code settings")
    .option("--remove-password", "Remove proxy password protection (open access)")
    .option("--enable-auto-update", "Enable automatic updates for the proxy")
    .option("--disable-auto-update", "Disable automatic updates for the proxy")
    .option("--enable-fallback", "Enable automatic fallback to OpenAI when all Claude accounts are exhausted")
    .option("--disable-fallback", "Disable automatic cross-provider fallback")
    .option("--enable-session-pool-openai", "Let whole sessions be assigned to an OpenAI subscription account")
    .option("--disable-session-pool-openai", "Assign sessions to Claude accounts only (default)")
    .option("--disable-session-affinity", "Pick an account per request instead of per session")
    .option("--enable-session-affinity", "Pin each session to one account (default)")
    .action((target: string | undefined, opts: {
      remove?: boolean;
      port: string;
      model?: string;
      claudeModel?: string;
      openaiModel?: string;
      show?: boolean;
      generatePassword?: boolean;
      setPassword?: string;
      removePassword?: boolean;
      enableAutoUpdate?: boolean;
      disableAutoUpdate?: boolean;
      enableFallback?: boolean;
      disableFallback?: boolean;
      enableSessionPoolOpenai?: boolean;
      disableSessionPoolOpenai?: boolean;
      enableSessionAffinity?: boolean;
      disableSessionAffinity?: boolean;
    }) => {
      if (target === "codex") {
        const port = parseInt(opts.port, 10);
        const result = writeCodexRouterConfig({
          baseUrl: `http://localhost:${port}/v1`,
          tokenEnvKey: "CC_ROUTER_TOKEN",
          defaultModel: opts.model,
        });
        console.log(chalk.green(`✓ Updated ${result.path}`));
        console.log(chalk.gray("  CODEX provider configured:"));
        if (opts.model) console.log(chalk.gray(`    model          = ${opts.model}`));
        console.log(chalk.gray("    model_provider = cc-router"));
        console.log(chalk.gray(`    base_url       = http://localhost:${port}/v1`));
        console.log(chalk.gray("    env_key        = CC_ROUTER_TOKEN"));
        return;
      }

      if (target === "models") {
        if (!opts.claudeModel && !opts.openaiModel) {
          console.error(chalk.red("Provide at least one model: --claude-model or --openai-model"));
          process.exit(1);
        }
        const cfg = readConfig();
        const modelRouting = buildModelRoutingUpdate(cfg.modelRouting, {
          claudeModel: opts.claudeModel,
          openAIModel: opts.openaiModel,
        });
        writeConfig({ ...cfg, modelRouting });
        console.log(chalk.green("✓ Updated model routing defaults."));
        if (opts.claudeModel) console.log(chalk.gray(`  Claude default: ${opts.claudeModel}`));
        if (opts.openaiModel) console.log(chalk.gray(`  OpenAI default: ${opts.openaiModel.replace(/^openai\//, "")}`));
        console.log(chalk.gray("  Restart cc-router for the change to affect running traffic."));
        return;
      }

      if (target !== undefined) {
        console.error(chalk.red(`Unknown configure target: ${target}`));
        process.exit(1);
      }

      if (opts.show) {
        const current = readClaudeProxySettings();
        if (current.baseUrl) {
          console.log(chalk.green("  Claude Code is configured to use cc-router:"));
          console.log(`    ANTHROPIC_BASE_URL  = ${chalk.cyan(current.baseUrl)}`);
          console.log(`    ANTHROPIC_AUTH_TOKEN = ${chalk.gray(current.authToken ?? "(not set)")}`);
        } else {
          console.log(chalk.yellow("  Claude Code is NOT configured to use cc-router."));
          console.log(chalk.gray(`  Run: cc-router configure`));
        }
        const cfg = readConfig();
        const pwStatus = cfg.proxySecret ? chalk.green("yes") : chalk.gray("no");
        const autoUpdateEnabled = cfg.autoUpdate !== false;
        const auStatus = autoUpdateEnabled ? chalk.green("enabled") : chalk.gray("disabled");
        const fallbackEnabled = cfg.crossProviderFallback === true;
        const fbStatus = fallbackEnabled ? chalk.green("enabled") : chalk.gray("disabled");
        console.log(`    Password protected:  ${pwStatus}`);
        console.log(`    Auto-update:         ${auStatus}`);
        console.log(`    Cross-provider fallback: ${fbStatus}`);
        const affinity = cfg.sessionAffinity !== false;
        console.log(`    Session affinity:    ${affinity ? chalk.green("enabled") : chalk.gray("disabled")}`);
        const poolOpenAI = cfg.sessionPoolIncludesOpenAI === true;
        console.log(`    OpenAI in session pool: ${poolOpenAI ? chalk.green("enabled") : chalk.gray("disabled")}`);
        return;
      }

      if (opts.enableAutoUpdate) {
        writeConfig({ ...readConfig(), autoUpdate: true });
        console.log(chalk.green("✓ Auto-update enabled."));
        console.log(chalk.gray("  The proxy will check for updates every 6h and install patch/minor releases."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.disableAutoUpdate) {
        writeConfig({ ...readConfig(), autoUpdate: false });
        console.log(chalk.green("✓ Auto-update disabled."));
        console.log(chalk.gray("  Use `cc-router update` to update manually."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.enableFallback) {
        const cfg = readConfig();
        if (!cfg.modelRouting?.openAIDefaultModel) {
          console.log(chalk.yellow("⚠ No OpenAI default model configured yet."));
          console.log(chalk.gray("  Run: cc-router configure models --openai-model <model>"));
          console.log(chalk.gray("  Fallback will stay inactive until an OpenAI default model is set."));
        }
        writeConfig({ ...cfg, crossProviderFallback: true });
        console.log(chalk.green("✓ Cross-provider fallback enabled."));
        console.log(chalk.gray("  When every Claude account is rate-limited/unhealthy, a request will"));
        console.log(chalk.gray("  be routed to a healthy OpenAI subscription account instead."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.enableSessionPoolOpenai) {
        const cfg = readConfig();
        if (!cfg.modelRouting?.openAIDefaultModel) {
          console.log(chalk.yellow("⚠ No OpenAI default model configured yet."));
          console.log(chalk.gray("  Run: cc-router configure models --openai-model <model>"));
          console.log(chalk.gray("  Sessions will stay on Claude accounts until one is set."));
        }
        writeConfig({ ...cfg, sessionPoolIncludesOpenAI: true });
        console.log(chalk.green("✓ OpenAI added to the session pool."));
        console.log(chalk.gray("  New sessions are spread across Claude and OpenAI accounts; each"));
        console.log(chalk.gray("  session then stays on its provider for its whole conversation."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.disableSessionPoolOpenai) {
        writeConfig({ ...readConfig(), sessionPoolIncludesOpenAI: false });
        console.log(chalk.green("✓ Sessions are assigned to Claude accounts only."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.disableSessionAffinity) {
        writeConfig({ ...readConfig(), sessionAffinity: false });
        console.log(chalk.green("✓ Session affinity disabled — an account is picked per request."));
        console.log(chalk.gray("  Note: this re-splits a single conversation across accounts, so each"));
        console.log(chalk.gray("  one re-writes the prompt cache instead of reading it."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.enableSessionAffinity) {
        writeConfig({ ...readConfig(), sessionAffinity: true });
        console.log(chalk.green("✓ Session affinity enabled."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.disableFallback) {
        writeConfig({ ...readConfig(), crossProviderFallback: false });
        console.log(chalk.green("✓ Cross-provider fallback disabled."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.remove) {
        removeClaudeSettings();
        console.log(chalk.green("✓ Removed cc-router settings from ~/.claude/settings.json"));
        console.log(chalk.gray("  Claude Code will use its default authentication on next launch."));
        return;
      }

      if (opts.generatePassword) {
        const secret = generateProxySecret();
        writeConfig({ ...readConfig(), proxySecret: secret });
        const { baseUrl } = readClaudeProxySettings();
        writeClaudeSettings(parseInt(opts.port, 10), baseUrl);
        console.log(chalk.green("✓ Proxy password set."));
        console.log("  " + chalk.bold.yellow("Save this — it will not be shown again:"));
        console.log("  " + chalk.bold(secret));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.setPassword !== undefined) {
        const secret = opts.setPassword.trim();
        if (!secret) {
          console.error(chalk.red("Secret cannot be empty."));
          process.exit(1);
        }
        writeConfig({ ...readConfig(), proxySecret: secret });
        const { baseUrl } = readClaudeProxySettings();
        writeClaudeSettings(parseInt(opts.port, 10), baseUrl);
        console.log(chalk.green("✓ Proxy password updated."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.removePassword) {
        const cfg = readConfig();
        delete cfg.proxySecret;
        writeConfig(cfg);
        const { baseUrl } = readClaudeProxySettings();
        writeClaudeSettings(parseInt(opts.port, 10), baseUrl);
        console.log(chalk.green("✓ Proxy password removed. Access is now open."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      const port = parseInt(opts.port, 10);
      writeClaudeSettings(port, undefined, undefined, opts.model);
      const { proxySecret } = readConfig();
      console.log(chalk.green(`✓ Updated ${CLAUDE_SETTINGS_PATH}`));
      if (opts.model) console.log(chalk.gray(`  model                = ${opts.model}`));
      console.log(chalk.gray(`  ANTHROPIC_BASE_URL  = http://localhost:${port}`));
      console.log(chalk.gray(`  ANTHROPIC_AUTH_TOKEN = ${proxySecret ? chalk.green("(secret configured)") : "proxy-managed"}`));
    });
}
