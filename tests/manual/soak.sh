#!/usr/bin/env bash
# Segfault soak: hammer the paths that were live around the one
# unexplained crash — notification churn (arrival, grouping, drawer
# hover, expiry, the revealer collapse) plus panel toggling.
#
# Reports the instant the shell dies, with the last notifications sent,
# so a crash is attributable rather than just observed.
set -uo pipefail
cd "$(dirname "$0")"

# Hyprland 0.56 parses dispatch arguments as LUA: the old
# `hyprctl dispatch movecursor X Y` is a syntax error that reports only
# on stderr and silently does nothing.
hover() { hyprctl dispatch "hl.dsp.cursor.move({x=$1,y=$2})" >/dev/null 2>&1; }

LOG="${SOAK_LOG:-/tmp/wam-shell-soak.txt}"
: > "$LOG"
say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }

GEO() {
    hyprctl layers -j | python3 -c "
import json,sys
d=json.load(sys.stdin)
for mon,v in d.items():
    for lvl,ls in v['levels'].items():
        for l in ls:
            if 'notification-popups' in l.get('namespace',''): print(l['x'],l['y'],l['w'],l['h'])"
}

alive() { ags list 2>/dev/null | grep -qw wam-shell; }

END=$(( $(date +%s) + ${1:-1800} ))
round=0
say "soak start (until $(date -d @$END +%H:%M:%S))"

while [ "$(date +%s)" -lt "$END" ]; do
    round=$((round + 1))

    # a burst from one app (grouping + drawer) and singles from others
    for i in 1 2 3; do
        notify-send -a "SoakGroup" "burst $round.$i" "grouped body $i"
        sleep 0.12
    done
    notify-send -a "SoakOther$((round % 4))" "single $round" "body"
    notify-send -u critical -a "SoakCrit" "critical $round" "never expires"
    notify-send -a "SoakRtl" "مايا أورتيز" "رسالة عربية $round"

    # hover the stack: opens the drawer, freezes countdowns
    if read -r LX LY LW LH < <(GEO) && [ -n "${LH:-}" ]; then
        hover $((LX + LW / 2)) $((LY + 20))
        sleep 0.6
        hover $((LX + LW / 2)) $((LY + LH - 10))
        sleep 0.5
    fi
    hover 4200 900

    # panels, which is where the exclusive closers now fire
    for cmd in notifications quickSettings notifications quickSettings; do
        ags request -i wam-shell "$cmd" >/dev/null 2>&1
        sleep 0.35
    done

    # let banners expire naturally: the revealer collapse is where the
    # one crash I DID root-cause lived
    sleep 4

    if ! alive; then
        say "DIED in round $round"
        coredumpctl list --no-pager 2>/dev/null | tail -3 | tee -a "$LOG"
        exit 1
    fi

    # clear so the center does not grow unbounded
    probe=$(notify-send -p -a probe probe probe)
    for i in $(seq 0 8); do
        gdbus call --session -d org.freedesktop.Notifications \
            -o /org/freedesktop/Notifications \
            -m org.freedesktop.Notifications.CloseNotification $((probe - i)) >/dev/null 2>&1
    done

    [ $((round % 5)) -eq 0 ] && say "round $round ok"
done

say "soak finished clean after $round rounds"
