#!/usr/bin/env bash
# pnpm perf — A/B perf comparison of the working tree against a base
# ref. This is the primary interface to the perf harness.
#
#   tests/perf/compare.sh [--base <ref>] [--scenario <name>] [--json]
#
#     --base       ref to compare against
#                  (default: git merge-base HEAD origin/master)
#     --scenario   run only this scenario (idle-1mon|churn|startup)
#     --json       emit full per-scenario data instead of the summary
#
# Output protocol (agents: parse stdout):
#   line 1 is always the verdict — VERDICT: OK | REGRESSION | INCONCLUSIVE
#   exit 0 = OK, 1 = REGRESSION, 2 = INCONCLUSIVE (base leg failed,
#   compositor mismatch/empty, no session, harness error)
#
# Measures both checkouts with tests/perf/run.sh, legs strictly
# sequential (concurrent shells polling would pollute each other).
# The base ref must contain the perf harness itself
# (tests/perf/run.sh and src/lib/metrics.ts).
#
# Gate: counters only, exact except documented environment tolerances.
#   - subprocess spawns per binary: ±2 (poll-phase jitter in the 20s
#     wall-clock window); NOT gated on churn at all — refresh
#     coalescing makes churn spawn counts load-dominated (measured
#     196→66, 140→64 on identical trees). churn gates on leaks only
#     (alive timers/signals/fds); idle measures rates.
#   - fd count: only fdsOwned is gated (±1). The raw total is
#     report-only everywhere: most of a gtk process's fds are gpu
#     buffers (dmabuf, drm syncobj) held for whatever the session is
#     drawing, and comparing the SAME commit against itself reported
#     -12 and then +12 on that number alone
#   - excluded entirely: qsHeader:batTimeDebounce (physical battery
#     events, 2..17 creations across identical runs), osd:hide (OSD
#     triggers come from the live session's WirePlumber/MPRIS), the
#     AstalTray_TrayItem:*/Gtk_GestureClick:* signal buckets (they
#     scale with the live session's real tray items) and the
#     AstalBluetooth_Device:* buckets (they scale with whatever
#     Bluetooth devices are in range during a leg — measured 10→4
#     connected on identical trees)
# Everything else must diff to exactly zero. Timing/RSS/HTTP are
# reported, never gated.
set -uo pipefail

command -v jq >/dev/null || { printf 'error: jq not found in PATH\n' >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKTREE="/tmp/wam-perf-base"
OUT="$(mktemp -d)"

log() { printf '%s\n' "$*" >&2; }

VERDICT=OK
inconclusive() {
    echo "VERDICT: INCONCLUSIVE"
    echo "  $*"
    exit 2
}

usage() {
    cat >&2 <<'EOF'
usage: pnpm perf [--base <ref>] [--scenario <name>] [--json]
  --base       ref to compare against (default: merge-base HEAD origin/master)
  --scenario   run only this scenario (idle-1mon|churn|startup)
  --json       emit full per-scenario data instead of the human summary
EOF
}

cleanup() {
    ags quit -i wam-shell-perf >/dev/null 2>&1 || true
    if git -C "$ROOT" worktree list --porcelain 2>/dev/null | grep -q "worktree $WORKTREE$"; then
        git -C "$ROOT" worktree remove --force "$WORKTREE" || true
    fi
    rm -rf "$OUT"
}
# trapping EXIT only is deliberate: on INT/TERM bash dies and the EXIT
# trap still runs cleanup; trapping the signals and not exiting would
# resume the script with destroyed state
trap cleanup EXIT

# --- arguments -----------------------------------------------------------

BASE_REF=""
SCENARIO=()
AS_JSON=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --base) BASE_REF="${2:?--base needs a ref}"; shift 2 ;;
        --scenario) SCENARIO+=("${2:?--scenario needs a name}"); shift 2 ;;
        --json) AS_JSON=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage; inconclusive "unknown argument: $1" ;;
    esac
done

# --- base ref and worktree ---------------------------------------------

if [[ -z "$BASE_REF" ]]; then
    BASE_REF="$(git -C "$ROOT" merge-base HEAD origin/master 2>/dev/null)" \
        || inconclusive "cannot resolve merge-base HEAD origin/master — pass --base <ref>"
fi
BASE_SHA="$(git -C "$ROOT" rev-parse "$BASE_REF" 2>/dev/null)" \
    || inconclusive "unknown base ref: $BASE_REF"

