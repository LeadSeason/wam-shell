#!/usr/bin/env bash
# Two-checkout perf comparison: measures a base ref and the working
# tree with tests/perf/run.sh (legs strictly sequential — concurrent
# shells polling would pollute each other), then diffs them.
#
#   tests/perf/compare.sh [base-ref]
#
# base-ref defaults to `git merge-base HEAD origin/develop`. The base
# must contain the perf harness itself (tests/perf/run.sh and
# src/lib/metrics.ts) — a checkout without instrumentation cannot be
# measured.
#
# Gate: counters only, exact except documented environment tolerances.
#   - subprocess spawns per binary: ±2 (poll-phase jitter in the 20s
#     wall-clock window; measured on this machine)
#   - fd count: ±1; startup.fds not gated at all (still settling at the
#     first-ready read, measured 66..69 across identical runs)
#   - excluded entirely: qsHeader:batTimeDebounce (physical battery
#     events, 2..17 creations across identical runs), osd:hide (OSD
#     triggers come from the live session's WirePlumber/MPRIS), and the
#     AstalTray_TrayItem:*/Gtk_GestureClick:* signal buckets (they
#     scale with the live session's real tray items)
# Everything else must diff to exactly zero.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKTREE="/tmp/wam-perf-base"
OUT="$(mktemp -d)"

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

cleanup() {
    ags quit -i wam-shell-perf >/dev/null 2>&1 || true
    if git -C "$ROOT" worktree list --porcelain | grep -q "worktree $WORKTREE$"; then
        git -C "$ROOT" worktree remove --force "$WORKTREE" || true
    fi
    rm -rf "$OUT"
}
trap cleanup EXIT INT TERM

# --- base ref and worktree ---------------------------------------------

BASE_REF="${1:-}"
if [[ -z "$BASE_REF" ]]; then
    BASE_REF="$(git -C "$ROOT" merge-base HEAD origin/develop 2>/dev/null)" \
        || die "cannot resolve merge-base HEAD origin/develop — pass a base ref explicitly"
fi
BASE_SHA="$(git -C "$ROOT" rev-parse "$BASE_REF")" \
    || die "unknown base ref: $BASE_REF"

if [[ -e "$WORKTREE" ]]; then
    git -C "$ROOT" worktree list --porcelain | grep -q "worktree $WORKTREE$" \
        && git -C "$ROOT" worktree remove --force "$WORKTREE" \
        || die "$WORKTREE exists and is not a worktree of this repo"
fi
git -C "$ROOT" worktree add "$WORKTREE" "$BASE_SHA" >/dev/null \
    || die "git worktree add failed"

[[ -x "$WORKTREE/tests/perf/run.sh" && -f "$WORKTREE/src/lib/metrics.ts" ]] \
    || die "base $BASE_SHA has no perf harness (tests/perf/run.sh, src/lib/metrics.ts);
      a checkout without instrumentation cannot be measured"

# .sys/ and node_modules/ are gitignored: a fresh worktree has neither
# and ags/gnim resolve to nothing. Link them from the main checkout.
ln -s "$ROOT/.sys" "$WORKTREE/.sys"
ln -s "$ROOT/node_modules" "$WORKTREE/node_modules"

# --- legs (sequential, never concurrent) --------------------------------

log "base leg: $BASE_SHA"
( cd "$WORKTREE" && bash tests/perf/run.sh ) > "$OUT/base.json" \
    || die "base leg run failed"
[[ -s "$OUT/base.json" ]] || die "base leg produced no output"

# a base leg that silently failed to launch makes every candidate
# number look like a catastrophic regression — refuse to compare
BASE_SPAWNS=$(jq -s '[.[] | .metrics.subprocesses[].count] | add // 0' "$OUT/base.json")
BASE_TIMERS=$(jq -s '[.[] | .metrics.timers.totalCreated] | add // 0' "$OUT/base.json")
if [[ "$BASE_SPAWNS" -eq 0 && "$BASE_TIMERS" -eq 0 ]]; then
    die "base leg produced zero counters — the measured instance did not actually run"
fi

log "working-tree leg"
( cd "$ROOT" && bash tests/perf/run.sh ) > "$OUT/current.json" \
    || die "working-tree leg run failed"
[[ -s "$OUT/current.json" ]] || die "working-tree leg produced no output"

# --- environment guard ---------------------------------------------------

S_BASE=$(jq -rs '.[0].metrics.desktopSession' "$OUT/base.json")
S_CUR=$(jq -rs '.[0].metrics.desktopSession' "$OUT/current.json")
if [[ -z "$S_BASE" || -z "$S_CUR" || "$S_BASE" != "$S_CUR" ]]; then
    die "refusing to compare across environments: base=\"$S_BASE\" current=\"$S_CUR\""
