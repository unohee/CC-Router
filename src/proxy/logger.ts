import chalk from "chalk";
import { describeBuild } from "../utils/build-info.js";

function ts(): string {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

export function logRoute(
  accountId: string,
  requestCount: number,
  expiresInMin: number,
  /** Session this request was pinned to, when session affinity picked the account. */
  pinnedSessionId?: string,
): void {
  console.log(
    chalk.gray(`[${ts()}]`) +
    chalk.green(` → ${accountId}`) +
    chalk.gray(` req#${requestCount}`) +
    chalk.yellow(` exp=${expiresInMin}min`) +
    (pinnedSessionId ? chalk.cyan(` pin=${pinnedSessionId.slice(0, 8)}`) : "")
  );
}

/**
 * A request served by an OpenAI account, whatever routed it there.
 *
 * Without this the routing log only ever names Anthropic accounts — the
 * cross-provider route returns before the Anthropic proxy that does the
 * logging, so OpenAI traffic produced no line at all. That reads as "OpenAI is
 * never used" even while it is handling requests.
 */
export function logOpenAIRoute(accountId: string, model: string, note?: string): void {
  console.log(
    chalk.gray(`[${ts()}]`) +
    chalk.cyan(` ⇢ ${accountId}`) +
    chalk.gray(` ${model}`) +
    (note ? chalk.cyan(` ${note}`) : "")
  );
}

export function logFallback(accountId: string, model: string): void {
  console.log(
    chalk.gray(`[${ts()}]`) +
    chalk.magenta(` ⇄ FALLBACK → ${accountId}`) +
    chalk.gray(` (Anthropic exhausted, model=${model})`)
  );
}

/**
 * A session left an OpenAI account because that account refused it.
 *
 * Worth its own line: the refusal arrives inside a 200 stream, so nothing in
 * the HTTP-level log marks it, and the move itself costs a full prompt-cache
 * rewrite. Silent re-pins read as unexplained account churn.
 */
export function logSessionRepin(sessionId: string, accountId: string): void {
  console.log(
    chalk.gray(`[${ts()}]`) +
    chalk.yellow(` ⤳ repin ${sessionId.slice(0, 8)} → ${accountId}`) +
    chalk.gray(" (OpenAI account refused the session)")
  );
}

export function logRefresh(accountId: string, ok: boolean, expiresInMin?: number): void {
  if (ok) {
    console.log(chalk.yellow(`[${ts()}] [REFRESH] ${accountId}: OK — expires in ${expiresInMin}min`));
  } else {
    console.log(chalk.red(`[${ts()}] [REFRESH] ${accountId}: FAILED`));
  }
}

export function logError(accountId: string, status: number, message: string): void {
  const statusStr = status > 0 ? ` HTTP ${status}` : "";
  console.log(chalk.red(`[${ts()}] [ERROR] ${accountId}:${statusStr} ${message}`));
}

export interface StartupAccountCounts {
  anthropic: number;
  openai: number;
}

function formatStartupAccountCounts(counts: StartupAccountCounts): string {
  const total = counts.anthropic + counts.openai;
  return `${total} (Claude ${counts.anthropic}, OpenAI ${counts.openai})`;
}

/**
 * Fit a build string into the banner without losing the parts that identify it.
 *
 * Plain truncation cuts the tail, which is exactly the commit and the `+dirty`
 * marker — the two things you look at when a build surprises you. Elide the
 * branch instead; a branch is recognisable from its head.
 */
export function fitBuild(build: string, width: number): string {
  if (build.length <= width) return build;
  const at = build.lastIndexOf("@");
  const suffix = at === -1 ? "" : build.slice(at);
  const room = width - suffix.length - 1; // 1 for the ellipsis
  if (room < 1) return build.slice(0, width);
  return `${build.slice(0, room)}\u2026${suffix}`;
}

export function logStartup(port: number, host: string, mode: string, target: string, accountCounts: StartupAccountCounts): void {
  const listen = host === "127.0.0.1" ? `http://localhost:${port}` : `http://${host}:${port}`;
  const accounts = formatStartupAccountCounts(accountCounts);
  // Only shown for a build made in place: a published install has no branch to
  // report, and printing "unknown" every start would be noise.
  const build = describeBuild();
  console.log(chalk.cyan(`
╔══════════════════════════════════════════════╗
║  CC-Router                                   ║
║  Listening: ${listen.padEnd(33)}║
║  Mode     : ${mode.padEnd(33)}║
║  Target   : ${target.slice(0, 33).padEnd(33)}║
║  Accounts : ${accounts.padEnd(33)}║${build ? `
║  Build    : ${fitBuild(build, 33).padEnd(33)}║` : ""}
╚══════════════════════════════════════════════╝
`));
}
