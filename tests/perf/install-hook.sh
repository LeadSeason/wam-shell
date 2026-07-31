#!/usr/bin/env bash
# Installs the opt-in pre-push perf gate: `pnpm perf` runs before every
# git push. Deliberately NOT installed by default — an unrequested hook
# that adds minutes to git push gets deleted, along with trust in the
# tool. Deliberately pre-push, not pre-commit: the runtime guarantees
# --no-verify becomes muscle memory there.
#
#   pnpm perf:install-hook     install (idempotent)
#
# Bypass once with `git push --no-verify`; uninstall by removing the
# marked block (or the whole hook if it only contains the gate).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS_DIR="$(git -C "$ROOT" rev-parse --git-path hooks)"
HOOK="$HOOKS_DIR/pre-push"
MARKER="# wam-shell perf gate (pnpm perf)"

mkdir -p "$HOOKS_DIR"

if [[ -f "$HOOK" ]] && grep -qF "$MARKER" "$HOOK"; then
    echo "perf gate already installed in $HOOK"
    exit 0
fi

if [[ -f "$HOOK" ]]; then
    printf '\n%s\nexec "%s/tests/perf/compare.sh"\n' "$MARKER" "$ROOT" >> "$HOOK"
    echo "appended the perf gate to the existing $HOOK"
else
    cat > "$HOOK" <<EOF
#!/usr/bin/env bash
$MARKER — runs the A/B perf comparison before pushing.
# Bypass once with: git push --no-verify
exec "$ROOT/tests/perf/compare.sh"
EOF
    chmod +x "$HOOK"
    echo "installed $HOOK"
fi

echo "the gate runs all scenarios against origin/master (~2 min); bypass with git push --no-verify"
