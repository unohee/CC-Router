import chalk from "chalk";
import { CODEX_SESSION_CEILING } from "../providers/openai/context-limits.js";

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

/**
 * A session moved off Codex because its conversation no longer fits there.
 *
 * The counterpart to `logSessionRepin`, and the one worth reading: this move
 * happens *before* a refusal, so the operator sees the pool re-shaping itself
 * rather than an account going quiet for no visible reason.
 */
export function logSessionOutgrewCodex(sessionId: string, estimatedTokens: number): void {
  console.log(
    chalk.gray(`[${ts()}]`) +
    chalk.yellow(` ⤳ ${sessionId.slice(0, 8)} outgrew Codex`) +
    chalk.gray(` (~${Math.round(estimatedTokens / 1_000)}K tokens > ${CODEX_SESSION_CEILING / 1_000}K ceiling)`)
  );
}

/**
 * A session's pin moved between two Anthropic accounts, and what that cost.
 *
 * The move itself was already visible; the price was not. The prompt cache is
 * account-local, so the next request re-writes the whole prefix into the new
 * account — this line is the only place that number appears, and the migration
 * thresholds are meant to be tuned from it rather than from intuition.
 */
export function logSessionMove(
  sessionId: string, fromAccountId: string, toAccountId: string, estimatedTokens: number,
): void {
  console.log(
    chalk.gray(`[${ts()}]`) +
    chalk.yellow(` ⇄ ${sessionId.slice(0, 8)} ${fromAccountId} → ${toAccountId}`) +
    chalk.gray(` (re-writing ~${Math.round(estimatedTokens / 1_000)}K tokens of context)`)
  );
}

/**
 * A session compacted, and the size it compacted from.
 *
 * The number is the point of the line. Compaction at the top of the window is
 * a long conversation working as intended; compaction well below it means
 * something is capping the client early, which has happened before — a global
 * `autoCompactWindow` once held every session to 800K so that one target which
 * could not hold 1M stayed safe. Without this line, telling the two apart
 * meant reading the client's own transcripts.
 */
export function logSessionCompaction(
  sessionId: string, fromTokens: number, toTokens: number,
): void {
  console.log(
    chalk.gray(`[${ts()}]`) +
    chalk.cyan(` ✂ ${sessionId.slice(0, 8)} compacted`) +
    chalk.gray(` (~${Math.round(fromTokens / 1_000)}K → ~${Math.round(toTokens / 1_000)}K)`)
  );
}

/**
 * A pinned session left an account that could still serve it, because the
 * account crossed the soft cap. `logSessionMove` prices the move; this line
 * says why a retainable pin was given up, which nothing else records.
 */
export function logSessionReassign(sessionId: string, from: string, to: string, why: string): void {
  console.log(
    chalk.gray(`[${ts()}]`) +
    chalk.yellow(` ⤳ reassign ${sessionId.slice(0, 8)} ${from} → ${to}`) +
    chalk.gray(` (${why})`)
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

/** What the router knew about one upstream 429, gathered at header time. */
export interface Refusal429Diagnostic {
  accountId: string;
  /** No stated reason for the refusal — see `isBare429`. */
  bare: boolean;
  cooldownSeconds: number;
  /** Position in the bare-429 schedule; 0 when the refusal was not bare. */
  streak: number;
  /** Raw Retry-After header, undefined when upstream sent none. */
  retryAfter: string | undefined;
  /** Unified rate-limit status header, "none" when the response carried none. */
  limitStatus: string;
  claim: string;
  userAgent: string | undefined;
  sessionId: string | undefined;
  model: string | undefined;
}

/**
 * One line per upstream 429 saying who asked and what upstream said.
 *
 * The plain "rate limited — cooldown 60s" line cannot tell a quota that is
 * really gone from a request upstream simply refused, and it names no client.
 * When a non-Claude-Code client shares the pool its refusals look exactly like
 * the account's own, and the only way to tell them apart was to catch the
 * activity log before its 50 entries rolled over. The user-agent and the raw
 * Retry-After are what separate the cases; neither is a secret, and no auth
 * header is ever read here.
 */
export function format429Diagnostic(d: Refusal429Diagnostic): string {
  // Header values are client-controlled: keep this to one printable line.
  const ua = d.userAgent === undefined ? "none"
    : JSON.stringify(d.userAgent.replace(/[^\x20-\x7e]/g, "?").slice(0, 80));
  return [
    `429 ${d.bare ? `bare#${d.streak}` : "stated"}`,
    `cooldown=${d.cooldownSeconds}s`,
    `retry-after=${d.retryAfter === undefined ? "absent" : JSON.stringify(d.retryAfter.slice(0, 40))}`,
    `limit=${d.limitStatus}`,
    `claim=${d.claim === "" ? "none" : d.claim}`,
    `model=${d.model ?? "-"}`,
    `session=${d.sessionId ? d.sessionId.slice(0, 8) : "none"}`,
    `ua=${ua}`,
  ].join(" ");
}

export function log429Diagnostic(d: Refusal429Diagnostic): void {
  console.log(chalk.red(`[${ts()}] [429] ${d.accountId}: ${format429Diagnostic(d)}`));
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
