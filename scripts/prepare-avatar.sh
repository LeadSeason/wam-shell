#!/usr/bin/env bash
# prepare-avatar.sh - square center-crop and resize an image for use as
# the quick settings avatar ([quicksettings] avatar).
#
# usage: scripts/prepare-avatar.sh <input> [output]
#   input   any image file (jpg/png/webp/...)
#   output  where to write the result (default: assets/avatar.jpg)
#
# The result is a 96x96 square image (the header renders it at 36px,
# so 96 covers hidpi). Requires python3 + Pillow.
set -euo pipefail

if [ $# -lt 1 ]; then
    sed -n '2,10p' "$0"
    exit 1
fi

INPUT="$1"
OUTPUT="${2:-$(dirname "$0")/../assets/avatar.jpg}"

python3 - "$INPUT" "$OUTPUT" <<'PY'
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
img = Image.open(src).convert("RGB")
w, h = img.size
side = min(w, h)
left, top = (w - side) // 2, (h - side) // 2
img = img.crop((left, top, left + side, top + side)).resize((96, 96), Image.LANCZOS)
img.save(dst, quality=90)
print(f"avatar written to {dst} (96x96)")
PY
