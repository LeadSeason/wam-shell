#!/usr/bin/env bash
# Opt-in sway smoke test (pnpm test:smoke:sway): boots the shell inside a
# NESTED sway and asserts the sway-only code paths run clean.
#
# Why this exists, specifically: `tests/smoke.sh` boots the shell on
# whatever compositor the developer is sitting in front of. For everyone
# working on this project so far that is hyprland, so `workspaces-sway`,
# `lib/sway` and the i3ipc paths have never once been constructed by a
# gate. Issue #229 is what that costs — a refactor deleted a declaration
# and left its four uses, the widget threw a ReferenceError the moment it
# was built, and the ENTIRE panel was gone on sway and i3 for eleven
# days. Every gate was green the whole time.
#
# Nested rather than a real session: sway's wayland backend runs it as a
# window inside the running compositor, so this needs no VT, no seatd and
# no logout. It is still opt-in, because it flashes a window on screen
# for a few seconds and needs sway installed.
#
# Safety rules, the same ones smoke.sh follows:
#   - skips unless org.freedesktop.Notifications already has an owner, so
#     the nested shell can never become the notification daemon
#   - only ever runs `ags quit -i wam-shell-sway-test`, never a bare one
#   - XDG_CONFIG_HOME / XDG_CACHE_HOME point at a tmp dir
#   - the nested sway is killed by PID, not by name
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
INSTANCE="wam-shell-sway-test"

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
if ! gdbus call --session \
    --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.NameHasOwner \
    org.freedesktop.Notifications 2>/dev/null | grep -q true; then
    echo "skip: org.freedesktop.Notifications has no owner on the session bus;" >&2
    echo "      refusing to risk the nested instance becoming the notification daemon" >&2
    exit 0
fi

TMP="$(mktemp -d)"
SWAY_PID=""
cleanup() {
    ags quit -i "$INSTANCE" 2>/dev/null || true
    [[ -n "$SWAY_PID" ]] && kill "$SWAY_PID" 2>/dev/null
    rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/config/wam-shell" "$TMP/cache"
cat >"$TMP/config/wam-shell/config.toml" <<EOF
instance_name = "$INSTANCE"

[workspaces]
hide_empty = false

[notifications]
daemon = "system"
popups = false

[osd]
enabled = false
EOF

# DESKTOP_SESSION is what src/config.ts reads to pick the compositor
# backend — NOT XDG_CURRENT_DESKTOP — and the parent session's value is
# inherited by the nested one. Without this the shell detects the HOST
# compositor and builds the hyprland widgets, so the test passes while
# exercising nothing it exists to exercise.
#
# SWAYSOCK is written out by the nested sway itself: globbing
# /run/user/*/sway-ipc.* would just as happily find a real sway session.
cat >"$TMP/sway.conf" <<EOF
output * resolution 1280x720 position 0,0
exec sh -c 'printf "%s" "\$SWAYSOCK" > "$TMP/swaysock"'
exec env XDG_CONFIG_HOME="$TMP/config" XDG_CACHE_HOME="$TMP/cache" \\
    WAM_SHELL_DIR="$ROOT" DESKTOP_SESSION=sway XDG_CURRENT_DESKTOP=sway \\
    ags run "$ROOT/app.tsx" > "$TMP/log" 2>&1
EOF

WLR_BACKENDS=wayland WLR_RENDERER=pixman sway -c "$TMP/sway.conf" >"$TMP/sway.log" 2>&1 &
SWAY_PID=$!

# wait for the shell inside it, up to ~15s
for _ in $(seq 1 60); do
    ags list 2>/dev/null | grep -qw "$INSTANCE" && break
    sleep 0.25
done

if ! ags list 2>/dev/null | grep -qw "$INSTANCE"; then
    echo "FAIL: the shell never started inside the nested sway" >&2
    cat "$TMP/log" "$TMP/sway.log" >&2
    exit 1
fi

# Exercise the widget rather than only its construction: the crash in
# #229 was in a computed that re-runs on every workspace change, so
# switching workspaces is what actually walks that code.
if [[ -s "$TMP/swaysock" ]]; then
    SWAYSOCK="$(cat "$TMP/swaysock")" swaymsg workspace 2 >/dev/null 2>&1
    SWAYSOCK="$(cat "$TMP/swaysock")" swaymsg workspace 1 >/dev/null 2>&1
    sleep 1
else
    echo "warn: never learned the nested SWAYSOCK; construction was checked, not the switch" >&2
fi

fail=0
if ! grep -q "DesktopSession: sway" "$TMP/log"; then
    echo "FAIL: the shell did not detect sway — it tested the wrong backend" >&2
    grep -E "DesktopSession|InstancePath" "$TMP/log" >&2
    fail=1
fi
if grep -qE "Gjs-CRITICAL|JS ERROR" "$TMP/log"; then
    echo "FAIL: errors on the sway path" >&2
    grep -E "Gjs-CRITICAL|JS ERROR" "$TMP/log" >&2
    fail=1
fi

[[ $fail -ne 0 ]] && exit 1

echo "ok   smoke-sway: $INSTANCE started clean on the sway backend"
