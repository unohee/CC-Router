# Troubleshooting

## Claude Code is not connecting to the proxy

**Check if the proxy is configured:**
```bash
cc-router configure --show
```

Expected output:
```
Claude Code is configured to use cc-router:
  ANTHROPIC_BASE_URL  = http://localhost:3456
  ANTHROPIC_AUTH_TOKEN = proxy-managed
```

If it's not configured, run:
```bash
cc-router configure
```

**Check if the proxy is running:**
```bash
cc-router status --json
```

If you get "Cannot connect", start it:
```bash
cc-router start
# or as a background service:
cc-router service install
```

---

## 401 Unauthorized errors

The OAuth token is invalid or expired.

**Check token expiry:**
```bash
cc-router status --json | python3 -m json.tool
# Look at accounts[].expiresInMs
```

**Force a refresh:** restart the proxy — it refreshes all tokens on startup:
```bash
cc-router stop && cc-router start
```

**If the refresh token itself was refused** (`invalid_grant — Refresh token expired` in the log), restarting
cannot help; the seat needs a new login. See the next section.

---

## A seat says "needs re-login"

Health reports `accounts[].auth.state` as `ok`, `refresh-failing` or `needs-relogin`, and the dashboard,
the `status` TUI and the severity headline show `heewon needs re-login (3h0m left)`.

- `refresh-failing`: the refresh call failed for a passing reason (network, 5xx). The router retries with
  a backoff and the seat keeps serving. No action.
- `needs-relogin`: the server refused the refresh token (`invalid_grant`). The router asks **once** and then
  stops. The seat takes no new work while another seat can serve, and sessions pinned to it move to another
  seat at once. Only when no other seat can answer is it used, as a last resort, until its access token
  runs out; the countdown is in the headline. The
  background loop refreshes at half-life (`tokenRefresh.leadMinutes`, default 240), so this shows up hours
  before the outage rather than ten minutes before.

```bash
cc-router accounts relogin heewon --expect heewon@     # runs `claude auth login`; open the URL anywhere
cc-router accounts relogin heewon --from-keychain      # macOS: use the Keychain login, then remove it
```

It checks who logged in (`/api/oauth/profile`) before touching anything, then replaces the seat in the
running router, keeping its caps and session pins. Without a terminal it needs `--yes` or `--expect`.

**Why it happens.** A refresh token rotates on use, so only one holder of it can stay valid. A leftover
`claude` login holding the same token (Keychain, `~/.claude/.credentials.json`, another machine) refreshes
it behind the router's back. After a re-login, do not leave that copy behind; `--from-keychain` removes it.

---

## 429 Rate limit errors

Model-specific limits are separate from total account usage. For example,
Fable can exhaust its weekly allowance while the account's overall 5-hour and
weekly percentages remain below 100%. A Fable request carrying the
`seven_day_overage_included` claim now cools only the Fable family; Sonnet and
Opus remain eligible on that account. Explicit Opus/Sonnet weekly claims are
also scoped to their respective families. Unknown claims remain account-wide.

The health endpoint exposes active `modelCooldowns` (epoch milliseconds) per
account separately from `coolingUntil`. Scoped cooldowns do not set the global
`busy` flag. These deadlines, and each account's last rate-limit reading, are
saved to `account-state.json` beside `accounts.json` and restored after a
restart unless they have expired, so a restarted router does not try an
exhausted account again. To start from a clean slate, stop the router and move
that file aside.

The account is hitting Anthropic's rate limits. cc-router puts the account on cooldown for the `Retry-After` period automatically.

If it happens frequently with a single account, add more accounts:
```bash
cc-router setup --add
```

---

## Streaming (SSE) is broken or incomplete

**A stream that ended with `overloaded_error`.** The router's stream guard ended it: the upstream went silent
for `streamGuard.idleSeconds` (default 180), broke mid-response, or ended without `message_stop`. Nothing
after the first byte can be retried without duplicating output, so the router closes the stream in the form
Claude Code retries instead of letting it hang or keeping a cut answer. The log says which:

```
[ERROR] lyra: upstream stream went silent for 180s; ended with overloaded_error so the client retries
[ERROR] lyra: upstream stream broke mid-response; ended with overloaded_error so the client retries
```

Health counts them under `streamGuard` (`stalled`, `broken`, `truncated`), next to `firstByteTimeouts`:
streaming requests whose upstream sent no headers within `streamGuard.firstByteSeconds` (default 120) and
were failed over to the next seat (failover reason `timeout`) before the client saw anything.

```json
{ "streamGuard": { "firstByteSeconds": 120, "idleSeconds": 180 } }
```

`0` turns a guard off. Raise `idleSeconds` if a model legitimately pauses longer than that between events
(Anthropic sends `ping` events during long thinking, so this should be rare).

**A body-parsing middleware.** If streams arrive incomplete without any of the above in the log, a
middleware may be interfering with the proxy.

