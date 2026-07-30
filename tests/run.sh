#!/usr/bin/env bash
# Unit/integration test harness. Bundles tests with the project's own
# toolchain (ags bundle) and runs them under gjs. Safe on a live session:
# XDG_CONFIG_HOME / XDG_CACHE_HOME / HOME are redirected to a tmp dir, no
# app instance is started, no D-Bus name is owned, nothing is killed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -e node_modules/ags || ! -e node_modules/gnim ]]; then
    echo "error: node_modules/ags or node_modules/gnim missing." >&2
    echo "a bare checkout is not runnable — run scripts/setup.sh (or pnpm i) first." >&2
    exit 1
fi
command -v ags >/dev/null || { echo "error: ags not found in PATH" >&2; exit 1; }
command -v gjs >/dev/null || { echo "error: gjs not found in PATH" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/config" "$TMP/cache" "$TMP/home" "$TMP/rt" "$TMP/srcdir"
chmod 700 "$TMP/rt"

# sanitized instanceSrcDir: config.ts also probes <srcdir>/config.toml
# and <srcdir>/config-override.toml, so the developer's real
# config-override.toml in the repo root would leak into tests. The scss
# symlink keeps theme probing (isFile checks on scss/theme/*.scss).
ln -s "$ROOT/scss" "$TMP/srcdir/scss"
touch "$TMP/srcdir/config.toml"

# ags bundle emits a self-contained executable (bash wrapper + base64
# payload + gjs launcher), not a plain .js — run it directly.
ags bundle --gtk 4 tests/main.ts "$TMP/main"
ags bundle --gtk 4 tests/config-dump.ts "$TMP/config-dump"
ags bundle --gtk 4 tests/metrics-probe.ts "$TMP/metrics-probe"
chmod +x "$TMP/main" "$TMP/config-dump" "$TMP/metrics-probe"

# XDG_RUNTIME_DIR is redirected too (DBUS_SESSION_BUS_ADDRESS is explicit,
# so the session bus stays reachable): the bundle wrapper would otherwise
# write its decoded payload into the real /run/user/<uid>.
XDG_CONFIG_HOME="$TMP/config" \
XDG_CACHE_HOME="$TMP/cache" \
XDG_RUNTIME_DIR="$TMP/rt" \
HOME="$TMP/home" \
WAM_SHELL_DIR="$TMP/srcdir" \
DESKTOP_SESSION=hyprland \
WAM_TEST_TMP="$TMP" \
WAM_TEST_CONFIG_DUMP="$TMP/config-dump" \
WAM_TEST_METRICS_PROBE="$TMP/metrics-probe" \
"$TMP/main"
