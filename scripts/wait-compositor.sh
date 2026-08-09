#!/usr/bin/env bash
# Wait for the compositor IPC socket to exist, then exit.
#
# Why this exists: astal reads the Hyprland IPC connection without
# checking that the connect succeeded, so starting the shell before the
# socket is there segfaults inside the library (#225) — a crash no
# try/catch in JS can reach, because it is not an exception. Three cores
# 71 seconds apart is what it looks like from outside: crash, restart,
# socket still not ready, crash.
#
# ALWAYS exits 0. This is a delay, never a gate: a session with no socket
# to wait for (sway, i3, a bare login, a nested/headless run) must start
# the shell exactly as it does today, and a socket that never appears is
# the restart policy's problem, not ours. Nothing here should be able to
# stop the shell from being tried.
#
# Used as ExecStartPre= in the unit `wam autostart enable` writes, and by
# `wam start`.
set -u

TIMEOUT_SEC="${WAM_WAIT_TIMEOUT:-10}"
# poll interval; the socket appears within a second or two in practice
STEP=0.2
RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# The socket to wait for, or empty when there is nothing to wait for.
#
# HYPRLAND_INSTANCE_SIGNATURE names it exactly, but it only reaches a
# systemd user unit if the compositor exported it (hyprland does this via
# dbus-update-activation-environment / systemctl import-environment, and
# that is itself racy at login). So fall back to the instance directory:
# if $XDG_RUNTIME_DIR/hypr exists at all, a hyprland session is starting
# and its socket is worth waiting for even when the variable has not
# landed in our environment yet.
target_socket() {
    if [[ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]]; then
        printf '%s\n' "$RUNTIME/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket.sock"
        return
    fi
    [[ -d "$RUNTIME/hypr" ]] || return
    # newest instance dir: a stale one from a previous session may still
    # be lying around, and its socket is gone
    local newest
    newest="$(ls -1dt "$RUNTIME"/hypr/*/ 2>/dev/null | head -1)"
    [[ -n "$newest" ]] && printf '%s\n' "${newest%/}/.socket.sock"
}

main() {
    local sock
    sock="$(target_socket)"
    # not a hyprland session (or nothing to wait for): start now
    [[ -z "$sock" ]] && exit 0

    local waited=0
    # bash has no float arithmetic; count steps instead
    local steps=$((${TIMEOUT_SEC%.*} * 5))
    while ((waited < steps)); do
        [[ -S "$sock" ]] && exit 0
        sleep "$STEP"
        ((waited++))
        # HIS may land in the environment after we started polling a
        # guessed path; re-resolve so we do not wait out the timeout on
        # a stale instance dir
        if [[ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]]; then
            sock="$RUNTIME/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket.sock"
        fi
    done
    # timed out: still exit 0 and let the shell try. Restart=always with
    # StartLimitIntervalSec=0 keeps retrying if it segfaults
    echo "wam: compositor socket did not appear in ${TIMEOUT_SEC}s; starting anyway" >&2
    exit 0
}

main "$@"
