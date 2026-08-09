#!/usr/bin/env bash
# A throwaway nested sway, with this checkout's shell running inside it.
#
#   tests/nested-sway.sh start    start it (and the shell)
#   tests/nested-sway.sh sock     print its SWAYSOCK
#   tests/nested-sway.sh ctl ...  run swaymsg against it
#   tests/nested-sway.sh log      print the shell's log path
#   tests/nested-sway.sh stop     kill it
#
# `tests/smoke-sway.sh` drives this for the assertions; the subcommands exist
# so the same session can be poked at by hand, which is what actually happens
# when something on the sway path misbehaves.
#
# The structure and most of the safety reasoning here is lifted from hy3's
# `test/nested.sh` (a nested *Hyprland* harness for the same developer's other
# project). Two of its hazards are wlroots-level rather than Hyprland-level and
# are guarded the same way below — see LIBSEAT_BACKEND and the output check.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
INSTANCE="wam-shell-sway-test"
RUNDIR="${TMPDIR:-/tmp}/wam-shell-nested-sway"
# A private XDG_RUNTIME_DIR. sway puts its IPC socket in $XDG_RUNTIME_DIR, so
# this is what makes "the nested sway" structurally unambiguous: the socket we
# drive cannot be a real sway session's, because a real one is not in here.
# Globbing the shared runtime dir for `sway-ipc.*` would find one just as
# happily, which is how a harness ends up dispatching at somebody's desktop.
NESTED_XDG="$RUNDIR/xdg"
CONFIG="$RUNDIR/sway.conf"
PIDFILE="$RUNDIR/pid"
SOCKFILE="$RUNDIR/swaysock"
SHELL_LOG="$RUNDIR/shell.log"
SWAY_LOG="$RUNDIR/sway.log"

HOST_XDG=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

# Ours is identified by the config path in its argv, never by a pid alone: a
# stale pid file, or a pid recycled onto a real sway, must never be signalled.
is_nested() {
    local pid=${1:-}
    [ -n "$pid" ] || return 1
    [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = "sway" ] || return 1
    # the name check is not redundant — any shell running a command that merely
    # mentions the config path has it in its own argv too
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "$CONFIG"
}

nested_pid() {
    local pid
    pid=$(cat "$PIDFILE" 2>/dev/null) || return 1
    [ -n "$pid" ] || return 1
    is_nested "$pid" || return 1
    printf '%s\n' "$pid"
}

