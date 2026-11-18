import type { Command } from "commander";
import { ACCOUNTS_PATH, PROXY_PORT } from "../config/paths.js";
import { readConfig } from "../config/manager.js";
import { resolveDrainLimitMs } from "../proxy/drain.js";
import { writePid, removePid } from "../daemon/pid.js";

/**
 * `cc-router supervise`: the router under a supervisor that can replace it
 * without dropping a request. `systemctl --user reload cc-router` (SIGHUP)
 * starts a worker from the release the `current` symlink points at, hands it
 * the socket and lets the old worker finish its streams. SIGTERM drains and
 * saves. See src/daemon/supervisor.ts.
 */
export function registerSupervise(program: Command): void {
  program
    .command("supervise")
    .description("Run the router under a supervisor: SIGHUP reloads it without dropping requests, SIGTERM drains")
    .option("--port <port>", "Port to listen on", String(PROXY_PORT))
    .option("--litellm [url]", "Forward to LiteLLM instead of Anthropic directly")
    .option("--accounts <path>", "Path to accounts.json", ACCOUNTS_PATH)
    .action(async (opts: { port: string; litellm?: string | boolean; accounts: string }) => {
      const { installLogStamps } = await import("../proxy/log-stamp.js");
      installLogStamps();
      const args = ["start", "--foreground", "--port", opts.port];
      if (opts.litellm) args.push(typeof opts.litellm === "string" ? `--litellm=${opts.litellm}` : "--litellm");
      if (opts.accounts !== ACCOUNTS_PATH) args.push("--accounts", opts.accounts);
      // Daemon pid file names the supervisor: it outlives every worker.
      if (process.env["CC_ROUTER_DAEMON"] === "1") {
        writePid(process.pid);
        process.on("exit", () => removePid());
      }
      const { runSupervisor } = await import("../daemon/supervisor.js");
      runSupervisor({
        // process.argv[1] keeps the path it was started with, so through the
        // `current` symlink each new worker runs the release it points at now.
        exec: process.argv[1]!,
        args,
        drainLimitMs: resolveDrainLimitMs(readConfig().drain?.limitSeconds),
      });
    });
}
