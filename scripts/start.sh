#!/usr/bin/env bash
# pnpm start — restart the shell: quit every running instance first
# (ags run would otherwise just error against the existing one), then
# launch from this checkout.
set -uo pipefail

for inst in $(ags list 2>/dev/null); do
    ags quit -i "$inst" || true
done

exec ags run app.tsx
