#!/usr/bin/env bash
# Runs ON the router host, started by scripts/deploy-remote.sh under setsid so a
# dropped ssh session cannot stop it halfway. Usage: deploy-host.sh <incoming dir>
#
# The incoming dir holds release.tgz, params.env and cc-router.service.in.
# Steps: unpack the release into <root>/releases/<sha> with production deps,
# render the unit, wait for a quiet moment, switch the `current` symlink,
# restart, and wait until health reports the new sha with the same account
# count and the dashboard answers. Any failure restores the previous symlink and
# unit and restarts the previous build. The last line is DEPLOY OK or DEPLOY FAILED.
set -euo pipefail

inc=${1:?usage: deploy-host.sh <incoming dir>}
# shellcheck disable=SC1091
. "$inc/params.env"
: "${SHA:?}" "${NODE:?}" "${ROOT:?}" "${HEALTH_URL:?}" "${UNIT:?}" "${BIND_HOST:?}" "${PORT:?}"
EXPECT_ACCOUNTS=${EXPECT_ACCOUNTS:-1}
QUIET_WAIT_SEC=${QUIET_WAIT_SEC:-600}
test "${DRY_RUN:-0}" = 1 && QUIET_WAIT_SEC=20
EXTRA_ENV_FILE=${EXTRA_ENV_FILE:-}
case "$ROOT" in /*) ;; *) ROOT="$HOME/$ROOT" ;; esac
export PATH="$(dirname "$NODE"):$PATH"

releases="$ROOT/releases"
rel="$releases/$SHA"
current="$ROOT/current"
unit_dir="$HOME/.config/systemd/user"
unit_file="$unit_dir/$UNIT.service"
router_log="$HOME/.cc-router/cc-router.log"
stamp=$(date +%Y%m%d-%H%M%S)

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

health() { curl -s --max-time 5 "$HEALTH_URL/cc-router/health" || true; }

# Reads a field from JSON on stdin; prints "" when absent or unparsable.
field() {
  node -e '
    let s = ""; const f = eval(process.argv[1]);
    process.stdin.on("data", d => s += d).on("end", () => {
      let v; try { v = f(JSON.parse(s)); } catch { v = undefined; }
      console.log(v === undefined || v === null ? "" : String(v));
    });' "$1"
}

prev_target=""
unit_backup=""
unit_changed=0
swapped=0

rollback() {
  local status=$?
  trap - ERR
  set +e
  log "failure (exit $status) — rolling back"
  if test "$swapped" = 1; then
    if test -n "$prev_target"; then
      ln -sfn "$prev_target" "$current.rollback" && mv -Tf "$current.rollback" "$current"
    else
      rm -f "$current"
    fi
  fi
  if test "$unit_changed" = 1; then
    if test -n "$unit_backup"; then cp -p "$unit_backup" "$unit_file"; else rm -f "$unit_file"; fi
    systemctl --user daemon-reload
  fi
  if test "$swapped" = 1 || test "$unit_changed" = 1; then
    systemctl --user restart "$UNIT"
    sleep 5
    log "after rollback: $(systemctl --user is-active "$UNIT") sha=$(health | field 'h => h.build && h.build.sha')"
  fi
  log "DEPLOY FAILED $SHA"
  exit 1
}
trap rollback ERR

log "deploying $SHA into $rel"
mkdir -p "$releases"

# 1. Unpack with production dependencies, once per sha.
if test ! -d "$rel"; then
  tmp="$rel.tmp-$stamp"
  mkdir -p "$tmp"
  tar xzf "$inc/release.tgz" -C "$tmp"
  (cd "$tmp" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  mv "$tmp" "$rel"
else
  log "release dir exists, reusing it"
fi
test -x "$rel/dist/cli/index.js"
version=$("$NODE" "$rel/dist/cli/index.js" --version)
test -n "$version"
test "$(field 'h => h.sha' < "$rel/dist/build-info.json")" = "$SHA"
log "release ok (version $version)"

# 2. Render the unit.
env_line=""
test -n "$EXTRA_ENV_FILE" && env_line="EnvironmentFile=-$EXTRA_ENV_FILE"
sed -e "s|@NODE@|$NODE|g" -e "s|@ROOT@|$ROOT|g" -e "s|@BIND_HOST@|$BIND_HOST|g" \
    -e "s|@PORT@|$PORT|g" -e "s|@ENV_FILE_LINE@|$env_line|g" \
    "$inc/cc-router.service.in" > "$inc/unit.rendered"
grep -q "ExecStart=$NODE $ROOT/current/dist/cli/index.js" "$inc/unit.rendered"
if grep -q '@[A-Z_]*@' "$inc/unit.rendered"; then log "unrendered placeholder in unit"; false; fi

# 3. What "the same" means after the restart.
before=$(health | field 'h => h.accounts.length')
if test -z "$before"; then
  before=$EXPECT_ACCOUNTS
  log "router not answering before deploy; expecting $before accounts"
else
  log "router answering with $before accounts, build $(health | field 'h => h.build && h.build.sha')"
fi
prev_target=$(readlink "$current" 2>/dev/null || true)

# 4. A quiet moment: no client request in flight (builds that report it), or
#    else a router log that has not grown for 15 s. Best effort, bounded.
deadline=$(( $(date +%s) + QUIET_WAIT_SEC ))
quiet=0
last_size=-1; same_since=$(date +%s)
while test "$(date +%s)" -lt "$deadline"; do
  n=$(health | field 'h => h.inFlight ? h.inFlight.requests : "unknown"')
  if test "$n" = 0; then quiet=1; break; fi
  if test "$n" = unknown || test -z "$n"; then
    size=$(stat -c %s "$router_log" 2>/dev/null || echo 0)
    if test "$size" != "$last_size"; then last_size=$size; same_since=$(date +%s); fi
    if test $(( $(date +%s) - same_since )) -ge 15; then quiet=1; break; fi
  fi
  sleep 1
done
if test "$quiet" = 1; then log "quiet moment found"; else log "no quiet moment within ${QUIET_WAIT_SEC}s; restarting anyway"; fi

if test "${DRY_RUN:-0}" = 1; then
  trap - ERR
  log "dry run: unit would $(cmp -s "$inc/unit.rendered" "$unit_file" && echo stay || echo change); current stays ${prev_target:-none}"
  log "DEPLOY DRY-RUN OK $SHA"
  exit 0
fi

# 5. Install the unit if it changed, switch, restart.
mkdir -p "$unit_dir"
if ! cmp -s "$inc/unit.rendered" "$unit_file"; then
  if test -f "$unit_file"; then
    unit_backup="$unit_file.bak-$stamp"
    cp -p "$unit_file" "$unit_backup"
  fi
  unit_changed=1
  cp "$inc/unit.rendered" "$unit_file"
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1 || true
  log "unit updated (backup: ${unit_backup:-none})"
fi
ln -sfn "$rel" "$current.new"
mv -Tf "$current.new" "$current"
swapped=1
log "current -> $rel (was ${prev_target:-none}); restarting"
systemctl --user restart "$UNIT"

# 6. Wait for the new build with the same accounts.
ok=0
for _ in $(seq 1 90); do
  h=$(health)
  if test "$(printf '%s' "$h" | field 'h => h.build && h.build.sha')" = "$SHA" &&
     test "$(printf '%s' "$h" | field 'h => h.accounts.length')" = "$before"; then
    ok=1; break
  fi
  sleep 1
done
test "$ok" = 1
test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL/cc-router/dashboard")" = 200
test "$(systemctl --user is-active "$UNIT")" = active
trap - ERR

# 7. Keep the five newest releases, never the live or the previous one.
keep_prev=$(basename "${prev_target:-none}")
{ ls -1t "$releases" | grep -E '^[0-9a-f]{7,64}$' || true; } | tail -n +6 | while read -r old; do
  test "$old" = "$SHA" && continue
  test "$old" = "$keep_prev" && continue
  rm -rf "${releases:?}/$old"
done || true

log "DEPLOY OK $SHA"
