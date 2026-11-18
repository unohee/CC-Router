#!/usr/bin/env bash
# Checks that the deployed router really serves the checked-out commit.
#
#   scripts/smoke-remote.sh [expected-sha]     (default: git rev-parse HEAD)
#
# Reads the base URL and minimum account count from $CC_ROUTER_DEPLOY_ENV
# (default ~/.cc-router/deploy.env; see scripts/deploy-remote.sh), and the proxy
# secret from ~/.cc-router/config.json (client.remoteSecret, else proxySecret).
# Every probe is quota-free: health, the dashboard page, and count_tokens.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
env_file=${CC_ROUTER_DEPLOY_ENV:-$HOME/.cc-router/deploy.env}
# shellcheck disable=SC1090
. "$env_file"
: "${DEPLOY_HEALTH_URL:?set in $env_file}"
min_accounts=${DEPLOY_EXPECT_ACCOUNTS:-1}
want=${1:-$(git -C "$repo" rev-parse HEAD)}
base=${DEPLOY_HEALTH_URL%/}

fail() { printf '[smoke] FAILED: %s\n' "$*" >&2; exit 1; }

h=$(curl -sf --max-time 10 "$base/cc-router/health") || fail "health did not answer 200"
read -r sha accounts healthy status < <(printf '%s' "$h" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const h = JSON.parse(s);
    const accts = Array.isArray(h.accounts) ? h.accounts : [];
    console.log([h.build && h.build.sha || "none", accts.length, accts.filter(a => a.healthy).length, h.status || "none"].join(" "));
  });')
test "$sha" = "$want" || fail "health reports build $sha, expected $want"
test "$accounts" -ge "$min_accounts" || fail "health lists $accounts accounts, expected at least $min_accounts"
test "$healthy" -ge 1 || fail "no healthy account"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base/cc-router/dashboard")
test "$code" = 200 || fail "dashboard answered $code"

secret=$(node -e '
  const c = JSON.parse(require("fs").readFileSync(require("os").homedir() + "/.cc-router/config.json", "utf8"));
  console.log((c.client && c.client.remoteSecret) || c.proxySecret || "");')
test -n "$secret" || fail "no proxy secret in ~/.cc-router/config.json"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$base/v1/messages/count_tokens" \
  -H "authorization: Bearer $secret" -H "content-type: application/json" -H "anthropic-version: 2023-06-01" \
  --data '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"ping"}]}')
test "$code" = 200 || fail "count_tokens through the router answered $code"

printf '[smoke] OK: build %s, %s accounts (%s healthy, status %s), dashboard 200, count_tokens 200\n' \
  "${sha:0:12}" "$accounts" "$healthy" "$status"
