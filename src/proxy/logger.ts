import chalk from "chalk";

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

export function logStartup(port: number, host: string, mode: string, target: string, accountCounts: StartupAccountCounts): void {
  const listen = host === "127.0.0.1" ? `http://localhost:${port}` : `http://${host}:${port}`;
  const accounts = formatStartupAccountCounts(accountCounts);
  console.log(chalk.cyan(`
╔══════════════════════════════════════════════╗
║  CC-Router                                   ║
║  Listening: ${listen.padEnd(33)}║
║  Mode     : ${mode.padEnd(33)}║
║  Target   : ${target.slice(0, 33).padEnd(33)}║
║  Accounts : ${accounts.padEnd(33)}║
╚══════════════════════════════════════════════╝
`));
}
