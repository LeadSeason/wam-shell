#!/usr/bin/env bash
# Nerd Fonts used by the shell (scss/style.scss): "Symbols Nerd Font Mono"
# and "FiraCode Nerd Font Propo". Without any Nerd Font the text falls
# back to a wide system font and layouts inflate; without the symbols
# variant icons turn into tofu.
#
# Idempotent: families already known to fontconfig are skipped.
set -euo pipefail

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
    printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
    exit 1
}

have() { fc-list 2>/dev/null | grep -qi "$1"; }

need_fira=0
need_symbols=0
have "FiraCode Nerd Font" || need_fira=1
have "Symbols Nerd Font" || need_symbols=1

if [[ $need_fira -eq 0 && $need_symbols -eq 0 ]]; then
    log "Nerd Fonts already installed, skipping"
    exit 0
fi

# Arch: both packages are in the official repos
if command -v pacman >/dev/null; then
    pkgs=()
    [[ $need_fira -eq 1 ]] && pkgs+=("ttf-firacode-nerd")
    [[ $need_symbols -eq 1 ]] && pkgs+=("ttf-nerd-fonts-symbols-mono")
    log "Installing Nerd Fonts with pacman: ${pkgs[*]}"
    sudo pacman -S --needed --noconfirm "${pkgs[@]}"
    exit 0
fi

# distro-agnostic fallback: upstream release zips into ~/.local/share/fonts
command -v unzip >/dev/null || die "unzip not found; install it or install Nerd Fonts manually"
command -v curl >/dev/null || die "curl not found; install it or install Nerd Fonts manually"

FONT_DIR="$HOME/.local/share/fonts"
mkdir -p "$FONT_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() { # <label> <zip>
    log "Downloading $1 from github.com/ryanoasis/nerd-fonts"
    curl -fsSL "https://github.com/ryanoasis/nerd-fonts/releases/latest/download/$2" -o "$tmp/$2"
    unzip -qo "$tmp/$2" -d "$FONT_DIR"
}

[[ $need_fira -eq 1 ]] && fetch "FiraCode Nerd Font" "FiraCode.zip"
[[ $need_symbols -eq 1 ]] && fetch "Symbols Nerd Font Mono" "NerdFontsSymbolsOnly.zip"

fc-cache -f "$FONT_DIR" >/dev/null
log "Fonts installed to $FONT_DIR"
