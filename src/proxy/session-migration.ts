/**
 * Whether a large session should move accounts, wait, or be compacted first.
 *
 * Moving a session between accounts costs a full prompt-cache rewrite: the
 * cache is account-local and keys on an exact prefix, so the next request
 * re-writes the whole conversation into the new account. Measured at 600-750K
 * tokens per bounce on this branch. The router used to treat a released pin as
 * free and move immediately; these rules price the move instead.
 *
 * What this deliberately does NOT do is edit the conversation. Truncating or
 * summarising history inside the proxy changes the cached prefix, which causes
 * the very rewrite it would be trying to avoid — and it has to be re-applied
 * identically on every later turn, since the client keeps sending the full
 * array. Dropping messages also orphans `tool_result` blocks, and reporting the
 * shrunken usage back would make the client believe it has headroom it does
 * not. So the only shrink offered here is one the *client* performs: see
 * `compact` below.
 */

/** Why a pinned account cannot serve this request, and for how long. */
export type PinBlock =
  /** The pin is fine — nothing to decide. */
  | { kind: "none" }
  /** Blocked with a known deadline (cooldown, rate limit with a reset). */
  | { kind: "temporary"; retryAfterSeconds: number }
  /** Blocked with no deadline — unhealthy, disabled, over a user cap. Waiting
   *  cannot fix it, so a large session has to move or compact. */
  | { kind: "indefinite" };

export type MigrationAction =
  /** Route normally, including moving the pin if that is what routing decides. */
  | { action: "proceed" }
  /** Keep the pin and tell the client to retry the same account shortly. */
  | { action: "wait"; retryAfterSeconds: number; estimatedRewriteTokens: number }
  /** Ask the client to compact its own history before the move happens. */
  | { action: "compact"; estimatedPromptTokens: number; limitTokens: number };

export interface MigrationLimits {
  largeSessionTokens: number;
  maxWaitSeconds: number;
  compactAskFloorTokens: number;
  minTurnsForCompact: number;
  compactAskCooldownMs: number;
}

/**
 * Thresholds, with the reasoning that produced them.
 *
 * These are judgement, not measurement. Nothing here is a measured optimum —
 * they are picked to be defensible and cheap to revise once the move cost is
 * actually logged per repin (see `logSessionMove`). Revise them from that log,
 * not from intuition.
 */
export const DEFAULT_MIGRATION_LIMITS: MigrationLimits = {
  /** Below this a rewrite is about the size of one long turn, and the policy
   *  would cost more complexity than it saves. */
  largeSessionTokens: 200_000,
  /** The outer edge of a stall a user reads as slowness rather than a hang.
   *  Past it, paying the rewrite is the better trade. Also a hard client limit:
   *  the hold answers with this as Retry-After, and Claude Code without
   *  CLAUDE_CODE_RETRY_WATCHDOG gives up on any Retry-After above 60s (measured
   *  on 2.1.303), so a longer hold ended the session it meant to keep. */
  maxWaitSeconds: 60,
  /** Compaction destroys context, so only ask when the rewrite it avoids is
   *  large. */
  compactAskFloorTokens: 400_000,
  /** A short conversation cannot be usefully compacted, and the failure
   *  surfaces to the user: Claude Code answers "a single-exchange conversation
   *  cannot be compacted" (observed 2026-09-18). */
  minTurnsForCompact: 6,
  /** One ask per move, not per request — the guard against the compact
   *  thrashing this mechanism could otherwise cause. */
  compactAskCooldownMs: 600_000,
};

export interface MigrationInput {
  /** Estimated prompt size. Null means unmeasured, which must not be read as
   *  small — an unknown size proceeds rather than triggering either mechanism. */
  estimatedPromptTokens: number | null;
  /** Messages in the request, used only to tell a compactable conversation
   *  from a single oversized exchange. */
  turnCount: number;
  block: PinBlock;
  /** Whether some other account could take this session at all. With nothing to
   *  move to, waiting would stall a request that the pool's own 429 path
   *  already handles, and asking for a compaction would shrink for no gain. */
  alternativeAvailable: boolean;
  /** Whether this session was already asked to compact inside the guard window. */
  alreadyAskedCompact: boolean;
}