If you're running cc-router behind another proxy (e.g. nginx), make sure:
- `proxy_buffering off` is set in nginx
- `X-Accel-Buffering: no` header is forwarded

cc-router itself does not buffer SSE: every chunk is written to the client the moment it arrives.

---

## Claude Code ignores the proxy after system restart

The proxy is not set to auto-start. Either:

```bash
# Option A: manual start after reboot
cc-router start

# Option B: install as system service (auto-start)
cc-router service install
```

---

## `cc-router setup` doesn't find tokens on macOS

Claude Code must be logged in before running setup:
```bash
claude login          # log in with your Max account
cc-router setup       # now it can read from Keychain
```

If the Keychain entry is locked, the `security` command will prompt for your macOS password.

---

## Docker: cc-router container exits immediately

Check logs:
```bash
cc-router docker logs --service cc-router
# or: docker compose logs cc-router
```

Most likely cause: `accounts.json` is not mounted or is empty. Verify:
```bash
ls -la ~/.cc-router/accounts.json
cat ~/.cc-router/accounts.json
```

---

## Docker: LiteLLM fails to start

Check logs:
```bash
cc-router docker logs --service litellm
```

Common causes:
- `LITELLM_MASTER_KEY` not set in `.env`
- Port 4000 already in use (`lsof -i:4000`)
- Image pull failed (no internet, or image tag changed)

To use a specific LiteLLM version, edit `docker-compose.yml`:
```yaml
image: ghcr.io/berriai/litellm:v1.72.0  # pin a specific version
```

---

## "prompt is too long" — but Anthropic's window is 1M

Two of the responses you can see are written by cc-router itself, not by
Anthropic, and both carry an `x-cc-router-reason` header saying so. They exist
because moving a session between accounts is expensive: the prompt cache is
account-local and keys on an exact prefix, so the first request on the new
account re-writes the entire conversation. Measured at 600-750K tokens per move.

| Response | `x-cc-router-reason` | What it means |
| --- | --- | --- |
| 429 with `Retry-After` | `hold-session-on-account` | The pinned account is cooling down, but only briefly, and this session is large enough that waiting costs less than a rewrite. The pin is held; the client retries the same account. |
| 400 `prompt is too long: N tokens > M maximum` | `compact-before-account-move` | The pinned account is unusable with no deadline, so the move cannot be avoided. Claude Code answers this by compacting its own history, so the move carries a small prefix instead of a huge one. Asked at most once per session per 10 minutes. |

The numbers in that 400 are cc-router's policy thresholds, not Anthropic's
context window. If you want the old behaviour — move immediately, always — the
thresholds live in one place with their reasoning:
`src/proxy/session-migration.ts` (`DEFAULT_MIGRATION_LIMITS`).

Both mechanisms are switchable from `~/.cc-router/config.json`, so a proxy other
machines depend on can be changed without a rebuild:

```json
{
  "contextMigration": {
    "holdOnCooldown": true,
    "askClientToCompact": false
  }
}
```

`holdOnCooldown` defaults to **on** — it only ever delays a request that was
going to be re-routed anyway. `askClientToCompact` defaults to **off**: it
deliberately induces client compaction, which is the failure mode this area
exists to prevent, and the evidence that Claude Code answers the 400 by
compacting rather than by showing the user an error is a single observation
(2026-09-18). Turn it on once you have confirmed that on a long session.

Note what cc-router does **not** do: it never edits the conversation. Truncating
or summarising history inside the proxy would change the cached prefix and
therefore cause the very rewrite it was avoiding, would have to be re-applied
identically on every later turn, and would orphan `tool_result` blocks. Only the
client compacts.

## Is compaction firing too early?

Look for a `✂` line:

```
[2026-11-03 12:54:57Z] ✂ 9702d337 compacted (~998K → ~120K)
```

The first number is what matters. Compaction near the top of the window is a
long conversation working as intended. Compaction well below it means something
is capping the client early — which has happened here before: a global
`autoCompactWindow` of 800K once held every session down so that one target
which could not hold 1M stayed safe, and sessions were observed compacting at
767K on accounts with room to spare.

Measured on this host 2026-09-18, after that cap was retired: sessions compacted
at 830K, 863K, 902K, 964K and 998K against a 1M window — at the ceiling, three
compactions across a 2,460-turn session. If you start seeing `✂` lines in the
700Ks, something has re-capped the client; check for `autoCompactWindow` in
`~/.claude/settings.json` and for an OpenAI account back in the session pool
(`sessionPoolIncludesOpenAI`), which caps sessions to the pool minimum.

Note the router infers this: it sees a request whose prompt is a fraction of
what the session was carrying, confirmed by the following request. Claude Code
issues small side-calls under the same session id, so a single small request is
never enough to call it a compaction.

## Was my request retried on another account? (failover)

