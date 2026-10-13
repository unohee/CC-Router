# Plan — context overflow / compact thrashing with two 20x Max accounts

## Symptom (user)
Running Claude Code through CC-Router across two Claude 20x Max accounts causes
context overflow and compact thrashing.

## Evidence gathered (2026-09-04)

1. `~/.cc-router/config.json` has `sessionPoolIncludesOpenAI: true` and
   `crossProviderFallback: true`, with one `openai_subscription` account (`codex`)
   in the pool alongside the two Anthropic accounts (`intrect`, `kyte`).

2. `~/.cc-router/cc-router.log` — three repins today, all with the same reason:
   `⤳ repin <session> → <claude account> (OpenAI account refused the session)`
   at 06:39, 06:50, 07:18. Every new session is placed on the OpenAI account
   first and bounced off it.

3. Live session `d0345005` (vega-agent), transcript
   `~/.claude/projects/-home-unohee-dev-vega-agent/d0345005-*.jsonl`:
   - context reached **767,110 tokens** before compaction, currently ~394k
   - it was repinned off the OpenAI account at 06:39 while holding ~345k tokens
   - 29 x `529`, 3 x `rate_limit`, one full cache reset (510,875 -> 0 at 08:46)

4. `src/proxy/messages-cross-route.ts` already documents the mechanism in a
   comment: *"Measured at 600-750K tokens per bounce on a session whose context
   had outgrown the Codex context window, with no 429 anywhere — the rejection
   arrives inside a 200 stream, so nothing else marks the account as unusable."*

## Root cause (corrected after finding the unmerged provenance work)

5. Branch `fix/agt-3911-context-limit-provenance` (93aa343, 70efed0 — **not on
   main**) already established the numbers in
   `src/providers/openai/context-limits.ts`:
   `CODEX_CONTEXT_WINDOW = 272_000`, `CODEX_MAX_CONTEXT_WINDOW = 872_000`,
   `CLIENT_CONTEXT_CEILING = 800_000`.

6. `~/.claude/settings.json:176` has `"autoCompactWindow": 800000` — the
   documented remedy, already applied, and it is **global**.

The compaction is not a malfunction; it is the current design, and it is
mis-priced:

- Because Codex is in the session pool, the client is capped to the *pool
  minimum* (800k) so that a session which lands on Codex cannot outgrow the
  872k Codex ceiling.
- That cap is global, so **every** session — including the ones pinned to a
  Claude 20x Max account that can hold 1M — is forced to compact ~200k early.
  Observed directly: session `d0345005` compacted at 767,110 tokens.
- The Codex account's token expired 2026-08-28, so it currently refuses every
  session anyway. The whole pool pays the 200k tax for an account that serves
  nothing, and still pays one placement bounce per new session to discover it.
- The router enforces none of this. `context-limits.ts` says so itself —
  *"nothing here re-reads them"* — so correctness rests entirely on a
  hand-edited client setting that the commit message notes a reader has every
  reason to delete.

So: the ceiling is applied to the wrong thing. It belongs on the *target that
cannot hold the conversation*, evaluated per request by the router, not on every
client session globally.

## Steps

1. Land the provenance work (`context-limits.ts` + its drift test) onto this
   branch so the constants exist in the tree at all.
   -> verify: `vitest run context-limits` passes on this branch.
2. Make the constants load-bearing: estimate a request's prompt size from the
   raw body and refuse to place a session on a target whose window cannot hold
   it. Same guard on `crossProviderFallback`.
   -> verify: new unit test — a large-body request never reaches `forwardOpenAI`,
      a small one still does.
3. Surface it: log the skip, and classify upstream 400 context errors as errors
   instead of letting them pass as routine routes.
   -> verify: unit test on the classifier.
4. Full suite + typecheck green.
   -> verify: `npm test`, `npm run lint`.
5. Live config: retire the global `autoCompactWindow` ceiling once the router
   enforces the limit per target, and settle Codex's role in the pool.
   -> verify: a Claude-pinned session runs past 800k without compacting, and
      `cc-router status` shows no placement bounces.

## Assumptions

- The proxy is a localhost hop; a byte-length token estimate is acceptable for a
  routing guard (it only has to be right about "too big", not exact).
- The default guard threshold is a conservative floor, not a claim about any
  specific Codex model's real window; it is configurable.
