#!/usr/bin/env bash
# Recompile the shell's stylesheet whenever an scss file changes.
#
# A development convenience: it drives `ags request -i <instance> style`,
# which is the same forced recompile the request command does by hand.
# Nothing else in the project calls it.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCH_DIR="${1:-$ROOT/scss}"
INSTANCE="${WAM_SHELL_INSTANCE:-wam-shell}"

if ! command -v inotifywait >/dev/null; then
    echo "error: inotifywait not found (install inotify-tools)" >&2
    exit 1
fi
if [[ ! -d "$WATCH_DIR" ]]; then
    echo "error: no such directory: $WATCH_DIR" >&2
    exit 1
fi

echo "watching $WATCH_DIR -> ags request -i $INSTANCE style"

inotifywait -m -r -e modify,create,delete "$WATCH_DIR" |
    while read -r _path action file; do
        # editors emit a burst of events per save; drain it, compile once
        while read -r -t 1 _ _ _; do :; done
        echo "Change detected: $file ($action)"
        ags request -i "$INSTANCE" "style" || true
    done
