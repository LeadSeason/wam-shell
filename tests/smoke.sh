#!/usr/bin/env bash
# Opt-in smoke test (pnpm test:smoke): boots the real shell as a separate,
# isolated "wam-shell-test" instance for a few seconds and asserts a clean
# startup. NOT part of pnpm test.
#
# Safety rules for the developer's live session:
#   - skips unless org.freedesktop.Notifications already has an owner, so
#     the test instance can never become the notification daemon
#   - only ever runs `ags quit -i wam-shell-test`, never a bare `ags quit`
#   - XDG_CONFIG_HOME / XDG_CACHE_HOME point at a tmp dir: no writes to the
#     user's real config or cache
#
# Known side effects (why this is opt-in): layer-shell windows flash on the
# live compositor for a few seconds, compileScss() refreshes the gitignored
# scss/theme/active-theme.scss and scss/user.scss in the source tree, and
# `ags run` writes its bundle payload to $XDG_RUNTIME_DIR/ags.js — the same
# as any normal shell start. XDG_RUNTIME_DIR is deliberately NOT redirected:
# the Wayland display, Hyprland IPC and (usually) D-Bus sockets live there.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
INSTANCE="wam-shell-test"

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
    echo "      refusing to risk the test instance becoming the notification daemon" >&2
    exit 0
fi

TMP="$(mktemp -d)"
cleanup() {
    ags quit -i "$INSTANCE" 2>/dev/null || true
    rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/config/wam-shell" "$TMP/cache"
cat > "$TMP/config/wam-shell/config.toml" <<EOF
instance_name = "$INSTANCE"

[notifications]
daemon = "system"
popups = false

[osd]
enabled = false
EOF

rc=0
XDG_CONFIG_HOME="$TMP/config" \
XDG_CACHE_HOME="$TMP/cache" \
WAM_SHELL_DIR="$ROOT" \
timeout 6 ags run app.tsx > "$TMP/log" 2>&1 || rc=$?

# the shell runs forever; 124 just means timeout(1) stopped it as planned
if [[ $rc -ne 0 && $rc -ne 124 ]]; then
    echo "FAIL: ags exited early with code $rc" >&2
    cat "$TMP/log" >&2
    exit 1
fi

if ! grep -q "InstancePath:" "$TMP/log"; then
    echo "FAIL: shell did not reach startup logging" >&2
    cat "$TMP/log" >&2
    exit 1
fi

if grep -qE "Gjs-CRITICAL|JS ERROR" "$TMP/log"; then
    echo "FAIL: errors during startup" >&2
    cat "$TMP/log" >&2
    exit 1
fi

echo "ok   smoke: $INSTANCE started clean"