/**
 * Decide what to do about a session whose pinned account cannot serve it.
 *
 * Ordered so that the cheap, certain exits come first: anything unmeasured or
 * small proceeds, and only a large session with somewhere else to go reaches
 * the interesting branches.
 */
export function decideMigration(
  input: MigrationInput,
  limits: MigrationLimits = DEFAULT_MIGRATION_LIMITS,
): MigrationAction {
  const { estimatedPromptTokens: est, block } = input;

  // Nothing is being released, so there is no move to price.
  if (block.kind === "none") return { action: "proceed" };

  // An unknown size is not a small size, but it is not a basis for stalling a
  // request either. Proceed and let routing do what it did before.
  if (est === null) return { action: "proceed" };

  // Cheap to move: let it move.
  if (est < limits.largeSessionTokens) return { action: "proceed" };

  // No second account to move to. Waiting here would add a stall on top of a
  // pool that is already going to answer 429 by itself.
  if (!input.alternativeAvailable) return { action: "proceed" };

  // A deadline we can sit out is worth more than a rewrite.
  if (block.kind === "temporary" && block.retryAfterSeconds <= limits.maxWaitSeconds) {
    return {
      action: "wait",
      retryAfterSeconds: Math.max(1, Math.ceil(block.retryAfterSeconds)),
      estimatedRewriteTokens: est,
    };
  }

  // The move is happening. Shrink what it carries, if the client can.
  if (
    est >= limits.compactAskFloorTokens &&
    input.turnCount >= limits.minTurnsForCompact &&
    !input.alreadyAskedCompact
  ) {
    return {
      action: "compact",
      estimatedPromptTokens: est,
      limitTokens: limits.compactAskFloorTokens,
    };
  }

  return { action: "proceed" };
}

/**
 * Remembers which sessions have already been asked to compact.
 *
 * The ask is a 400 the client answers by compacting and retrying. Without a
 * memory of having asked, the retry — still large, since compaction is not
 * instant from the router's point of view — would be asked again, and the
 * session would compact in a loop. That loop is the "compact thrashing"
 * symptom this whole line of work started from, so the guard is not optional.
 *
 * The elapsed window is the ONLY thing that lifts an ask. An earlier draft also
 * cleared it as soon as any request on the session came in small, on the theory
 * that a small request proves the compaction worked. It does not: Claude Code
 * issues small side-calls (a haiku title generation, say) under the same
 * session id, so an interleaved side-call would clear the guard while the large
 * conversation was still mid-flight — and the bound the guard exists to provide
 * would be gone. The cost of the strict rule is that a session which compacts
 * and grows past the floor again inside the window pays one full rewrite
 * instead of being asked twice. Bounded thrash is worth more than an optimal
 * shrink; that is the lesson of the compaction loop this replaced.
 */
export class CompactAskGuard {
  private readonly asked = new Map<string, number>();
  private readonly now: () => number;
  private readonly cooldownMs: number;

  constructor(opts: { now?: () => number; cooldownMs?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_MIGRATION_LIMITS.compactAskCooldownMs;
  }

  askedRecently(sessionId: string): boolean {
    const at = this.asked.get(sessionId);
    if (at === undefined) return false;
    if (this.now() - at >= this.cooldownMs) {
      this.asked.delete(sessionId);
      return false;
    }
    return true;
  }

  markAsked(sessionId: string): void {
    this.asked.set(sessionId, this.now());
  }
}

/**
 * The move that costs a prefix rewrite, if this pin change is one.
 *
 * Only an Anthropic-to-Anthropic change qualifies. Leaving Codex is already
 * reported by `logSessionOutgrewCodex` with its own reason, a first placement
 * has no prior cache to lose, and an unmeasured request has no number worth
 * logging. Returning null for all of those keeps the caller a single `if`.
 */
export function expensiveMove(
  before: { provider: string; accountId: string } | null | undefined,
  after: { provider: string; accountId: string } | null | undefined,
  estimatedPromptTokens: number | null,
): { fromAccountId: string; toAccountId: string; estimatedTokens: number } | null {
  if (estimatedPromptTokens === null) return null;
  if (before?.provider !== "anthropic" || after?.provider !== "anthropic") return null;
  if (before.accountId === after.accountId) return null;
  return {
    fromAccountId: before.accountId,
    toAccountId: after.accountId,
    estimatedTokens: estimatedPromptTokens,
  };
}
