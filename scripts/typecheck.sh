#!/usr/bin/env bash
# The fifth gate: type-check the logic layer.
#
# Scoped, and the scope is the whole point. Three things make a plain
# `tsc --noEmit` useless here:
#
#   - the generated @girs typings declare the same symbols across every
#     gtk/gdk/soup version they ship (~30 duplicate-identifier errors)
#   - gnim ships .ts SOURCES rather than .d.ts, so scoping by tsconfig
#     drags its entire codebase in (600+ errors, none of them ours)
#   - the ags/gnim JSX prop typings are incomplete: `onChanged` on an
#     <entry> is missing from the generated props even though it is the
#     documented way to use it and works at runtime. src/widgets carries
#     ~97 of these, and silencing them with casts would make the code
#     worse to make a gate green
#
# So this filters tsc's output to the paths where a type error means
# something. That is not everything, and it is not meant to be — it is
# the difference between checking the logic and checking nothing.
#
# It earned its place on the first run: it found Gio.Bus.unwatch_name
# (Gio.Bus does not exist — dispose() would have thrown) and three
# no-argument calls to a gnim state setter, which set the state to
# undefined and, because gnim skips notification when the value has not
# changed, silently dropped every bump after the first.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# paths where a type error is a real finding. src/widgets is absent on
# purpose (see above); the two notification modules listed are pulled in
# by tests and are GTK-free enough to check
COVERED='^(src/lib/|src/config\.ts|tests/|src/widgets/notifications/(feed|rowData)\.ts)'

# ONE error code is reported everywhere, src/widgets included: TS2304,
# "Cannot find name". The scope above exists because the JSX prop
# typings are incomplete, and every error that produces is a false
# positive about something that works at runtime. TS2304 is the
# opposite — an identifier that does not exist is a ReferenceError the
# moment the line runs, and no cast or typing gap can make it anything
# else.
#
# It earned its own line: #229 was four of these in the sway workspaces
# widget, left behind when a refactor deleted the declaration and kept
# the uses. The widget threw on construction for every sway and i3 user,
# and the gate could not see it — the smoke test only ever boots on the
# developer's own compositor, which was hyprland.
ALWAYS='error TS2304'

TSC=(npx -y -p typescript@5.9 tsc)
[ -x node_modules/.bin/tsc ] && TSC=(node_modules/.bin/tsc)

raw="$("${TSC[@]}" --noEmit 2>&1)"
out="$(printf '%s\n' "$raw" | grep -E "$COVERED" || true)"
# anything TS2304 outside the covered paths, appended rather than merged
# so a covered-path error is never reported twice
extra="$(printf '%s\n' "$raw" | grep -F "$ALWAYS" | grep -vE "$COVERED" || true)"
[ -n "$extra" ] && out="$(printf '%s\n%s' "$out" "$extra")"

if [ -n "$out" ]; then
    printf '%s\n' "$out"
    printf 'FAIL typecheck: %s error(s) in the covered paths, or an undefined name anywhere\n' "$(printf '%s\n' "$out" | grep -c 'error TS')"
    exit 1
fi

echo "ok   typecheck: no errors in src/lib, src/config.ts or tests, and no undefined names anywhere"
