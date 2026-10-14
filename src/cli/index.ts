#!/usr/bin/env node
import { Command } from "commander";
import { registerSetup } from "./cmd-setup.js";
import { registerStart } from "./cmd-start.js";
import { registerStop, registerRevert } from "./cmd-stop.js";
import { registerStatus } from "./cmd-status.js";
import { registerAccounts } from "./cmd-accounts.js";
import { registerConfigure } from "./cmd-configure.js";
import { registerDocker } from "./cmd-docker.js";
import { registerClient } from "./cmd-client.js";
import { registerLogs } from "./cmd-logs.js";
import { registerModels } from "./cmd-models.js";
import { getCurrentVersion } from "../utils/version.js";

const program = new Command();

program
  .name("cc-router")
  .description(
    "Round-robin proxy for Claude Max OAuth tokens.\n" +
    "Distributes Claude Code requests across multiple Claude Max accounts."
  )
  .version(getCurrentVersion())
  .addHelpText("after", `
Examples:
  $ cc-router setup              # First-time wizard: extract tokens + configure Claude Code
  $ cc-router start              # Start proxy (asks preferences on first run, then remembers)
  $ cc-router start --foreground # Start in foreground (this terminal)
  $ cc-router start --reconfigure# Re-ask run preferences
  $ cc-router stop               # Stop proxy (offers to remove auto-start / config)
  $ cc-router status             # Live dashboard with account stats
  $ cc-router models list        # List dynamically discovered provider models
  $ cc-router logs               # View proxy logs (background mode)
  $ cc-router accounts list      # Show all configured accounts
  $ cc-router revert             # Restore Claude Code to normal (remove all proxy config)
  $ cc-router docker up          # Full stack: cc-router + LiteLLM in Docker
  $ cc-router client connect <url>   # Route Claude Code through a remote CC-Router
`);

registerSetup(program);
registerStart(program);
registerStop(program);
registerRevert(program);
registerStatus(program);
registerModels(program);
registerAccounts(program);
registerConfigure(program);
registerDocker(program);
registerClient(program);
registerLogs(program);

program.parse();
