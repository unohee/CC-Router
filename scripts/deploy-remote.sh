#!/usr/bin/env bash
# Deploys the checked-out commit to the router host.
#
#   scripts/deploy-remote.sh               build here, stage a release on the host, switch to it
#   scripts/deploy-remote.sh --self-test   build and check the bundle and the rendered unit; no ssh
#   scripts/deploy-remote.sh --dry-run     stage the release on the host and render the unit; no switch, no restart
#
# Host specifics live outside this repository in $CC_ROUTER_DEPLOY_ENV
# (default ~/.cc-router/deploy.env), a shell file setting:
#   DEPLOY_SSH              ssh destination (an alias from ~/.ssh/config)
#   DEPLOY_HEALTH_URL       router base URL as seen from the host and from here
#   DEPLOY_ROOT             release root on the host, absolute or relative to its $HOME
#   DEPLOY_NODE             absolute path of the node binary on the host
#   DEPLOY_BIND_HOST        address the router listens on (the unit's HOST)
#   DEPLOY_PORT             port (default 3456)
#   DEPLOY_UNIT             systemd user unit name (default cc-router)
#   DEPLOY_EXPECT_ACCOUNTS  account count when the router is down before the deploy (default 1)
#   DEPLOY_QUIET_WAIT_SEC   how long to wait for no request in flight before a restart (default 600)
#   DEPLOY_EXTRA_ENV_FILE   optional EnvironmentFile for the unit (default none)
#
# The host part (deploy/deploy-host.sh) runs under setsid. Once the supervisor
# runs (`cc-router supervise`) and the unit is unchanged, it switches with
# `systemctl --user reload`, which drops no request; otherwise it waits for a
# quiet moment and restarts. It rolls back the release symlink and the unit on
# any failure; this script follows its log and exits 0 only on "DEPLOY OK".
set -euo pipefail

mode=deploy
dry_run=0
case "${1:-}" in
  --self-test) mode=self-test ;;
  --dry-run) mode=deploy; dry_run=1 ;;
  "") ;;
  *) echo "usage: $0 [--self-test|--dry-run]" >&2; exit 2 ;;
esac

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
env_file=${CC_ROUTER_DEPLOY_ENV:-$HOME/.cc-router/deploy.env}

if test -f "$env_file"; then
  # shellcheck disable=SC1090
  . "$env_file"
elif test "$mode" = deploy; then
  echo "missing $env_file (see the header of this script)" >&2
  exit 1
fi
if test "$mode" = self-test; then
  # The self-test renders with placeholders when no env file is present.
  DEPLOY_SSH=${DEPLOY_SSH:-selftest}
  DEPLOY_HEALTH_URL=${DEPLOY_HEALTH_URL:-http://127.0.0.1:3456}
  DEPLOY_ROOT=${DEPLOY_ROOT:-cc-router}
  DEPLOY_NODE=${DEPLOY_NODE:-/usr/bin/node}
  DEPLOY_BIND_HOST=${DEPLOY_BIND_HOST:-127.0.0.1}
fi
: "${DEPLOY_SSH:?}" "${DEPLOY_HEALTH_URL:?}" "${DEPLOY_ROOT:?}" "${DEPLOY_NODE:?}" "${DEPLOY_BIND_HOST:?}"
DEPLOY_PORT=${DEPLOY_PORT:-3456}
DEPLOY_UNIT=${DEPLOY_UNIT:-cc-router}
DEPLOY_EXPECT_ACCOUNTS=${DEPLOY_EXPECT_ACCOUNTS:-1}
DEPLOY_QUIET_WAIT_SEC=${DEPLOY_QUIET_WAIT_SEC:-600}
DEPLOY_EXTRA_ENV_FILE=${DEPLOY_EXTRA_ENV_FILE:-}

say() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] FAILED: %s\n' "$*" >&2; exit 1; }

sha=$(git rev-parse HEAD)
if test "$mode" = deploy && test -n "$(git status --porcelain --untracked-files=no)"; then
  fail "tracked files differ from $sha; deploy a clean checkout"
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/cc-router-deploy.XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

# ─── Build and bundle ────────────────────────────────────────────────────────
test -d node_modules || npm ci --no-audit --no-fund --loglevel=error
CC_ROUTER_BUILD_SHA=$sha npm run build >"$work/build.log" 2>&1 || { tail -30 "$work/build.log" >&2; fail "build"; }
test "$(node -e 'console.log(JSON.parse(require("fs").readFileSync("dist/build-info.json","utf8")).sha)')" = "$sha" \
  || fail "dist/build-info.json does not carry $sha"

stage="$work/release"
mkdir -p "$stage/src/interceptor"
cp -R dist "$stage/dist"
cp package.json package-lock.json "$stage/"
test -f litellm-config.yaml && cp litellm-config.yaml "$stage/"
test -f src/interceptor/addon.py && cp src/interceptor/addon.py "$stage/src/interceptor/"
chmod 755 "$stage/dist/cli/index.js"
# bsdtar (macOS) would carry extended attributes that GNU tar warns about on the host.
tar_flags=()
if tar --version 2>/dev/null | grep -q bsdtar; then tar_flags=(--no-xattrs --no-mac-metadata); fi
COPYFILE_DISABLE=1 tar "${tar_flags[@]+"${tar_flags[@]}"}" -czf "$work/release.tgz" -C "$stage" .