- Anthropic-to-Anthropic placement needs no context guard: both accounts serve
  the same models with the same window.

## Concurrency

Several in-flight requests of one session can evaluate the guard at once. The
guard must be a pure function of (request, target) so concurrent evaluations
agree, and must not mutate the assignment map — `repinOnto` already carries the
idempotency guarantee (commit 0fd04fb) and must keep it.

---

# Plan 2 — avoid the move, and shrink what must move (2026-09-18)

## Ask

"높은 토큰의 세션이 다른 계정으로 옮아가지 않게 컨텍스트 절단하거나 컴팩션한 후 넣을 수 있을까."

## What is NOT being built, and why

Router-side truncation or summarisation of the conversation. Three reasons, in
order of how decisive they are:

1. **Cache paradox.** The prompt cache keys on an exact prefix. Editing the head
   of the history changes that prefix, so a router-side shrink *causes* the full
   rewrite it is meant to avoid. Shrinking only pays where the cache is already
   cold — i.e. on a move that is happening anyway.
2. **Re-application every turn.** The client re-sends the whole array next turn.
   Unless the router re-applies an identical transform deterministically, every
   turn is a fresh prefix and the cache never hits again. Determinism here means
   per-session summary state: the proxy becomes a conversation store.
3. **Correctness.** Dropping messages orphans `tool_result` blocks (upstream
   400). Worse, returning usage for a shrunken body makes the client believe it
   has headroom it does not have, so its own compaction is deferred and the
   divergence grows. Summarising also costs an inference call against the very
   allowance being conserved.

## What is being built

Two mechanisms, both leaving the history untouched.

**(a) Prefer waiting over moving, for large sessions.** When a pinned Anthropic
account is blocked by a *time-bounded* cooldown and the session is large, answer
with a local 429 + `Retry-After` and keep the pin, instead of releasing it to
another account. Waiting costs wall-clock; moving costs a full prefix rewrite
(600-750K tokens measured on this branch). Bounded naturally: only waits while
the remaining cooldown is under the cap, and re-evaluates on every retry, so an
extended cooldown falls through to the move.

**(b) When the move is unavoidable, let the CLIENT compact first.** Answer once
with the upstream's own shape — 400 `prompt is too long: N tokens > M maximum` —
so Claude Code compacts its own history and retries. The retry then lands on the
new account carrying the compacted prefix rather than ~900K. This is the only
safe shrink because the client performs it and updates its own state.

Guards, because this is exactly the "compact thrashing" symptom Plan 1 describes:
one ask per session per cooldown window, a size floor, and a minimum turn count
(Claude Code refuses to compact a single exchange — observed 2026-09-18 on
macstudio, where it surfaced the error to the user instead).

**(c) Price the move in the log.** Today a repin logs the fact, not the cost.
Log the estimated rewrite whenever a pin moves between Anthropic accounts, so
the thresholds below can be tuned from numbers.

## Thresholds — judgement, not measurement

Named in one module with their rationale. None of these are measured optima;
they are chosen to be defensible and easy to revise once (c) reports real costs.

- `LARGE_SESSION_TOKENS = 200_000` — below this, a rewrite is roughly one long
  turn and the policy is not worth its complexity.
- `MAX_WAIT_SECONDS = 90` — the outer edge of a stall a user reads as slowness
  rather than a hang. Past it, paying the rewrite is the better trade.
- `COMPACT_ASK_FLOOR_TOKENS = 400_000` — compaction destroys context, so only
  ask when the rewrite it avoids is large.
- `MIN_TURNS_FOR_COMPACT = 6` — a short conversation cannot be usefully
  compacted, and the failure surfaces to the user.
- `COMPACT_ASK_COOLDOWN_MS = 600_000` — one ask per move, not per request.

## Steps

1. `src/proxy/session-migration.ts` — pure `decideMigration()` over
   {estimate, turn count, block kind, alternative available, already asked} plus
   a small ask-guard with an injected clock. No I/O, no Express.
   -> verify: unit table covering every branch, including est=null and
      "no alternative account" (both must proceed, not wait).
2. `TokenPool.blockState(id, model)` — expose why a pin is unusable and for how
   long, reusing the private `retryAfterSeconds`/`limitingReset` helpers rather
   than duplicating the window logic. `temporary` only when a deadline is known;
   unhealthy / disabled / over-cap read `indefinite`.
   -> verify: unit tests for cooling, rate_limited-with-reset, unhealthy, capped.
