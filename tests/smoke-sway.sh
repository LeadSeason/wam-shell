#!/usr/bin/env bash
# Opt-in sway smoke test (pnpm test:smoke:sway): boots the shell inside a
# nested sway and asserts the sway-only code paths run clean.
#
# Why this exists, specifically: `tests/smoke.sh` boots the shell on whatever
# compositor the developer is sitting in front of. For everyone working on this
# project so far that is hyprland, so `workspaces-sway`, `lib/sway` and the
# i3ipc paths have never once been constructed by a gate. Issue #229 is what
# that costs — a refactor deleted a declaration and left its four uses, the
# widget threw a ReferenceError the moment it was built, and the ENTIRE panel
# was gone on sway and i3 for eleven days with every gate green.
#
# The compositor is started and torn down by `tests/nested-sway.sh`, which also
# takes the seat and DRM precautions (and can be driven by hand — see its
# header). Everything below is assertions.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
NESTED="$ROOT/tests/nested-sway.sh"
INSTANCE="wam-shell-sway-test"

# ---------------------------------------------------------------- assertions
#
# Borrowed in shape from hy3's test/smoke.sh: a check that names what it was
# looking for, so a failure reads as a sentence rather than as a diff.
failures=0

check() { # check <label> <condition-cmd...>
    local label=$1
    shift
    if "$@"; then
        printf '  ok   %s\n' "$label"
    else
        printf '  FAIL %s\n' "$label" >&2
        failures=$((failures + 1))
    fi
}

check_eventually() { # check_eventually <label> <timeout_s> <condition-cmd...>
    local label=$1 timeout=$2
    shift 2
    local deadline=$((SECONDS + timeout))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if "$@"; then
            printf '  ok   %s\n' "$label"
            return 0
        fi
        sleep 0.25
    done
    printf '  FAIL %s (after %ss)\n' "$label" "$timeout" >&2
    failures=$((failures + 1))
    return 1
}

log_has() { grep -qE "$1" "$(bash "$NESTED" log)"; }
log_lacks() { ! grep -qE "$1" "$(bash "$NESTED" log)"; }

# ------------------------------------------------------------------ preflight
if ! command -v sway >/dev/null; then
    echo "skip: sway is not installed (pacman -S sway) — nothing to nest" >&2
    exit 0
fi
if [[ -z "${WAYLAND_DISPLAY:-}" ]]; then
    echo "skip: no WAYLAND_DISPLAY — the nested backend needs a wayland session" >&2
    exit 0
fi
if [[ ! -e node_modules/ags || ! -e node_modules/gnim ]]; then
    echo "error: node_modules/ags or node_modules/gnim missing." >&2
    echo "a bare checkout is not runnable — run scripts/setup.sh (or pnpm i) first." >&2
    exit 1
fi
if ags list 2>/dev/null | grep -qw "$INSTANCE"; then
    echo "skip: an instance named $INSTANCE is already running" >&2
    exit 0
fi
# same rule as smoke.sh: the nested shell must never be able to become the
# session's notification daemon
if ! gdbus call --session \
    --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.NameHasOwner \
    org.freedesktop.Notifications 2>/dev/null | grep -q true; then
    echo "skip: org.freedesktop.Notifications has no owner on the session bus;" >&2
    echo "      refusing to risk the nested instance becoming the notification daemon" >&2
    exit 0
fi

trap 'bash "$NESTED" stop >/dev/null 2>&1' EXIT

if ! bash "$NESTED" start; then
    echo "FAIL: could not bring up the nested sway" >&2
    exit 1
fi

# --------------------------------------------------------------------- checks
#
# The backend check is first and it is not a formality: the parent session's
# DESKTOP_SESSION is inherited, and a nested shell that detected hyprland would
# pass everything below while testing the widgets this file exists to avoid.
check "shell detected the sway backend" log_has "DesktopSession: sway"

# Exercise the widget rather than only its construction: #229 crashed inside a
# computed that re-runs on every workspace change.
bash "$NESTED" ctl workspace 2 >/dev/null 2>&1
bash "$NESTED" ctl workspace 3 >/dev/null 2>&1
bash "$NESTED" ctl workspace 1 >/dev/null 2>&1
sleep 1

check "no errors on the sway path" log_lacks "Gjs-CRITICAL|JS ERROR"
check "no undefined names (the #229 shape)" log_lacks "ReferenceError"
check_eventually "instance still alive after the workspace churn" 5 \
    bash -c 'ags list 2>/dev/null | grep -qw wam-shell-sway-test'

if [ "$failures" -ne 0 ]; then
    echo "FAIL smoke-sway: $failures check(s) failed" >&2
    echo "--- shell log ---" >&2
    tail -30 "$(bash "$NESTED" log)" >&2
    exit 1
fi

echo "ok   smoke-sway: $INSTANCE started clean on the sway backend"
