#!/usr/bin/env bash

set -eu

trap 'printf "\033[1;31m[update]\033[0m Failed to run update system\n"' ERR

UPDATE_FILE="/tmp/system_updates"
[ -n "${XDG_RUNTIME_DIR:-}" ] && UPDATE_FILE="$XDG_RUNTIME_DIR/system_updates"

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

: > "$UPDATE_FILE"

log "System fully updated"
