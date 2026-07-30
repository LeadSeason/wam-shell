#!/usr/bin/env bash
# Perf harness: measures one checkout on an isolated instance.
#
#   tests/perf/run.sh [idle-1mon|churn|startup ...]   (default: all)
#
# One single-line JSON blob per scenario on stdout; progress and
# diagnostics on stderr.
#
# Isolation (the developer's real shell runs on the same session):
#   - fixture config -> instance_name wam-shell-perf, copied into a
#     fresh per-leg tmp XDG_CONFIG_HOME (the real config can't leak in)
#   - XDG_CACHE_HOME is a fresh per-leg tmp dir (style.css et al.)
#   - notifications.daemon = "system" in the fixture, plus a preflight
#     that refuses to run when org.freedesktop.Notifications has no
#     owner (the measured instance must never become the daemon)
#   - cleanup is trapped and only ever runs `ags quit -i wam-shell-perf`
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
INSTANCE="wam-shell-perf"
WINDOW=20
CHURN_CYCLES=100
CHURN_COMMANDS=(launcher notifications media harvest qSettings)

TMP=""
SHELL_PID=""

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

cleanup() {
    ags quit -i "$INSTANCE" >/dev/null 2>&1 || true
    if [[ -n "$SHELL_PID" ]]; then kill "$SHELL_PID" 2>/dev/null || true; fi
    if ags list 2>/dev/null | grep -qw "$INSTANCE"; then
        log "WARNING: $INSTANCE still running after cleanup"
    fi
    [[ -n "$TMP" ]] && rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# --- preflight ---------------------------------------------------------

[[ -e node_modules/ags && -e node_modules/gnim ]] \
    || die "node_modules/ags or node_modules/gnim missing — run scripts/setup.sh (or pnpm i) first"
command -v ags >/dev/null || die "ags not found in PATH"

if ags list 2>/dev/null | grep -qw "$INSTANCE"; then
    die "an instance named $INSTANCE is already running"
fi
if ! gdbus call --session \
    --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.NameHasOwner \
    org.freedesktop.Notifications 2>/dev/null | grep -q true; then
    die "org.freedesktop.Notifications has no owner on the session bus;
      refusing to risk the measured instance becoming the notification daemon"
fi

# --- helpers -----------------------------------------------------------

request() { ags request -i "$INSTANCE" "$@" 2>/dev/null; }

# response is "<instance>: <json>"; strip the prefix
request_json() { request "$@" | sed 's/^[^{]*//'; }

prepare_leg() {
    LEG="$TMP/$1"
    mkdir -p "$LEG/config/wam-shell" "$LEG/cache"
    cp tests/perf/fixtures/config.toml "$LEG/config/wam-shell/config.toml"
}

start_shell() {
    XDG_CONFIG_HOME="$LEG/config" \
    XDG_CACHE_HOME="$LEG/cache" \
    WAM_SHELL_METRICS=1 \
    WAM_SHELL_DIR="$ROOT" \
    timeout 300 ags run app.tsx > "$LEG/shell.log" 2>&1 &
    SHELL_PID=$!
}

wait_ready() {
    local i
    for i in $(seq 1 40); do
        if [[ "$(request metrics)" == *'"enabled":true'* ]]; then return 0; fi
        sleep 1
    done
    log "shell log:"
    cat "$LEG/shell.log" >&2
    die "instance did not come up"
}

stop_shell() {
    ags quit -i "$INSTANCE" >/dev/null 2>&1 || true
    wait "$SHELL_PID" 2>/dev/null || true
    SHELL_PID=""
}

# --- scenarios ---------------------------------------------------------

scenario_idle() {
    prepare_leg idle-1mon
    start_shell
    wait_ready
    request "metrics reset" > /dev/null
    log "idle-1mon: measuring ${WINDOW}s"
    sleep "$WINDOW"
    local m
    m="$(request_json metrics)"
    stop_shell
    printf '{"scenario":"idle-1mon","windowSec":%d,"metrics":%s}\n' "$WINDOW" "$m"
}

scenario_churn() {
    prepare_leg churn
    start_shell
    wait_ready
    request "metrics reset" > /dev/null
    log "churn: ${CHURN_CYCLES} cycles over ${#CHURN_COMMANDS[@]} popups"
    local i cmd
    for i in $(seq 1 "$CHURN_CYCLES"); do
        for cmd in "${CHURN_COMMANDS[@]}"; do
            request "$cmd" > /dev/null   # open
            request "$cmd" > /dev/null   # close
        done
    done
    # force a GC before the final read so leak counts aren't polluted
    # by uncollected garbage
    request "metrics gc" > /dev/null
    local m
    m="$(request_json metrics)"
    stop_shell
    printf '{"scenario":"churn","cycles":%d,"metrics":%s}\n' "$CHURN_CYCLES" "$m"
}

scenario_startup() {
    prepare_leg startup
    local t0 t1 ms
    t0=$(date +%s%3N)
    start_shell
    # no sleep in the poll loop: the request duration is the quantum
    while true; do
        if [[ "$(request metrics)" == *'"enabled":true'* ]]; then break; fi
        if ! kill -0 "$SHELL_PID" 2>/dev/null; then
            cat "$LEG/shell.log" >&2
            die "instance died during startup"
        fi
    done
    t1=$(date +%s%3N)
    ms=$((t1 - t0))
    local m blocking
    m="$(request_json metrics)"
    blocking="$(printf '%s' "$m" | grep -o '"blockingMs":[0-9.]*' \
        | awk -F: '{ s += $2 } END { printf "%.3f", s }')"
    stop_shell
    printf '{"scenario":"startup","timeToResponsiveMs":%d,"blockingMsTotal":%s,"metrics":%s}\n' \
        "$ms" "$blocking" "$m"
}

# --- main --------------------------------------------------------------

TMP="$(mktemp -d)"
SCENARIOS=("$@")
[[ ${#SCENARIOS[@]} -eq 0 ]] && SCENARIOS=(idle-1mon churn startup)

for s in "${SCENARIOS[@]}"; do
    case "$s" in
        idle-1mon) scenario_idle ;;
        churn) scenario_churn ;;
        startup) scenario_startup ;;
        *) die "unknown scenario: $s" ;;
    esac
done
