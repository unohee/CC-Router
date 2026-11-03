/**
 * "Short request" predicate for the admission throttle's fast lane.
 *
 * Claude Code issues small one-shot side queries alongside the main loop —
 * most visibly `$.model.classify` / `$.model.complete` from plugins such as a
 * prompt classifier. Measured 2026-11-03 against claude-cli 2.1.317 (shape
 * only, no content), a classify call looks like:
 *
 *     { model, max_tokens: 2068, system: [2 blocks], messages: [1 user],
 *       metadata }                         // no `stream`, no `tools`, ~0.7 KB
 *
 * while a main-loop turn carries `stream: true`, a tools array, thinking and
 * `max_tokens` in the tens of thousands. A short request waiting behind its
 * session's long streams in the throttle gets its answer too late to matter,
 * so the gate lets it skip the wait (it still counts as in flight).
 *
 * The test is deliberately structural — non-streaming, no tools, small output
 * budget — rather than keyed on headers or on the exact 2068, both of which
 * move between client versions.
 */

/** Largest `max_tokens` a short request may ask for. The observed classifier
 *  value is 2068; 4096 leaves headroom for a larger label set while staying
 *  far below any main-loop or compaction budget. */
export const SHORT_REQUEST_MAX_TOKENS = 4096;

/**
 * Pure. True when `body` is an Anthropic Messages request that is
 * non-streaming, declares no tools, and asks for at most
 * `SHORT_REQUEST_MAX_TOKENS` output tokens.
 *
 * Conservative on anything unexpected: a non-object body, a missing or
 * non-numeric `max_tokens`, or a missing `messages` array reads as "not short",
 * so an unparsed or foreign request keeps the throttle's normal treatment.
 */
export function isShortRequest(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const b = body as { stream?: unknown; tools?: unknown; max_tokens?: unknown; messages?: unknown };
  if (!Array.isArray(b.messages)) return false;
  // An absent `stream` is non-streaming; only an explicit `true` streams.
  if (b.stream === true) return false;
  if (b.tools !== undefined && !(Array.isArray(b.tools) && b.tools.length === 0)) return false;
  const maxTokens = b.max_tokens;
  return typeof maxTokens === "number" && Number.isFinite(maxTokens)
    && maxTokens > 0 && maxTokens <= SHORT_REQUEST_MAX_TOKENS;
}
