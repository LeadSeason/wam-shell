#!/usr/bin/env bash
# Check the stylesheet — every theme, through GTK's own CSS parser.
#
# NOT one of the five gates, and not because it is optional: it is the
# check for the half of the shell the gates cannot see. Prettier globs
# `src/**`, typecheck reads TypeScript, and smoke and perf only care that
# the shell starts and how much it costs. Nothing any of them do would
# notice a stylesheet that compiles to CSS GTK then silently drops, or a
# theme that stopped compiling at all. `scss/` is ~1500 lines and six
# palettes; this is what stands between it and a rule that quietly does
# nothing.
#
# Three things it catches that reading the diff does not:
#
#   - a rule GTK refuses (its parser reports, then drops, the
#     declaration — the shell just renders without it)
#   - a theme that breaks while the one you happen to be running is fine,
#     which is most of them, most of the time
#   - a dart-sass DEPRECATION, which exits zero. A compile can "succeed"
#     and still print two warnings into the user's log on every single
#     start; the `if()` function did exactly that until it was rewritten.
#     Warnings are failures here for that reason.
#
# Usage:
#   scripts/verify-scss.sh [OUTDIR]
#
# With an OUTDIR the compiled css and a sorted selector set per theme are
# kept there, which is what makes a before/after comparison possible:
#
#   git stash && scripts/verify-scss.sh /tmp/before && git stash pop
#   scripts/verify-scss.sh /tmp/after
#   diff /tmp/before/catppuccin-mocha.selectors /tmp/after/catppuccin-mocha.selectors
#
# A refactor that is meant to change values and not structure should show
# an empty selector diff. One that does not is telling you something.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
[ -n "$OUT" ] && mkdir -p "$OUT"

command -v sass >/dev/null || {
    echo "error: dart-sass is not installed — nothing to check with" >&2
    exit 1
}
command -v gjs >/dev/null || {
    echo "error: gjs is not installed — the GTK parser check needs it" >&2
    exit 1
}

# The shell generates this from config.toml before every compile (see
# syncTuning in lib/styleCompile.ts). The DEFAULTS are what gets checked:
# density is a multiplier over whole-pixel values, so the interesting
# question is whether the sheet compiles at all, not which of three
# spacings it came out at. DENSITY=0.8 to check a compact build too.
# SURFACE_OPACITY < 1 (e.g. 0.85) compiles the [appearance] blur code
# paths — the default run never touches them, so run it once when
# touching blur-related styling.
: "${DENSITY:=1}"
: "${BAR_FLOAT_MARGIN:=6px}"
: "${WS_PLAYING_PULSE:=650ms}"
: "${SURFACE_OPACITY:=1}"
printf '$density: %s;\n$bar-float-margin: %s;\n$ws-playing-pulse: %s;\n$surface-opacity: %s;\n' \
    "$DENSITY" "$BAR_FLOAT_MARGIN" "$WS_PLAYING_PULSE" "$SURFACE_OPACITY" \
    >"$WORK/active-tuning.scss"

fail=0
checked=0

for theme in "$ROOT"/scss/theme/*.scss; do
    name="$(basename "$theme" .scss)"
    # the generated copy of whichever theme is active, not a theme itself
    [ "$name" = "active-theme" ] && continue

    cp "$theme" "$WORK/active-theme.scss"
    css="$WORK/$name.css"

    if ! sass --no-source-map \
        --load-path "$WORK" \
        --load-path "$ROOT/scss/theme" \
        --load-path "$ROOT/scss" \
        "$ROOT/scss/style.scss" "$css" 2>"$WORK/sass.err"; then
        echo "SASS FAIL  $name"
        sed 's/^/    /' "$WORK/sass.err"
        fail=1
        continue
    fi

    # a successful compile that printed anything is still a finding —
    # see the note on deprecations above
    if [ -s "$WORK/sass.err" ]; then
        echo "SASS WARN  $name"
        sed 's/^/    /' "$WORK/sass.err"
        fail=1
    fi

    # GTK is the only authority on what it accepts. Loading through
    # Gtk.CssProvider and listening for parsing-error is the same path
    # the shell's own stylesheet takes at startup.
    cat >"$WORK/check.js" <<EOF
import Gtk from 'gi://Gtk?version=4.0';
Gtk.init();
const provider = new Gtk.CssProvider();
let errors = 0;
provider.connect('parsing-error', (_p, section, error) => {
    errors++;
    printerr(\`    \${section.to_string()}: \${error.message}\`);
});
provider.load_from_path('$css');
if (errors) printerr(\`    \${errors} parse error(s)\`);
EOF

    parse="$(gjs -m "$WORK/check.js" 2>&1)"
    rules="$(grep -c '{' "$css")"

    if [ -n "$parse" ]; then
        echo "GTK  FAIL  $name  ($rules rules)"
        printf '%s\n' "$parse"
        fail=1
    else
        echo "ok         $name  ($rules rules)"
    fi

    checked=$((checked + 1))
    if [ -n "$OUT" ]; then
        cp "$css" "$OUT/$name.css"
        # One line per SELECTOR, not per rule, and independent of how the
        # source happened to wrap.
        #
        # This used to be `grep -oE '^[^{}]+\{'`, which only ever matched
        # a selector group written on ONE line. The moment a group is
        # split across lines — which is what prettier does to `a, b, c {`
        # — every line but the last ends in a comma, matches nothing, and
        # its selectors vanish from the set. The rule COUNT stays right
        # (one `{` either way), so the file looks fine while quietly
        # under-reporting, and a before/after diff across a reformat
        # showed twenty selectors "removed" that were never touched.
        #
        # So: join the file, drop comments (they carry no braces and
        # would otherwise glue themselves to the next selector), take
        # everything before each `{`, then split the groups on commas.
        tr '\n' ' ' <"$css" |
            sed -e 's|/\*[^*]*\*\+\([^/*][^*]*\*\+\)*/||g' |
            grep -oE '[^{}]+\{' |
            sed -e 's/ *{$//' -e 's/^ *//' -e 's/  */ /g' |
            tr ',' '\n' |
            sed -e 's/^ *//' -e 's/ *$//' |
            grep -v '^$' |
            sort -u >"$OUT/$name.selectors"
    fi
done

if [ "$checked" -eq 0 ]; then
    echo "error: no themes found in $ROOT/scss/theme" >&2
    exit 1
fi

if [ "$fail" -ne 0 ]; then
    echo "FAIL verify-scss: see above"
    exit 1
fi

echo "ok   verify-scss: $checked themes compile and parse clean"
