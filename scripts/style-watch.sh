#!/bin/bash
WATCH_DIR="./scss"

inotifywait -m -r -e modify,create,delete "$WATCH_DIR" |
while read -r path action file; do
    # editors emit a burst of events per save; drain it, compile once
    while read -r -t 1 _ _ _; do :; done
    echo "Change detected: $file ($action)"
    ags request -i wam-shell "style"
done
