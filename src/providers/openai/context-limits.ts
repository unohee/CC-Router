/**
 * Context limits of the Codex backend, and how a request is judged against them.
 *
 * Read once by hand out of `codex/models?client_version=1.0.0`, which reports
 * them per model (2026-08-20, `gpt-5.6-sol`) — not probed against the refusal
 * boundary, and nothing re-reads them: `model-discovery` calls that endpoint
 * but keeps only the ids. Treat them as an observation that has since gone
 * unverified, and re-check before shaving the headroom below.
 *
 * They are named here because several places need the same numbers and there
 * was no other record of where they came from.
 */

/** Window Codex advertises as its ordinary limit. */
export const CODEX_CONTEXT_WINDOW = 272_000;

/** Hard ceiling. A request above this is refused — see CODEX_SESSION_CEILING. */
export const CODEX_MAX_CONTEXT_WINDOW = 872_000;

/**
 * The largest conversation the router will put on a Codex account.
 *
 * The proxy answers a cross-routed request with the Claude model name the
 * client asked for, because reporting `gpt-5.6-*` makes Claude Code treat the
 * model as unknown and clamp its assumed window to 200k. The cost of that
 * choice is this: the client believes it is talking to a 1M-context Claude
 * model and will grow past what Codex accepts, and the refusal arrives inside
 * an HTTP 200 stream where nothing marks the account as unusable.
 *
 * So a session is held to the pool minimum rather than the Claude maximum. The
 * headroom below CODEX_MAX_CONTEXT_WINDOW absorbs the estimate's own error plus
 * the growth of one more turn, so a session is moved off Codex before it hits
 * the wall rather than after — a refusal costs a full prefix rewrite into the
 * next account, measured at 600-750K tokens.
 *
 * This used to be enforced by the operator instead, as `autoCompactWindow` in
 * `~/.claude/settings.json`. That setting is global: it also capped sessions
 * pinned to a Claude account that could hold 1M, making every session in the
 * pool compact ~200k early to accommodate the one target that could not. The
 * ceiling belongs on the target that cannot hold the conversation, which is
 * what `codexCanHold` below now applies, per request.
 */
export const CODEX_SESSION_CEILING = 800_000;

/**
 * Bytes of request body per token, for sizing a request before it is sent.
 *
 * Measured on a live Claude Code session (2026-09-04, session `d0345005`, 828
 * samples above 300K tokens): the ratio converges on 1.8 as the conversation
 * grows, far denser than the ~4 bytes/token usually quoted for English prose,
 * because the body is mostly code, JSON and tool output.
 *
 * 2 is deliberately below that measurement, and the measurement is itself a
 * floor — it was reconstructed from a transcript, which does not carry the
 * system prompt or the tool definitions, and those add bytes the API charges
 * tokens for. Dividing by too small a number over-states the token count, which
 * errs toward keeping a borderline conversation off a target that could not
 * hold it. Judging fit is all this figure does; nothing bills from it.
 */
export const BYTES_PER_TOKEN = 2;

/**
 * Estimated prompt size of a Messages request, from the raw body as received.
 *
 * Null when there is nothing to measure — the caller must then treat the size
 * as unknown rather than as zero, or an unparsed request would look small
 * enough for any target.
 */
export function estimatePromptTokens(rawBody: Buffer | undefined | null): number | null {
  if (!rawBody || rawBody.length === 0) return null;
  return Math.ceil(rawBody.length / BYTES_PER_TOKEN);
}

/**
 * Whether a Codex account can be asked to carry a conversation of this size.
 *
 * An unknown size answers true. The guard exists to stop a *known* oversized
 * conversation from being placed on a target that will refuse it; treating
 * "not measured" as "too big" would instead disable cross-provider routing
 * outright on any path that does not buffer the body.
 */
export function codexCanHold(estimatedPromptTokens: number | null): boolean {
  if (estimatedPromptTokens === null) return true;
  return estimatedPromptTokens <= CODEX_SESSION_CEILING;
}

/**
 * Whether a target on `provider` may take a request of this size.
 *
 * Only Codex has a ceiling worth enforcing here: the Anthropic accounts in a
 * pool serve the same models with the same window, so sizing a request against
 * them would just re-impose the global cap this exists to remove.
 */
export function targetCanHoldContext(
  provider: "anthropic" | "openai",
  estimatedPromptTokens: number | null,
): boolean {
  return provider !== "openai" || codexCanHold(estimatedPromptTokens);
}