fi
echo "$S_BASE" > "$OUT/session"

# --- diff ---------------------------------------------------------------

# qsHeader:batTimeDebounce is driven by physical battery events and
# measured at 2..17 creations across identical runs on this machine —
# reported, never gated
REPORT="$(
jq -rn --slurpfile base "$OUT/base.json" --slurpfile cur "$OUT/current.json" '
    def per_scenario(a): [a[] | { (.scenario): . }] | add;

    def gated: .metrics | {
        subprocesses: (.subprocesses | with_entries(.value = .value.count)),
        timerAliveByLabel: (.timers.byLabel
            | with_entries(select(.key != "qsHeader:batTimeDebounce"
                and .key != "osd:hide"))
            | with_entries(.value = .value.alive)),
        signalsByName: (.signals.byName
            | with_entries(select(.key
                | (startswith("AstalTray_TrayItem:") or startswith("Gtk_GestureClick:"))
                | not))),
        fds: .process.fds,
    };

    def reported: {
        rssKb: .metrics.process.rssKb,
        voluntaryCtxtSwitches: .metrics.process.voluntaryCtxtSwitches,
        blockingMs: (.metrics.subprocesses
            | with_entries(.value = .value.blockingMs)),
        http: .metrics.http,
        batteryTimer: .metrics.timers.byLabel["qsHeader:batTimeDebounce"],
        osdTimer: .metrics.timers.byLabel["osd:hide"],
        traySignals: (.metrics.signals.byName
            | with_entries(select(.key
                | startswith("AstalTray_TrayItem:") or startswith("Gtk_GestureClick:")))),
        timeToResponsiveMs: .timeToResponsiveMs,
    };

    # absent counter keys are zero (a label with alive: 0 and a missing
    # label are the same state); a NEW non-zero key still diffs
    def num: if . == null then 0 else . end;

    # leaf-level differences as {path, base, cur} objects
    def diffs($a; $b; $path):
        if ($a|type) == "object" and ($b|type) == "object" then
            (($a|keys) + ($b|keys) | unique[]) as $k
            | diffs($a[$k]; $b[$k]; $path + [$k])
        elif ($a|num) != ($b|num)
        then { path: ($path | join(".")), base: ($a|num), cur: ($b|num) }
        else empty end;

    def tolerance($path):
        # startup.fds is still settling at the first-ready read
        # (measured 66..69 across identical runs); idle/churn fds stay ±1
        if ($path | test("^startup\\.fds$")) then 999
        elif ($path | test("\\.subprocesses\\.")) then 2
        elif ($path | test("\\.fds$")) then 1
        else 0 end;

    def verdict:
        if ((.base - .cur) | if . < 0 then -. else . end) > tolerance(.path)
        then "gated"
        else "tolerated" end;

    def line: "\(.path): \(.base) -> \(.cur)";

    (per_scenario($base)) as $b | (per_scenario($cur)) as $c |
    [ (($b|keys) + ($c|keys) | unique[]) as $s |
        ([diffs($b[$s]|gated; $c[$s]|gated; [$s])]) as $d |
        {
            scenario: $s,
            gated: [$d[] | select(verdict == "gated") | line],
            tolerated: [$d[] | select(verdict == "tolerated") | line],
            reported: { base: ($b[$s]|reported), current: ($c[$s]|reported) },
        } ]
')"

[[ -n "$REPORT" ]] || die "report generation failed"
echo "$REPORT" | jq empty || die "report is not valid JSON"
echo "$REPORT" > "$OUT/report.json"

# --- output ---------------------------------------------------------------

echo "perf comparison"
echo "  base:        $BASE_SHA"
echo "  candidate:   $(git -C "$ROOT" rev-parse HEAD) (working tree)"
echo "  compositor:  $(cat "$OUT/session")"
echo "  git status --short:"
git -C "$ROOT" status --short | sed 's/^/    /'
echo ""

GATED_LINES=$(echo "$REPORT" | jq -r '.[] | .gated[]?')
TOLERATED_LINES=$(echo "$REPORT" | jq -r '.[] | .tolerated[]?')
if [[ -z "$GATED_LINES" ]]; then
    echo "gated counters: no differences"
else
    echo "gated counter differences (base -> current):"
    echo "$GATED_LINES" | sed 's/^/  /'
fi
if [[ -n "$TOLERATED_LINES" ]]; then
    echo "within environment tolerance (not gated):"
    echo "$TOLERATED_LINES" | sed 's/^/  /'
fi
echo ""
echo "report-only fields:"
echo "$REPORT" | jq -c '.[] | {scenario, reported}' | sed 's/^/  /'

[[ -z "$GATED_LINES" ]]