if [[ -e "$WORKTREE" ]]; then
    if git -C "$ROOT" worktree list --porcelain 2>/dev/null | grep -q "worktree $WORKTREE$"; then
        git -C "$ROOT" worktree remove --force "$WORKTREE" || true
    else
        inconclusive "$WORKTREE exists and is not a worktree of this repo"
    fi
fi
git -C "$ROOT" worktree add "$WORKTREE" "$BASE_SHA" >/dev/null 2>&1 \
    || inconclusive "git worktree add $BASE_SHA failed"

[[ -x "$WORKTREE/tests/perf/run.sh" && -f "$WORKTREE/src/lib/metrics.ts" ]] \
    || inconclusive "base $BASE_SHA has no perf harness (tests/perf/run.sh, src/lib/metrics.ts);
      a checkout without instrumentation cannot be measured"

# .sys/ and node_modules/ are gitignored: a fresh worktree has neither
# and ags/gnim resolve to nothing. Link them from the main checkout.
ln -s "$ROOT/.sys" "$WORKTREE/.sys"
ln -s "$ROOT/node_modules" "$WORKTREE/node_modules"

# --- legs (sequential, never concurrent) ---------------------------------

log "base leg: $BASE_SHA"
( cd "$WORKTREE" && bash tests/perf/run.sh "${SCENARIO[@]}" ) > "$OUT/base.json" \
    || inconclusive "base leg run failed (see stderr)"
[[ -s "$OUT/base.json" ]] || inconclusive "base leg produced no output"

# a base leg that silently failed to launch makes every candidate
# number look like a catastrophic regression — refuse to compare
BASE_SPAWNS=$(jq -s '[.[] | .metrics.subprocesses[].count] | add // 0' "$OUT/base.json")
BASE_TIMERS=$(jq -s '[.[] | .metrics.timers.totalCreated] | add // 0' "$OUT/base.json")
if [[ "$BASE_SPAWNS" -eq 0 && "$BASE_TIMERS" -eq 0 ]]; then
    inconclusive "base leg produced zero counters — the measured instance did not actually run"
fi

log "working-tree leg"
( cd "$ROOT" && bash tests/perf/run.sh "${SCENARIO[@]}" ) > "$OUT/current.json" \
    || inconclusive "working-tree leg run failed (see stderr)"
[[ -s "$OUT/current.json" ]] || inconclusive "working-tree leg produced no output"

# --- environment guard ---------------------------------------------------
# a missing/misdetected compositor looks identical to a fixed
# regression: with desktopSession == "" whole subsystems no-op and
# every counter drops. Assert, don't assume.

S_BASE=$(jq -rs '.[0].metrics.desktopSession' "$OUT/base.json")
S_CUR=$(jq -rs '.[0].metrics.desktopSession' "$OUT/current.json")
if [[ -z "$S_BASE" || -z "$S_CUR" || "$S_BASE" != "$S_CUR" ]]; then
    inconclusive "refusing to compare across environments: base=\"$S_BASE\" current=\"$S_CUR\""
fi

# --- diff ---------------------------------------------------------------

