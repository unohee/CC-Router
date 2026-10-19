import type { Command } from "commander";
import chalk from "chalk";
import { SUGGESTED_TIER_MODELS } from "../protocol/model-ref.js";
import { writeClaudeSettings, removeClaudeSettings, readClaudeProxySettings, setRetryWatchdog } from "../utils/claude-config.js";
import { writeCodexRouterConfig } from "../utils/codex-config.js";
import { readConfig, writeConfig, generateProxySecret, getThrottleConfig } from "../config/manager.js";
import { resolveOllamaFallbackConfig } from "../providers/ollama/fallback-policy.js";
import { DEFAULT_THROTTLE } from "../proxy/throttle.js";
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
    .option("--enable-ollama-fallback", "Answer from Ollama when every Claude account is blocked for longer than --ollama-min-wait")
    .option("--disable-ollama-fallback", "Disable the Ollama fallback (default)")
    .option("--ollama-model <model>", "Ollama model the fallback asks for (e.g. a :cloud model)")
    .option("--ollama-base-url <url>", "Ollama endpoint (default https://ollama.com; key read from $OLLAMA_API_KEY)")
    .option("--ollama-min-wait <seconds>", "Fall back only when the earliest reset is further away than this (default 900)")
    .option("--ollama-context-tokens <n>", "Largest request (router estimate, ~2x real tokens) sent to Ollama (default 1048576)")
    .option("--enable-session-pool-openai", "Let whole sessions be assigned to an OpenAI subscription account")
    .option("--disable-session-pool-openai", "Assign sessions to Claude accounts only (default)")
    .option("--disable-session-affinity", "Pick an account per request instead of per session")
    .option("--enable-session-affinity", "Pin each session to one account (default)")
    .option("--enable-model-tiers", "Map Claude tiers (opus/sonnet/haiku) to comparable Codex models")
    .option("--disable-model-tiers", "Send every cross-provider request to the single default model")
    .option("--enable-retry-watchdog", "Let Claude Code keep retrying until an account resets (writes CLAUDE_CODE_RETRY_WATCHDOG=1)")
    .option("--disable-retry-watchdog", "Remove CLAUDE_CODE_RETRY_WATCHDOG from ~/.claude/settings.json (default)")
    .option("--enable-throttle", "Pace requests to accounts whose quota is running hot (reduces burst-driven 429s)")
    .option("--disable-throttle", "Disable request pacing (default)")
    .option("--throttle-max-inflight <n>", "Max concurrent in-flight requests per account (0 disables the gate)")
    .option("--throttle-min-interval <ms>", "Minimum spacing between consecutive sends to one account at full saturation")
    .option("--throttle-start-util <0-1>", "Quota utilization below which no pacing applies")
    .option("--throttle-hard-util <0-1>", "Quota utilization at which concurrency is 1 and spacing is maximum")
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
      enableFallback?: boolean;
      disableFallback?: boolean;
      enableSessionPoolOpenai?: boolean;
      disableSessionPoolOpenai?: boolean;
      enableSessionAffinity?: boolean;
      disableSessionAffinity?: boolean;
      enableModelTiers?: boolean;
      disableModelTiers?: boolean;
      enableOllamaFallback?: boolean;
      disableOllamaFallback?: boolean;
      ollamaModel?: string;
      ollamaBaseUrl?: string;
      ollamaMinWait?: string;
      ollamaContextTokens?: string;
      enableRetryWatchdog?: boolean;
      disableRetryWatchdog?: boolean;
      enableThrottle?: boolean;
      disableThrottle?: boolean;
      throttleMaxInflight?: string;
      throttleMinInterval?: string;
      throttleStartUtil?: string;
      throttleHardUtil?: string;
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
        const fallbackEnabled = cfg.crossProviderFallback === true;
        const fbStatus = fallbackEnabled ? chalk.green("enabled") : chalk.gray("disabled");
        console.log(`    Password protected:  ${pwStatus}`);
        console.log(`    Cross-provider fallback: ${fbStatus}`);
        const affinity = cfg.sessionAffinity !== false;
        console.log(`    Session affinity:    ${affinity ? chalk.green("enabled") : chalk.gray("disabled")}`);
        const poolOpenAI = cfg.sessionPoolIncludesOpenAI === true;
        console.log(`    OpenAI in session pool: ${poolOpenAI ? chalk.green("enabled") : chalk.gray("disabled")}`);
        const throttle = getThrottleConfig();
        const throttleStatus = throttle.enabled
          ? chalk.green("enabled") + chalk.gray(` (per-account max ${throttle.perAccountMaxInFlight}, +${throttle.minIntervalMs}ms between sends, start ${Math.round(throttle.startUtil * 100)}%)`)
          : chalk.gray("disabled");
        console.log(`    Throttle:            ${throttleStatus}`);
        const ollama = resolveOllamaFallbackConfig(cfg.ollamaFallback);
        console.log(`    Ollama fallback:     ${ollama
          ? (ollama.model
            ? chalk.green("enabled") + chalk.gray(` (${ollama.model} via ${ollama.baseUrl}, after ${ollama.minWaitSeconds}s)`)
            : chalk.yellow("enabled (inactive — no model)"))
          : chalk.gray("disabled")}`);
        const tierMap = cfg.modelRouting?.openAITierMap;
        if (tierMap && Object.keys(tierMap).length > 0) {
          const gated = !cfg.modelRouting?.openAIDefaultModel;
          console.log(`    Model tier routing:  ${gated ? chalk.yellow("enabled (inactive — no OpenAI default model)") : chalk.green("enabled")}`);
          for (const [tier, model] of Object.entries(tierMap)) {
            console.log(chalk.gray(`      claude ${tier.padEnd(7)} → ${model}`));
          }
        } else {
          console.log(`    Model tier routing:  ${chalk.gray("disabled")}`);
        }
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

      if (opts.enableModelTiers) {
        const cfg = readConfig();
        if (!cfg.modelRouting?.openAIDefaultModel) {
          // The cross-provider routes still gate on the default model, so tier
          // routing alone changes nothing until one is set.
          console.log(chalk.yellow("⚠ No OpenAI default model configured yet."));
          console.log(chalk.gray("  Run: cc-router configure models --openai-model <model>"));
          console.log(chalk.gray("  Until then no request crosses to OpenAI, tier map or not."));
        }
        const modelRouting = { ...(cfg.modelRouting ?? {}), openAITierMap: { ...SUGGESTED_TIER_MODELS } };
        writeConfig({ ...cfg, modelRouting });
        console.log(chalk.green("✓ Model tier routing enabled."));
        for (const [tier, model] of Object.entries(SUGGESTED_TIER_MODELS)) {
          console.log(chalk.gray(`    claude ${tier.padEnd(7)} → ${model}`));
        }
        console.log(chalk.gray("  Unmapped or unrecognised models still use the OpenAI default."));
        console.log(chalk.gray("  Edit modelRouting.openAITierMap in the config to change a tier."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.disableModelTiers) {
        const cfg = readConfig();
        const modelRouting = { ...(cfg.modelRouting ?? {}) };
        delete modelRouting.openAITierMap;
        writeConfig({ ...cfg, modelRouting });
        console.log(chalk.green("✓ Model tier routing disabled — the OpenAI default answers every tier."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.enableRetryWatchdog) {
        setRetryWatchdog(true);
        console.log(chalk.green(`✓ Retry watchdog enabled in ${CLAUDE_SETTINGS_PATH}.`));
        console.log(chalk.gray("  When every account is limited, Claude Code waits for the router's"));
        console.log(chalk.gray("  Retry-After (the earliest reset in the pool) instead of giving up."));
        console.log(chalk.gray("  Takes effect in newly started Claude Code sessions."));
        return;
      }

      if (opts.disableRetryWatchdog) {
        setRetryWatchdog(false);
        console.log(chalk.green(`✓ Retry watchdog removed from ${CLAUDE_SETTINGS_PATH}.`));
        return;
      }

      // ─── Ollama fallback (opt-in last resort) ───────────────────────────────
      // One block, so `--enable-ollama-fallback --ollama-model X` is a single
      // write. The setting flags alone update the stored values without
      // changing whether the fallback is on.
      if (opts.enableOllamaFallback || opts.disableOllamaFallback
          || opts.ollamaModel !== undefined || opts.ollamaBaseUrl !== undefined || opts.ollamaMinWait !== undefined
          || opts.ollamaContextTokens !== undefined) {
        const cfg = readConfig();
        const next = { ...(cfg.ollamaFallback ?? { enabled: false, model: "" }) };
        if (opts.ollamaModel !== undefined) next.model = opts.ollamaModel.trim();
        if (opts.ollamaBaseUrl !== undefined) {
          const url = opts.ollamaBaseUrl.trim();
          try {
            new URL(url);
          } catch {
            console.error(chalk.red(`Not a URL: ${opts.ollamaBaseUrl}`));
            process.exit(1);
          }
          next.baseUrl = url;
        }
        if (opts.ollamaMinWait !== undefined) {
          const seconds = Number(opts.ollamaMinWait);
          if (!Number.isFinite(seconds) || seconds < 0) {
            console.error(chalk.red(`--ollama-min-wait must be a number of seconds >= 0, got ${opts.ollamaMinWait}`));
            process.exit(1);
          }
          next.minWaitSeconds = seconds;
        }
        if (opts.ollamaContextTokens !== undefined) {
          const tokens = Number(opts.ollamaContextTokens);
          if (!Number.isInteger(tokens) || tokens < 1) {
            console.error(chalk.red(`--ollama-context-tokens must be a positive integer, got ${opts.ollamaContextTokens}`));
            process.exit(1);
          }
          next.contextTokens = tokens;
        }
        if (opts.enableOllamaFallback) next.enabled = true;
        if (opts.disableOllamaFallback) next.enabled = false;
        writeConfig({ ...cfg, ollamaFallback: next });

        const resolved = resolveOllamaFallbackConfig(next);
        if (!resolved) {
          console.log(chalk.green(opts.disableOllamaFallback ? "✓ Ollama fallback disabled." : "✓ Ollama fallback settings saved (fallback is disabled)."));
        } else {
          if (!resolved.model) {
            console.log(chalk.yellow("⚠ No Ollama model configured yet."));
            console.log(chalk.gray("  Run: cc-router configure --ollama-model <model>"));
            console.log(chalk.gray("  The fallback will stay inactive until a model is set."));
          }
          console.log(chalk.green("✓ Ollama fallback enabled."));
          console.log(chalk.gray(`  When every Claude account is blocked for more than ${resolved.minWaitSeconds}s, a request`));
          console.log(chalk.gray(`  is answered by ${resolved.model || "(no model)"} via ${resolved.baseUrl} instead of a 429.`));
          if (resolved.keyRequired) {
            console.log(chalk.gray(`  The API key is read from $${resolved.apiKeyEnv} in cc-router's environment.`));
            console.log(chalk.gray(`  Under a service manager (systemd, launchd) set it in the service's environment,`));
            console.log(chalk.gray(`  not just your shell. /cc-router/health reports ollamaFallback.keyPresent.`));
          }
        }
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      if (opts.disableFallback) {
        writeConfig({ ...readConfig(), crossProviderFallback: false });
        console.log(chalk.green("✓ Cross-provider fallback disabled."));
        console.log(chalk.gray("  Restart cc-router for the change to take effect."));
        return;
      }

      // ─── Throttle (opt-in pacing) ──────────────────────────────────────────
      // Handled as one block so `--enable-throttle --throttle-min-interval 500`
      // configures and turns on in a single invocation.
      const throttleTouched = opts.enableThrottle || opts.disableThrottle
        || opts.throttleMaxInflight !== undefined || opts.throttleMinInterval !== undefined
        || opts.throttleStartUtil !== undefined || opts.throttleHardUtil !== undefined;
      if (throttleTouched) {
        const cfg = readConfig();
        const throttle = { ...(cfg.throttle ?? {}) };
        const parseNumber = (raw: string, label: string): number => {
          const value = Number(raw.trim());
          if (raw.trim() === "" || !Number.isFinite(value)) {
            console.error(chalk.red(`Invalid ${label}: "${raw}" (expected a number)`));
            process.exit(1);
          }
          return value;
        };
        if (opts.throttleMaxInflight !== undefined) {
          const n = parseNumber(opts.throttleMaxInflight, "max in-flight");
          if (n < 0) {
            console.error(chalk.red("--throttle-max-inflight must be >= 0 (0 disables the concurrency gate)"));
            process.exit(1);
          }
          throttle.perAccountMaxInFlight = n;
        }
        if (opts.throttleMinInterval !== undefined) {
          const ms = parseNumber(opts.throttleMinInterval, "min interval (ms)");
          if (ms < 0) {
            console.error(chalk.red("--throttle-min-interval must be >= 0 (0 disables pacing)"));
            process.exit(1);
          }
          throttle.minIntervalMs = ms;
        }
        if (opts.throttleStartUtil !== undefined) {
          const u = parseNumber(opts.throttleStartUtil, "start utilization");
          if (u < 0 || u > 1) {
            console.error(chalk.red("--throttle-start-util must be between 0 and 1"));
            process.exit(1);
          }
          throttle.startUtil = u;
        }
        if (opts.throttleHardUtil !== undefined) {
          const u = parseNumber(opts.throttleHardUtil, "hard utilization");
          if (u < 0 || u > 1) {
            console.error(chalk.red("--throttle-hard-util must be between 0 and 1"));
            process.exit(1);
          }
          throttle.hardUtil = u;
        }
        // Explicit toggles win over the previous state; a settings-only call
        // leaves the switch exactly where it was.
        if (opts.disableThrottle) throttle.enabled = false;
        else if (opts.enableThrottle) throttle.enabled = true;

        writeConfig({ ...cfg, throttle });
        const effective = getThrottleConfig();
        if (effective.enabled) {
          console.log(chalk.green("✓ Request pacing enabled."));
          console.log(chalk.gray("  As an account's quota fills, requests to it are spaced out and their"));
          console.log(chalk.gray("  concurrency is capped — a short wait instead of a burst-driven 429"));
          console.log(chalk.gray("  and the retry that burns more tokens than the wait saved."));
        } else if (opts.disableThrottle) {
          console.log(chalk.green("✓ Request pacing disabled."));
        } else {
          console.log(chalk.green("✓ Throttle settings updated."));
          console.log(chalk.gray("  Pacing is still off — add --enable-throttle to turn it on."));
        }
        console.log(chalk.gray(`  per-account max in-flight: ${effective.perAccountMaxInFlight}${effective.perAccountMaxInFlight === 0 ? " (gate off)" : ""}`));
        console.log(chalk.gray(`  spacing at saturation:     ${effective.minIntervalMs}ms`));
        console.log(chalk.gray(`  ramp:                      ${Math.round(effective.startUtil * 100)}% → ${Math.round(effective.hardUtil * 100)}% utilization`));
        console.log(chalk.gray("  This paces requests; it does not reduce token consumption."));
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
