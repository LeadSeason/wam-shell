#!/usr/bin/env bash
# Dev environment setup for wam-shell.
#
#   --source   build the astal libraries from source instead of using an
#              AUR helper (use this on non-Arch distros or if you already
#              run a source install of ags/astal, e.g. under /usr/local)
#
# Idempotent: already-installed pieces are skipped. Pass --force together
# with --source to rebuild libraries that are already present.
set -euo pipefail

SOURCE=0
FORCE=0
for arg in "$@"; do
    case "$arg" in
        --source) SOURCE=1 ;;
        --force) FORCE=1 ;;
    esac
done

ASTAL_DIR="${ASTAL_DIR:-$HOME/Dev/astal}"
ASTAL_REPO="https://github.com/Aylur/astal.git"
I3IPC_DIR="${I3IPC_DIR:-$HOME/Dev/i3ipc-glib}"
I3IPC_REPO="https://github.com/acrisci/i3ipc-glib.git"
PREFIX=/usr/local
GIR_DIR="$PREFIX/lib/girepository-1.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# AUR package / repo subdir -> typelib it provides
AUR_LIBS=(
    "libastal-io-git:AstalIO-0.1"
    "libastal-4-git:Astal-4.0"
    "libastal-battery-git:AstalBattery-0.1"
    "libastal-wireplumber-git:AstalWp-0.1"
    "libastal-powerprofiles-git:AstalPowerProfiles-0.1"
    "libastal-tray-git:AstalTray-0.1"
    "libastal-hyprland-git:AstalHyprland-0.1"
    "libastal-network-git:AstalNetwork-0.1"
    "libastal-bluetooth-git:AstalBluetooth-0.1"
    "i3ipc-glib-git:i3ipc-1.0"
)
# order matters for source builds: io first, the rest depend on it
SRC_LIBS=(
    "lib/astal/io:AstalIO-0.1"
    "lib/astal/gtk4:Astal-4.0"
    "lib/battery:AstalBattery-0.1"
    "lib/wireplumber:AstalWp-0.1"
    "lib/powerprofiles:AstalPowerProfiles-0.1"
    "lib/tray:AstalTray-0.1"
    "lib/hyprland:AstalHyprland-0.1"
    "lib/network:AstalNetwork-0.1"
    "lib/bluetooth:AstalBluetooth-0.1"
)

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

aur_helper() {
    for h in paru yay; do
        command -v "$h" >/dev/null && { echo "$h"; return; }
    done
    return 1
}

install_with_aur() {
    local helper pkgs=()
    helper="$(aur_helper)"

    command -v ags >/dev/null || pkgs+=("aylurs-gtk-shell")
    command -v sass >/dev/null || pkgs+=("dart-sass")
    command -v brightnessctl >/dev/null || pkgs+=("brightnessctl")
    for entry in "${AUR_LIBS[@]}"; do
        pkgs+=("${entry%%:*}")
    done

    log "Installing ags + astal libraries with $helper"
    "$helper" -S --needed --refresh "${pkgs[@]}"
}

install_build_deps() {
    if command -v pacman >/dev/null; then
        sudo pacman -S --needed --noconfirm \
            vala meson ninja gobject-introspection \
            gtk3 gtk4 gtk-layer-shell gtk4-layer-shell \
            json-glib wireplumber dart-sass libnm brightnessctl
    elif command -v dnf >/dev/null; then
        sudo dnf install -y \
            vala meson ninja-build gobject-introspection-devel \
            gtk3-devel gtk4-devel gtk-layer-shell-devel gtk4-layer-shell-devel \
            json-glib-devel wireplumber-devel NetworkManager-libnm-devel \
            brightnessctl
        command -v sass >/dev/null || \
            log "WARNING: sass not found. Install dart-sass (e.g. from https://github.com/sass/dart-sass/releases)"
    else
        log "WARNING: unknown package manager. Make sure these are installed:"
        log "  vala meson ninja gobject-introspection gtk3 gtk4"
        log "  gtk-layer-shell gtk4-layer-shell json-glib wireplumber"
    fi
}

build_meson() {
    local srcdir="$1" typelib="$2"

    if [[ $FORCE -eq 0 && -f "$GIR_DIR/$typelib.typelib" ]]; then
        log "Skipping $typelib (already installed)"
        return
    fi

    log "Building $typelib ($srcdir)"
    local builddir="$srcdir/build"
    if [[ -d "$builddir" ]]; then
        meson setup "$builddir" --reconfigure
    else
        meson setup "$builddir" "$srcdir" --prefix "$PREFIX"
    fi
    meson compile -C "$builddir"
    sudo meson install -C "$builddir"
}

clone_or_update() {
    local repo="$1" dir="$2"
    if [[ ! -d "$dir/.git" ]]; then
        log "Cloning $repo into $dir"
        git clone --depth 1 "$repo" "$dir"
    else
        log "Updating $dir"
        git -C "$dir" pull --ff-only || log "Pull failed, using existing checkout"
    fi
}

install_from_source() {
    install_build_deps

    clone_or_update "$ASTAL_REPO" "$ASTAL_DIR"
    for entry in "${SRC_LIBS[@]}"; do
        build_meson "$ASTAL_DIR/${entry%%:*}" "${entry##*:}"
    done

    # i3ipc-glib provides the i3ipc-1.0 typelib used for sway IPC
    clone_or_update "$I3IPC_REPO" "$I3IPC_DIR"
    build_meson "$I3IPC_DIR" "i3ipc-1.0"
}

link_ags_js() {
    local js=""
    for d in "${AGS_JS_DIR:-}" /usr/local/share/ags/js /usr/share/ags/js; do
        [[ -n "$d" && -d "$d" ]] && { js="$d"; break; }
    done
    [[ -z "$js" ]] && { log "ERROR: ags js dir not found. Set AGS_JS_DIR."; exit 1; }

    log "Linking ags js from $js"
    mkdir -p "$ROOT/.sys"
    ln -sfn "$js" "$ROOT/.sys/ags"
    ln -sfn "$js/node_modules/gnim" "$ROOT/.sys/gnim"
}

# --- main -------------------------------------------------------------------

if [[ $SOURCE -eq 0 ]] && command -v pacman >/dev/null && aur_helper >/dev/null; then
    install_with_aur
else
    [[ $SOURCE -eq 0 ]] && log "No AUR helper found, falling back to source build"
    install_from_source
fi

command -v ags >/dev/null || { log "ERROR: ags not found after install."; exit 1; }

link_ags_js

log "Installing node modules"
(cd "$ROOT" && pnpm i)

log "Generating TypeScript types (@girs)"
(cd "$ROOT" && ags types -d .)

log "Done. Start the shell with: pnpm start"