# qsHeader:batTimeDebounce is driven by physical battery events and
# measured at 2..17 creations across identical runs on this machine —
# reported, never gated
REPORT="$(
jq -rn --slurpfile base "$OUT/base.json" --slurpfile cur "$OUT/current.json" '
    def per_scenario(a): [a[] | { (.scenario): . }] | add;

    # churn gates on leaks (alive timers/signals/fds), not spawn
    # counts: hyprsunset refreshes coalesce in-flight, so churn spawn
    # counts are dominated by leg timing and machine load (measured
    # 196→66, 140→64 on identical trees). idle measures rates instead.
    def gatedCounters: {
        timerAliveByLabel: (.timers.byLabel
            | with_entries(select(.key != "qsHeader:batTimeDebounce"
                and .key != "osd:hide"))
            | with_entries(.value = .value.alive)),
        signalsByName: (.signals.byName
            | with_entries(select(.key
                | (startswith("AstalTray_TrayItem:") or startswith("Gtk_GestureClick:")
                    or startswith("AstalBluetooth_Device:"))
                | not))),
        fds: .process.fds,
        fdsOwned: .process.fdsOwned,
    };

    def gatedFor(scenario): .metrics as $m |
        if scenario == "churn" then $m | gatedCounters
        else ($m | gatedCounters) + {
            subprocesses: ($m.subprocesses | with_entries(.value = .value.count)),
        } end;

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
        # a metric the OTHER leg does not report at all is a shape
        # change (a new counter, a renamed one), not a regression: the
        # legs run different code, so one side simply predates it.
        # Counter keys are exempt — an absent label really is zero
        # there, which is the point of `num` above
        # length 2 is a scenario-level metric (scenario.name); counter
        # maps are deeper (scenario.map.label) and keep the old rule,
        # where an absent label genuinely means zero
        elif ($a == null or $b == null) and ($path | length) == 2
        then empty
        elif ($a|num) != ($b|num)
        then { path: ($path | join(".")), base: ($a|num), cur: ($b|num) }
        else empty end;

    def tolerance($path):
        # the raw fd total is report-only in every scenario: most of
        # the descriptors a gtk process holds are gpu buffers (dmabuf,
        # drm syncobj) kept for whatever the session is drawing, and
        # they swing by a dozen between two runs of IDENTICAL code
        # (measured: the same commit compared against itself reported
        # -12, then +12). fdsOwned excludes them and is the gated one
        # NOTE: no apostrophes in this jq program — it is single-quoted
        if ($path | test("\\.fdsOwned$")) then 1
        elif ($path | test("\\.fds$")) then 999
        elif ($path | test("\\.subprocesses\\.")) then 2
        else 0 end;

    def verdict:
        if ((.base - .cur) | if . < 0 then -. else . end) > tolerance(.path)
        then "gated"
        else "tolerated" end;

    (per_scenario($base)) as $b | (per_scenario($cur)) as $c |
    [ (($b|keys) + ($c|keys) | unique[]) as $s |
        ([diffs($b[$s]|gatedFor($s); $c[$s]|gatedFor($s); [$s])]) as $d |
        {
            scenario: $s,
            gated: [$d[] | select(verdict == "gated")],
            tolerated: [$d[] | select(verdict == "tolerated")],
            reported: { base: ($b[$s]|reported), current: ($c[$s]|reported) },
        } ]
')"

[[ -n "$REPORT" ]] || inconclusive "report generation failed"
echo "$REPORT" | jq empty 2>/dev/null || inconclusive "report is not valid JSON"

GIT_STATUS="$(git -C "$ROOT" status --short)"
CANDIDATE_SHA="$(git -C "$ROOT" rev-parse HEAD)"

if [[ -n "$(echo "$REPORT" | jq -r '.[] | .gated[]?')" ]]; then
    VERDICT=REGRESSION
fi

# --- output: verdict line first, always -----------------------------------

echo "VERDICT: $VERDICT"

if [[ "$AS_JSON" -eq 1 ]]; then
    jq -n \
        --arg verdict "$VERDICT" \
        --arg base "$BASE_SHA" \
        --arg candidate "$CANDIDATE_SHA" \
        --arg compositor "$S_CUR" \
        --arg gitStatus "$GIT_STATUS" \
        --argjson scenarios "$REPORT" \
        '{ verdict: $verdict, base: $base, candidate: $candidate,
           compositor: $compositor, gitStatus: $gitStatus,
           scenarios: $scenarios }'
else
    echo "$REPORT" | jq -r '
        def difflabel(p): (p | split(".")) as $seg | ($seg[2:] | join(".")) as $rest |
            if $seg[1] == "subprocesses" then "\($rest) spawns"
            elif $seg[1] == "timerAliveByLabel" then "timer \($rest)"
            elif $seg[1] == "signalsByName" then "signal \($rest)"
            elif $seg[1] == "fdsOwned" then "open fds (excl. gpu buffers)"
            elif $seg[1] == "fds" then "open fds (total, gpu buffers included)"
            else p end;
        .[] as $s |
        ($s.gated[] | "  \(difflabel(.path))  \(.base) → \(.cur)  (\($s.scenario))"),
        ($s.tolerated[] | "  ~ \(difflabel(.path))  \(.base) → \(.cur)  (\($s.scenario), within environment tolerance)")
    '
    echo ""
    echo "  base:       $BASE_SHA"
    echo "  candidate:  $CANDIDATE_SHA (working tree)"
    echo "  compositor: $S_CUR"
    [[ -n "$GIT_STATUS" ]] && echo "$GIT_STATUS" | sed 's/^/  /'
fi

[[ "$VERDICT" == "OK" ]]
