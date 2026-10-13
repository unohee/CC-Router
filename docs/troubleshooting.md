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

**If the refresh token itself expired**, you need to re-add the account:
```bash
cc-router setup --add
# Log out and back in with that account in Claude Code first
```

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
`busy` flag. These deadlines are runtime state and are remeasured after restart.

The account is hitting Anthropic's rate limits. cc-router puts the account on cooldown for the `Retry-After` period automatically.

If it happens frequently with a single account, add more accounts:
```bash
cc-router setup --add
```

---

## Streaming (SSE) is broken or incomplete

This usually means a body-parsing middleware is interfering with the proxy.

If you're running cc-router behind another proxy (e.g. nginx), make sure:
- `proxy_buffering off` is set in nginx
- `X-Accel-Buffering: no` header is forwarded

cc-router itself does not buffer SSE — `selfHandleResponse` is always `false`.

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
[12:54:57] ✂ 9702d337 compacted (~998K → ~120K)
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

## Why did my session move accounts?

Look for a `⇄` line:

```
[09:15:03] ⇄ 4a1ab0b1 kyte → intrect (re-writing ~740K tokens of context)
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
