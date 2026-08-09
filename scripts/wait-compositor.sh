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

# Is a Hyprland IPC socket live right now?
#
# HYPRLAND_INSTANCE_SIGNATURE names the right one exactly, but it only
# reaches a systemd user unit if the compositor exported it (via
# dbus-update-activation-environment / systemctl import-environment, and
# that is itself racy at login) — so it is often absent here, and when
# present it can be STALE, naming a previous session's instance.
#
# So the environment is a hint and the filesystem is the authority: an
# instance directory whose .socket.sock exists is a live compositor,
# whatever any variable says.
#
# Emphatically NOT "the newest instance directory". Hyprland leaves its
# instance dirs behind when it exits, so a machine accumulates them, and
# the newest is routinely a corpse — measured on a real session with
# twelve of them, where the LIVE instance was the OLDEST and every newer
# dir was dead. Waiting on the newest meant waiting out the full timeout
# on every single start while a perfectly good socket sat next to it.
live_socket() {
    local sock
    # the named instance first: correct when it is set and current, and
    # the check below rejects it when it is not
    if [[ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]]; then
        sock="$RUNTIME/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket.sock"
        [[ -S "$sock" ]] && { printf '%s\n' "$sock"; return 0; }
    fi
    # otherwise: any instance dir with a live socket
    local dir
    for dir in "$RUNTIME"/hypr/*/; do
        sock="${dir%/}/.socket.sock"
        [[ -S "$sock" ]] && { printf '%s\n' "$sock"; return 0; }
    done
    return 1
}

main() {
    # nothing hyprland-shaped here at all (sway, i3, a bare login, a
    # nested run): start immediately, this is not our session type
    [[ -d "$RUNTIME/hypr" ]] || exit 0

    local waited=0
    # bash has no float arithmetic; count steps instead
    local steps=$((${TIMEOUT_SEC%.*} * 5))
    while :; do
        live_socket >/dev/null && exit 0
        ((waited >= steps)) && break
        sleep "$STEP"
        ((waited++))
    done
    # timed out: still exit 0 and let the shell try. Restart=always with
    # StartLimitIntervalSec=0 keeps retrying if it segfaults
    echo "wam: no live compositor socket after ${TIMEOUT_SEC}s; starting anyway" >&2
    exit 0
}

main "$@"
