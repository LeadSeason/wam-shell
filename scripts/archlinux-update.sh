#!/usr/bin/env bash

set -eu

trap 'printf "\033[1;31m[update]\033[0m Failed to run update system\n"' ERR

# Clear the list the shell's bar widget reads, so the count drops as
# soon as the update finishes instead of on the daemon's next hourly
# pass. Resolve the SAME path Config.pendingUpdatesPath does
# (<cache>/<instance_name>/system_updates) — truncating a file the
# shell never reads leaves the stale count on the bar, and /tmp is a
# predictable world-writable path (symlink hazard, see config.ts).
# The instance name is a flat top-level key; parse it with sed, the way
# scripts/wam's resolve_instance_paths does — last assignment wins,
# comment lines cannot match.
INSTANCE="wam-shell"
for f in "${XDG_CONFIG_HOME:-$HOME/.config}/wam-shell/config.toml" \
    "$HOME/.config/wam-shell/config.toml"; do
    if [ -r "$f" ]; then
        name="$(sed -n \
            -e 's/^[[:space:]]*instance_name[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
            -e "s/^[[:space:]]*instance_name[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p" \
            "$f" 2>/dev/null | tail -1)"
        if [ -n "$name" ]; then
            INSTANCE="$name"
        fi
        break
    fi
done

CACHE="${XDG_CACHE_HOME:-}"
case "$CACHE" in
    /*) ;;
    *) CACHE="$HOME/.cache" ;;
esac
UPDATE_FILE="$CACHE/$INSTANCE/system_updates"

log() {
    printf "\033[1;34m[update]\033[0m %s\n" "$1"
}

log "Starting full system update..."

sudo pacman -Syu --noconfirm

if command -v yay >/dev/null 2>&1; then
    log "Updating AUR packages..."
    yay -Syu --noconfirm --sudoloop
else
    log "yay not found, skipping AUR"
fi

orphans="$(pacman -Qdtq || true)"
if [ -n "$orphans" ]; then
    log "Removing orphaned packages..."
    sudo pacman -Rns $orphans --noconfirm
else
    log "No orphan packages to remove"
fi

# only truncate — creating the file when no daemon runs would make the
# shell advertise an updates pill backed by nothing (config.ts falls
# back to trusting the file's existence when systemd cannot be asked)
if [ -f "$UPDATE_FILE" ]; then
    : > "$UPDATE_FILE"
fi

log "System fully updated"
