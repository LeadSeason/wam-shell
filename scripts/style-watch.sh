#!/bin/bash
WATCH_DIR="./scss"

inotifywait -m -r -e modify,create,delete "$WATCH_DIR" |
while read path action file; do
    echo "Change detected: $file ($action)"
    ags request -i wam-shell "style"
done