listing=$(tar tzf "$work/release.tgz")
for f in ./dist/cli/index.js ./dist/build-info.json ./dist/continuity/verified-clients.json ./dist/proxy/server.js ./package.json ./package-lock.json; do
  printf '%s\n' "$listing" | grep -qx "$f" || fail "bundle lacks $f"
done
if printf '%s\n' "$listing" | grep -q '/\._'; then fail "bundle carries macOS metadata files"; fi

{
  printf 'SHA=%q\n' "$sha"
  printf 'NODE=%q\n' "$DEPLOY_NODE"
  printf 'ROOT=%q\n' "$DEPLOY_ROOT"
  printf 'HEALTH_URL=%q\n' "$DEPLOY_HEALTH_URL"
  printf 'UNIT=%q\n' "$DEPLOY_UNIT"
  printf 'BIND_HOST=%q\n' "$DEPLOY_BIND_HOST"
  printf 'PORT=%q\n' "$DEPLOY_PORT"
  printf 'EXPECT_ACCOUNTS=%q\n' "$DEPLOY_EXPECT_ACCOUNTS"
  printf 'QUIET_WAIT_SEC=%q\n' "$DEPLOY_QUIET_WAIT_SEC"
  printf 'EXTRA_ENV_FILE=%q\n' "$DEPLOY_EXTRA_ENV_FILE"
  printf 'DRY_RUN=%q\n' "$dry_run"
} > "$work/params.env"
cp deploy/cc-router.service.in deploy/deploy-host.sh "$work/"

# ─── Self-test: everything the host would get, checked here ──────────────────
if test "$mode" = self-test; then
  bash -n deploy/deploy-host.sh || fail "deploy-host.sh does not parse"
  (. "$work/params.env"; test "$SHA" = "$sha") || fail "params.env does not round-trip"
  sed -e "s|@NODE@|/usr/bin/node|g" -e "s|@ROOT@|/srv/cc-router|g" -e "s|@BIND_HOST@|127.0.0.1|g" \
      -e "s|@PORT@|3456|g" -e "s|@ENV_FILE_LINE@||g" deploy/cc-router.service.in > "$work/unit"
  grep -q '^ExecStart=/usr/bin/node /srv/cc-router/current/dist/cli/index.js supervise --port 3456$' "$work/unit" \
    || fail "unit ExecStart does not run the supervisor from the current release"
  grep -q '^WorkingDirectory=/srv/cc-router$' "$work/unit" || fail "unit WorkingDirectory must be the stable release root"
  grep -q '^ExecReload=/bin/kill -HUP \$MAINPID$' "$work/unit" || fail "unit has no ExecReload"
  grep -q '^KillMode=mixed$' "$work/unit" || fail "unit KillMode must be mixed (SIGTERM to the supervisor only)"
  stop_sec=$(sed -n 's/^TimeoutStopSec=\([0-9]*\)$/\1/p' "$work/unit")
  test "${stop_sec:-0}" -gt 600 || fail "unit TimeoutStopSec ($stop_sec) must exceed the 600 s drain limit"
  if grep -q '@[A-Z_]*@' "$work/unit"; then fail "unit has an unrendered placeholder"; fi
  mkdir -p "$work/unpack" && tar xzf "$work/release.tgz" -C "$work/unpack"
  test -x "$work/unpack/dist/cli/index.js" || fail "cli entry is not executable in the bundle"
  say "self-test OK: bundle for $sha ($(du -h "$work/release.tgz" | cut -f1)), unit renders, host script parses"
  exit 0
fi

# ─── Ship and run on the host ────────────────────────────────────────────────
inc="$DEPLOY_ROOT/incoming/$(date +%Y%m%d-%H%M%S)-${sha:0:12}"
say "shipping $sha to $DEPLOY_SSH:$inc"
ssh -o BatchMode=yes "$DEPLOY_SSH" "mkdir -p '$inc'"
scp -q -o BatchMode=yes "$work/release.tgz" "$work/params.env" "$work/cc-router.service.in" "$work/deploy-host.sh" "$DEPLOY_SSH:$inc/"
ssh -o BatchMode=yes "$DEPLOY_SSH" "setsid -f bash '$inc/deploy-host.sh' '$inc' > '$inc/deploy.log' 2>&1 < /dev/null"

# Follow the host log until it ends. ssh may drop while the router restarts
# (this session may ride on it); a failed poll is retried, not fatal.
deadline=$(( $(date +%s) + 1800 ))
shown=0
while test "$(date +%s)" -lt "$deadline"; do
  sleep 5
  out=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$DEPLOY_SSH" "cat '$inc/deploy.log'" 2>/dev/null) || continue
  lines=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
  if test "$lines" -gt "$shown"; then printf '%s\n' "$out" | tail -n +"$((shown + 1))"; shown=$lines; fi
  if printf '%s\n' "$out" | grep -q "^\[.*\] DEPLOY OK $sha$"; then say "done: $sha is live"; exit 0; fi
  if printf '%s\n' "$out" | grep -q "^\[.*\] DEPLOY DRY-RUN OK $sha$"; then say "dry run done: $sha staged, nothing switched"; exit 0; fi
  if printf '%s\n' "$out" | grep -q "DEPLOY FAILED"; then fail "host rolled back (log: $DEPLOY_SSH:$inc/deploy.log)"; fi
done
fail "no result from the host within 30 min (log: $DEPLOY_SSH:$inc/deploy.log)"
