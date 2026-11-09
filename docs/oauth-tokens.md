# OAuth Tokens — How they work

## API keys vs OAuth tokens

Claude Code supports two types of credentials:

| Type | Prefix | Set via | Sent as |
|------|--------|---------|---------|
| API key | `sk-ant-api03-` | `ANTHROPIC_API_KEY` | `X-Api-Key` header |
| OAuth token | `sk-ant-oat01-` | `ANTHROPIC_AUTH_TOKEN` or login | `Authorization: Bearer` header |

**Claude Max subscriptions use OAuth tokens**, not API keys. When you run `claude login`, Claude Code performs an OAuth PKCE flow and stores the resulting access and refresh tokens.

## Token lifetime

| Token | Lifetime | What happens when it expires |
|-------|----------|------------------------------|
| Access token | ~8 hours | Must be refreshed using the refresh token |
| Refresh token | Weeks/months | Requires full re-login (`claude login`) |

**Critical:** refresh tokens **rotate** on every use. Each time cc-router refreshes an access token, the old refresh token is invalidated and replaced with a new one. If the new refresh token is not saved immediately, you lose access permanently.

cc-router handles this automatically with atomic file writes.

## Where Claude Code stores tokens

### macOS
Tokens are stored in the encrypted macOS Keychain:
```bash
security find-generic-password -s 'Claude Code-credentials' -w
```

Output (JSON):
```json
{
  "accessToken": "sk-ant-oat01-...",
  "refreshToken": "sk-ant-ort01-...",
  "expiresAt": "2026-04-04T06:23:45.000Z",
  "scopes": ["user:inference", "user:profile"]
}
```

### Linux / Windows
Tokens are stored in `~/.claude/.credentials.json`:
```bash
cat ~/.claude/.credentials.json | python3 -m json.tool
```

Output:
```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1748658860000,
    "scopes": ["user:inference", "user:profile"]
  }
}
```

## Adding multiple accounts

**Never leave a login behind that something else can refresh.** The refresh token rotates on every use, so
two holders of the same one cannot both stay valid: whichever refreshes first kills the other's copy, and
the router then finds `invalid_grant` hours later. The Keychain (or `~/.claude/.credentials.json`) copy that
`claude login` leaves is exactly such a holder.

Preferred: let `cc-router` run the login in a throwaway config directory and hand the tokens to the router.

```bash
# Replace a seat whose refresh token was refused (keeps its caps and session pins)
cc-router accounts relogin heewon --expect heewon@

# On a server, over ssh: it runs `claude auth login` and prints the URL to open anywhere.
```

On macOS the login lives in the Keychain, so use `cc-router accounts relogin <id> --from-keychain`: it
reads the Keychain login, replaces the seat, then removes the **account login** from the Keychain so the
router is the only holder. MCP server logins (Linear, Notion, Slack, …) live in the same Keychain item and are
kept. Do not delete the whole item with `security delete-generic-password`: it signs you out of every MCP
server. Do not `claude auth logout` either; it can revoke the token the router now uses.

To add a *new* seat the old way: log in with `claude auth login`, run `cc-router accounts add` (Keychain
or credentials file), then remove the CLI's copy with `relogin --from-keychain`, and log back in with your own account.

## Token scopes

cc-router requires these scopes:
- `user:inference` — make API requests
- `user:profile` — identify the account

If a refresh returns a token without `user:inference`, requests will fail with `403 Forbidden`.

## How cc-router refreshes tokens

cc-router uses the official Claude Code OAuth client ID to refresh tokens:

```
POST https://console.anthropic.com/api/oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "refresh_token": "sk-ant-ort01-...",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
}
```

The refresh loop runs every 5 minutes and refreshes any token with less than `tokenRefresh.leadMinutes` left (default 240, i.e. at half-life). Refreshing that early is deliberate: a refresh token that has died is found hours before the outage. The per-request path still refreshes inside the last 10 minutes. New tokens are written atomically (write to `.tmp`, rename) to prevent file corruption.

## OpenAI ChatGPT/Codex subscription tokens

Codex subscription auth is a separate provider path from Claude auth. OpenAI subscription records in CC-Router are tagged with:

```json
{
  "provider": "openai_subscription"
}
```

These records are not loaded into the Anthropic token pool. They are used by the OpenAI Responses-compatible `/v1/responses` route and by `/v1/messages` requests that explicitly select an `openai/*` model.

Recommended login:

```bash
cc-router accounts login-openai
```

This uses the Codex device-code flow documented by OpenAI's Codex app-server auth surface: CC-Router requests a one-time code from `https://auth.openai.com/api/accounts/deviceauth/usercode`, polls for authorization, exchanges the authorization code at `https://auth.openai.com/oauth/token`, and saves the resulting OpenAI subscription tokens.

To add one manually for debugging:

```bash
cc-router accounts add-openai
```

The command validates the record shape and appends or replaces only the matching OpenAI account. Anthropic token refreshes preserve OpenAI records in `accounts.json`.

OpenAI subscription refreshes use:

```http
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded
```

with `grant_type=refresh_token`. Refreshes are also deduplicated per account so two simultaneous requests cannot spend the same rotating refresh token at the same time.

The proxy refreshes OpenAI subscription tokens in two places:

- before forwarding a request when the access token expires within 10 minutes
- in a background loop every 5 minutes while the proxy is running

Successful refreshes are persisted atomically and preserve Claude account records in the same `accounts.json` file.

Treat OpenAI Codex refresh tokens as account credentials. Do not copy `~/.codex/auth.json` into bug reports, commits, logs, screenshots, or shared chat threads.