# The socket to drive, verified rather than trusted: it must be the one our own
# instance wrote, it must still exist, and it must live in the private runtime
# dir (i.e. it cannot be a real session's).
nested_sock() {
    local sock
    sock=$(cat "$SOCKFILE" 2>/dev/null) || return 1
    [ -n "$sock" ] || return 1
    case "$sock" in
    "$NESTED_XDG"/*) ;;
    *)
        echo "recorded socket is outside the private runtime dir — refusing: $sock" >&2
        return 1
        ;;
    esac
    [ -S "$sock" ] || return 1
    printf '%s\n' "$sock"
}

ctl() {
    local sock
    sock=$(nested_sock) || {
        echo "no verified nested instance — refusing to run swaymsg" >&2
        return 1
    }
    SWAYSOCK="$sock" swaymsg "$@"
}

start() {
    command -v sway >/dev/null || {
        echo "sway is not installed" >&2
        return 1
    }
    [ -n "${WAYLAND_DISPLAY:-}" ] || {
        echo "no WAYLAND_DISPLAY — the nested backend needs a wayland session" >&2
        return 1
    }

    stop >/dev/null 2>&1
    rm -rf "$RUNDIR"
    mkdir -p "$RUNDIR" "$NESTED_XDG" "$NESTED_XDG/config/wam-shell" "$RUNDIR/cache"
    chmod 700 "$NESTED_XDG"

    # The wayland backend connects to the HOST compositor through
    # $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY, so moving the runtime dir would leave
    # it with nowhere to connect. Link the socket in; the .lock beside it
    # belongs to the server and is deliberately not copied.
    local host_wl=${WAYLAND_DISPLAY:-}
    case "$host_wl" in
    /*) ln -sfn "$host_wl" "$NESTED_XDG/$(basename "$host_wl")" ;;
    *) ln -sfn "$HOST_XDG/$host_wl" "$NESTED_XDG/$host_wl" ;;
    esac

    # The session bus is deliberately KEPT, where hy3's harness cuts it. Its
    # nested compositor needs no bus; our nested SHELL does — tray, upower,
    # logind and the notification daemon probe all live there, and cutting it
    # would turn a clean startup into a page of warnings that the smoke test
    # then has to tell apart from real ones. Safe here because sway exports
    # nothing to the systemd user manager on its own: the leak hy3 documents
    # (a stale WAYLAND_DISPLAY breaking the next restart of every user service)
    # comes from `systemctl --user import-environment`, and the config below
    # deliberately has no such line.
    if [ -S "$HOST_XDG/bus" ]; then
        ln -sfn "$HOST_XDG/bus" "$NESTED_XDG/bus"
    fi

    cat >"$NESTED_XDG/config/wam-shell/config.toml" <<EOF
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
    # inherited. Without it the nested shell detects the HOST compositor and
    # builds its widgets, so everything passes while exercising nothing.
    cat >"$CONFIG" <<EOF
output * resolution 1280x720 position 0,0
exec sh -c 'printf "%s" "\$SWAYSOCK" > "$SOCKFILE"'
exec env XDG_CONFIG_HOME="$NESTED_XDG/config" XDG_CACHE_HOME="$RUNDIR/cache" \\
    WAM_SHELL_DIR="$ROOT" DESKTOP_SESSION=sway XDG_CURRENT_DESKTOP=sway \\
    ags run "$ROOT/app.tsx" > "$SHELL_LOG" 2>&1
EOF

    # LIBSEAT_BACKEND=noop is not tidiness, and it is kept even though the
    # wayland backend should never need a seat. hy3 hit the failure it
    # prevents four times before tracking it down: libseat with no seatd falls
    # back to logind, opens whatever XDG_SESSION_ID names — which under a
    # terminal multiplexer that outlived its login is an OLD session on seat0,
    # the same seat the live desktop is on — and logind re-evaluating seat0
    # around it tears the real session down. A logout with no crash and nothing
    # in any log. The point is not which backend is picked but that no seat is
    # taken at all.
    #
    # WLR_BACKENDS pins the wayland backend so nothing enumerates DRM, and
    # WLR_RENDERER=pixman keeps it off the GPU.
    #
    # setsid puts it in its own session and process group: otherwise it is a
    # background job of whatever ran this script, and a closed terminal or an
    # agent reaping its children takes the compositor with it.
    setsid env XDG_RUNTIME_DIR="$NESTED_XDG" \
        LIBSEAT_BACKEND=noop \
        WLR_BACKENDS=wayland \
        WLR_RENDERER=pixman \
        sway -c "$CONFIG" >"$SWAY_LOG" 2>&1 &

    # not $!: setsid forks when it is already a process group leader. Find the
    # compositor by its config path instead.
    local pid="" i=0
    while [ "$i" -lt 40 ]; do
        pid=$(pgrep -x sway 2>/dev/null | while read -r p; do is_nested "$p" && echo "$p"; done | head -1)
        [ -n "$pid" ] && break
        i=$((i + 1))
        sleep 0.25
    done
    [ -n "$pid" ] || {
        echo "nested sway did not start; tail of $SWAY_LOG:" >&2
        tail -15 "$SWAY_LOG" >&2
        return 1
    }
    printf '%s\n' "$pid" >"$PIDFILE"

    # wait for its IPC socket
    i=0
    while [ "$i" -lt 60 ]; do
        [ -s "$SOCKFILE" ] && nested_sock >/dev/null 2>&1 && break
        i=$((i + 1))
        sleep 0.25
    done
    nested_sock >/dev/null 2>&1 || {
        echo "nested sway never wrote a usable ipc socket" >&2
        tail -15 "$SWAY_LOG" >&2
        stop
        return 1
    }

    # Every output must be a nested wayland surface. A physical one means the
    # DRM backend came up despite the env above and this harness is now driving
    # the real screens — stop before anything is dispatched at it. The failure
    # is otherwise silent: it starts, the tests pass, and the only symptom is
    # the session misbehaving later for no visible reason.
    local physical
    physical=$(ctl -t get_outputs -r 2>/dev/null |
        python3 -c 'import json,sys
try: outs=json.load(sys.stdin)
except Exception: outs=[]
print(" ".join(o["name"] for o in outs if not o["name"].startswith(("WL-","HEADLESS-"))))' 2>/dev/null)
    if [ -n "${physical// /}" ]; then
        echo "refusing to continue: nested sway opened physical output(s): $physical" >&2
        echo "the DRM backend came up — WLR_BACKENDS/LIBSEAT_BACKEND are not taking effect" >&2
        stop
        return 1
    fi

    # and the shell inside it
    i=0
    while [ "$i" -lt 60 ]; do
        ags list 2>/dev/null | grep -qw "$INSTANCE" && break
        i=$((i + 1))
        sleep 0.25
    done
    ags list 2>/dev/null | grep -qw "$INSTANCE" || {
        echo "the shell never started inside the nested sway" >&2
        tail -20 "$SHELL_LOG" >&2
        stop
        return 1
    }
    return 0
}

stop() {
    ags quit -i "$INSTANCE" 2>/dev/null
    local pid
    if pid=$(nested_pid); then
        kill "$pid" 2>/dev/null
        local i=0
        while [ "$i" -lt 25 ] && is_nested "$pid"; do
            i=$((i + 1))
            sleep 0.2
        done
        is_nested "$pid" && kill -9 "$pid" 2>/dev/null
    fi

    # Wait for the INSTANCE to go too, not just the compositor. The shell
    # outlives its wayland connection by a moment, and `stop` returning early
    # is not a cosmetic race: the next run's preflight sees an instance by that
    # name and skips, so a back-to-back start reports success while testing
    # nothing. (hy3's harness has the same wait, for the same reason.)
    local j=0
    while [ "$j" -lt 40 ] && ags list 2>/dev/null | grep -qw "$INSTANCE"; do
        j=$((j + 1))
        sleep 0.25
    done

    rm -f "$PIDFILE" "$SOCKFILE"
}

case "${1:-}" in
start)
    start
    ;;
stop)
    stop
    ;;
sock)
    nested_sock
    ;;
log)
    printf '%s\n' "$SHELL_LOG"
    ;;
ctl)
    shift
    ctl "$@"
    ;;
*)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