A `POST /v1/messages` that gets a 401 (the seat's token was revoked), a 429, a 529,
a 500/502/503/504, a token that could not be refreshed, or a dropped connection
before any byte is retried inside the router. The retry goes to the
next usable account with the same body, then to the Ollama fallback, and only
then is the refusal passed on. Look for:

```
  failover: lyra answered HTTP 429; retrying on vega (attempt 2)
  failover: no account left after 5 tried; relaying the last refusal (HTTP 503)
```

`/cc-router/health` → `failover` counts requests by how they ended
(`byOutcome.recovered`, `ollama`, `exhausted`, `refused`, `clientGone`) and by
what refused them (`byReason`). The dashboard's Failover card shows the same.

- **A 429 in the activity list, but Claude Code never saw one.** The router
  failed over from it. Such entries are marked `failedOver` and are not
  counted in the severity strip's "429 ×N in 5m".
- **A token spike after a retry.** The other account has no prompt cache for
  the session, so the retry rewrites it. A 5xx does not cool the first
  account, so the session's next turn goes back there and rewrites it again.
  This is the price of not failing the request.
- **A slow non-streaming request answered twice as late.** A proxy timeout
  before the headers counts as a connection error and is retried on another
  account.
- **Not retried:** other 4xx, anything after the first byte (SSE streams pass
  through as they are), and a bare 429 for a client without Claude Code
  identity (every account would refuse that client).
- **Turn it off:** set `routing.failover.enabled` to false
  (`{ "routing": { "failover": { "enabled": false } } }`). The client then gets
  the first refusal and retries itself.

---

## Did a deploy or restart drop my request? (handoff and drain)

Under `cc-router supervise` (the unit `scripts/deploy-remote.sh` installs), a deploy is a reload: a new worker
takes the socket and the old one finishes its streams. Health shows how the last one went:

```bash
curl -s http://<router>:3456/cc-router/health | jq '.supervisor, .worker'
# supervisor.generation        how many workers have run; +1 per reload or crash
# supervisor.lastHandoff       {finished, dropped, unsaved, drainMs, fromPid, toPid}
# supervisor.failedReloads     reloads abandoned because the new worker did not come up
# worker.frozen / draining     true only on a worker that is handing over or stopping
```

- `dropped > 0`: a stream outlived `drain.limitSeconds` (default 600) and was ended with `overloaded_error`;
  Claude Code retried it. Raise the limit if long turns are common.
- `unsaved > 0`: requests the old worker answered after it froze. They were served; only their usage
  counts are missing from the history.
- `failedReloads` went up: the new release did not start. The old worker is still serving the old build;
  look for `did not start listening` in the log. The deploy script rolls the `current` symlink back.
- Account changes (`cc-router accounts add|relogin`) answer 503 for the few seconds a worker is frozen;
  retry.

The log tells the story of a handoff:

```
[supervisor] SIGHUP: freezing worker 4121
  handoff: state saved and frozen; a new worker is starting
[supervisor] worker 4180 listening (generation 2); worker 4121 drains
handoff — draining 3 request(s) in flight (limit 600s)
  drained: 3 finished, 0 ended at the limit, 41s
```

A stop (SIGTERM) drains too: the port closes (new connections are refused, and clients retry), the
requests in flight finish, then state is saved. `systemctl --user restart` therefore takes as long as the
longest stream in flight; prefer `reload`.

## What is the demand governor doing?

`routing.governor` is off by default. With `enabled: true` and
`enforce: false` it only observes: it judges a stage (0–4), logs every change
and shows it in health, but applies nothing.

```
  governor stage 0 → 3 (observe only) — demand at 118% of today's budget
```

`/cc-router/health` → `governor` has `stage` (judged), `applied` (in effect:
0 unless `enforce`), `pressure`, `reason` and the last 24 hours (`hours`, with
changes and requests delayed).

- **Stuck at stage 0 with "no budget yet".** The supply model has no capacity
  estimate for any account yet. It needs 24 paired hourly readings per
  account, so the first day or so after an upgrade looks like this.
  `health.supply.accounts[].sevenDay.capacity.samples` shows the progress.
- **Requests feel slower at stage 4.** Low-priority requests (short one-shots,
  haiku-tier, or `x-cc-router-priority: low`) wait `delayMs` (2 s) first.
  Nothing opus-tier is ever delayed, and nothing is refused.
- **Pin a stage while testing:** `routing.governor.stageOverride` (0–4).
- **Back off:** set `enforce` to false and keep observing, or `enabled` to false.

---

## Why did my session move accounts?

Look for a `⇄` line:

```
[2026-11-03 09:15:03Z] ⇄ 4a1ab0b1 kyte → intrect (re-writing ~740K tokens of context)
```

That is the cost of the move, logged so the thresholds above can be tuned from
real numbers. Frequent moves on large sessions mean one account is spending most
of its time rate-limited — check `cc-router accounts list` for utilization.

---

## How do I go back to using Claude Code normally?

```bash
cc-router revert
```

This stops the proxy and removes cc-router's settings from `~/.claude/settings.json`. Claude Code will use its normal authentication on the next launch.
