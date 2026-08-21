/**
 * Context limits of the Codex backend, and what the client must be told.
 *
 * These are measured, not documented: `codex/models?client_version=1.0.0`
 * reports them per model (verified 2026-08-20 against `gpt-5.6-sol`). They are
 * named here because three separate places need the same numbers and there is
 * no other record of where they came from.
 */

/** Window Codex advertises as its ordinary limit. */
export const CODEX_CONTEXT_WINDOW = 272_000;

/** Hard ceiling. A request above this is refused — see CLIENT_CONTEXT_CEILING. */
export const CODEX_MAX_CONTEXT_WINDOW = 872_000;

/**
 * What Claude Code should be allowed to grow to, via `autoCompactWindow` in
 * `~/.claude/settings.json`.
 *
 * The proxy answers a cross-routed request with the Claude model name the
 * client asked for, because reporting `gpt-5.6-*` makes Claude Code treat the
 * model as unknown and clamp its assumed window to 200k. The cost of that
 * choice is this: the client believes it is talking to a 1M-context Claude
 * model and will grow past what Codex accepts, and the refusal arrives inside
 * an HTTP 200 stream where nothing marks the account as unusable.
 *
 * So the client-side ceiling is the pool minimum, not the Claude maximum. The
 * headroom below CODEX_MAX_CONTEXT_WINDOW absorbs the request that triggers
 * compaction — that request is still sent — plus any single large tool result.
 */
export const CLIENT_CONTEXT_CEILING = 800_000;