3. Wire into the `/v1/messages` route *before* `resolveSessionTarget` so a wait
   or an ask mutates no routing state. Emit 429+Retry-After or 400+
   `x-cc-router-reason` header; log both through `stats.addLog`.
   -> verify: route tests — large+short-cooldown returns 429 and never resolves
      a target; large+indefinite returns 400 once then proceeds; small session
      is untouched.
4. `logSessionMove()` for (c), called from `resolveSessionTarget` when the pin
   actually changes between Anthropic accounts and the estimate is known.
   -> verify: asserted in the route/resolve test, not just eyeballed.
5. Full suite + typecheck.
   -> verify: `npm test`, `npm run lint`.
6. Do NOT rebuild `dist/` — the global `cc-router` is a symlink into this
   worktree (AGT-3912), and the live router is serving two accounts right now.
   -> verify: `git status` shows no dist changes; live proxy untouched.

---

# Plan 3 — make thrashing visible, and make the new risk switchable (2026-09-18)

## What the measurement said

Thrashing is not currently happening, and the reason is not the token refresh
fixed earlier today — that removed account death, which costs forced moves and
availability, not compaction. Compaction is driven by the client's own context
length against its window.

Measured from `~/.claude/projects/*.jsonl`, compaction trigger points:

| session | compacted at |
| --- | --- |
| kyte-portal `4a1ab0b1` | 854K, 830K, 998K |
| vega-cli `9702d337` | 863K, 902K, 998K |
| ArtifactNet `3be4e554` | 964K |

Against a 1M window, that is the ceiling — three compactions across a
2,460-turn session is the physical floor. Plan 1's pathology was compaction at
767,110 tokens, and its causes are both off: `autoCompactWindow` is absent from
`~/.claude/settings.json`, and `sessionPoolIncludesOpenAI` / `crossProviderFallback`
are both false, which also shuts off the Codex usage-echo path (AGT-3884) that
distorted the client's own accounting.

Two hypotheses were tested and rejected rather than reported:

- **A lower effective window being enforced somewhere.** 18 "exceed" hits in
  the transcripts were all ordinary prose and code containing the word. No
  `prompt is too long` from upstream anywhere.
- **Fixed prefix (system prompt + tool definitions) crowding the window.** The
  floor across 26 recent sessions is 41K, median 71K — 4-7% of the window. The
  one 225K outlier is a `/bootstrap` first turn pulling in a skill and
  attachments, not resident overhead. macstudio's 253K is a different host with
  a much larger MCP surface.

## So the remaining levers are risk, not tuning

1. **Nothing in the router reports compaction.** Answering the question above
   required mining client transcripts. A regression to premature compaction
   would be invisible here.
2. **Plan 2's compact-ask is itself a thrashing source** by construction, and
   it was unconditional.

## Built

- `src/proxy/session-context-tracker.ts` — infers compaction from a prompt size
  that drops to <=60% of the session's peak by at least 100K, **confirmed by the
  following request**. One small request is never enough: Claude Code issues
  small side-calls under the same session id, so an unconfirmed drop would
  report a haiku title generation as a compaction. Bounded to 500 sessions,
  evicting the least recently seen.
  -> verify: 8 unit tests including the side-call case, a 97%-but-small drop,
     and a large-but-proportionally-small drop.
- `logSessionCompaction` — `✂ 9702d337 compacted (~998K → ~120K)`, plus a
  dashboard entry. The size it fell FROM is the number that distinguishes a
  ceiling compaction from a premature one.
  -> verify: route test asserts the event fires only after confirmation.
- `ProxyConfig.contextMigration` — `holdOnCooldown` (default **on**: it only
  delays a request that was being re-routed anyway) and `askClientToCompact`
  (default **off**: it induces the failure mode, and the client's response to
  the 400 rests on one observation). Switchable without a rebuild, which matters
  for a proxy other machines depend on.
  -> verify: route tests pin both defaults, including that a huge session with
     an unavoidable move is NOT asked to compact unless opted in.

## Not done

- The live `~/.cc-router/config.json` was not touched. The defaults already give
  the safe behaviour, and the live proxy is serving two accounts.
- `dist/` not rebuilt (AGT-3912).
