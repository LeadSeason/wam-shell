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
#   - idle cpu (process.cpuTicks = utime+stime): gated idle-1mon only,
#     RELATIVE with tolerance 500 ticks (5 cpu-s per 20s window = 25%
#     of one core above base). Both legs face the same zram-refault
#     weather — this machine bills whole seconds of kernel time to
#     whichever leg happens to run (measured spikes of ~1 cpu-s inside
#     a single second, and a healthy FIXED tree reading 350 ticks in a
#     stormy window) — so relative cancels the weather and the coarse
#     tolerance catches only busy-loop class burns. The FRAME gate
#     below is the sensitive idle-animation detector (#338), and it is
#     absolute because refaults do not render frames.
#   - ABSOLUTE frame bound, candidate leg only, on every idle window
#     (idle-1mon and both soak windows): rendered frames (metrics
#     .frames, one probed bar) over the window must stay ≤ 10/s. An
#     idle shell's frame clock sleeps (~1-2/s: the clock label flip and
#     the odd tray refresh); ~60/s means a never-settling animation on
#     an always-mapped surface — the exact shape of #338, which no
#     A/B counter would have caught because it regressed the BASE and
#     the candidate equally once merged. The base leg's fps is
#     reported, never gated: a pre-fix base reads ~60/s and that is
#     information, not a verdict about the working tree.
#   - soak (opt-in scenario): within-leg growth gates on the candidate
#     between window A and window B (120s apart) — alive timers and
#     live signals may grow by at most 2 (flap headroom for one-shots
#     like battery debounces), plus the same absolute frame and cpu
#     bounds on both windows. Minute-scale horizon: catches per-event
#     accumulation (a timer re-armed per state change), not
#     21-hour-scale drift — no harness of this shape can watch that.
#   - fd count: only fdsOwned is gated (±1; ±8 on churn — the measured
#     instance shares the live session's PipeWire and session bus, so
#     its socket/pipe count shifts with the session's audio streams
#     between legs: measured 44→51 against a feature branch and then
#     51→44 comparing that SAME branch against itself, PR #279; ±12 on
#     idle, which runs with MPRIS unpinned — hooking the session's
#     real player costs its connection fds, measured +9 on the first
#     unpinned leg, and the count follows the session's players after
#     that). The
#     raw total is report-only everywhere: most of a gtk process's fds
#     are gpu buffers (dmabuf, drm syncobj) held for whatever the
#     session is drawing, and comparing the SAME commit against itself
#     reported -12 and then +12 on that number alone
#   - excluded entirely: qsHeader:batTimeDebounce (physical battery
#     events, 2..17 creations across identical runs), osd:hide (OSD
#     triggers come from the live session's WirePlumber/MPRIS),
#     osd:layerRuleWait (a one-shot 2s startup bound on the hyprland
#     layer rule — whether it is still ALIVE when the startup scenario
#     samples is a race against how fast hyprctl answered, measured
#     1 and then 0 comparing a commit against itself),
#     bar:brightnessReveal (same one-shot-startup-timer class: the
#     750ms reveal delayer armed when the async brightness seed lands
#     — the BASE leg measured 1 and then 0 on the same commit, issue
#     #276), tray.hollowGrace (one per tray item still waiting on its
#     final icon — the alive count at sample time races the live
#     session's tray apps answering, not the code being measured:
#     flagged 0→4, 4→5 and 3→4 on unrelated branches and 1→0 / 5→4 in
#     the other direction, all on one day of identical trees, #315), the
#     Gtk_EditableLabel:* signal bucket (PercentEntry rows in the audio
#     panes scale with the live session's audio streams, which come and
#     go between legs — measured 4→0, 0→6 and 2→0 across runs of
#     identical trees, PR #279), the
#     AstalTray_TrayItem:*/Gtk_GestureClick:* signal buckets (they
#     scale with the live session's real tray items) the
#     AstalBluetooth_Device:* buckets (they scale with whatever
#     Bluetooth devices are in range during a leg — measured 10→4
#     connected on identical trees), the AstalMpris_Player:* buckets
#     (they scale with the session's real players — idle and soak run
#     with MPRIS deliberately UNPINNED so the frame gate sees session
#     media, #338), the mpris:playingPulse timer (bounded by design
#     since #338 — it rests unless the playing set changes mid-window,
#     and animation is the frame gate's business, not this counter's),
#     the captureWatch:v4l2Sweep idle source (the V4L2 sweep's walk
#     slicer, measured through the metrics wrapper since #338: alive
#     0 or 1 at sample time by luck of where the walk is), the FrameClock
#     after-paint bucket (the frame probe's own one handler; gjs names
#     the clock unknown_GdkFrameClockIdle and the name has changed
#     across gjs versions; absent entirely in a base leg that predates
#     the probe) — and captureWatch:cameraPoll —
#     but only up to ONE instance. That timer is the direct-V4L2
#     sweep: a Chromium-family browser opens /dev/video* directly, no
#     PipeWire stream exists, and polling /proc is the only way to see
#     the grab — so the poller re-arms forever by design while nothing
#     holds the camera (deterministic 0→1 on startup, idle-1mon and
#     churn; the sweep itself is idle-sliced). scheduleSweep refuses a
#     second timer, so two alive would mean a bug the bound still
#     catches
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
  --scenario   run only this scenario (idle-1mon|churn|startup|soak; soak is
               opt-in and never runs by default)
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
# Only when the worktree is NOT the main checkout: running the compare
# from the main tree itself once replaced .sys with a symlink to
# itself, which broke ags resolution for everything that ran after
if [[ "$WORKTREE" != "$ROOT" ]]; then
    ln -sfn "$ROOT/.sys" "$WORKTREE/.sys"
    ln -sfn "$ROOT/node_modules" "$WORKTREE/node_modules"
fi

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
    # soak is not an A/B scenario: its gates are absolute, on the
    # candidate leg only (see the soak pass below the report). Both
    # legs run it so one command measures everything asked for.
    def per_scenario(a): [a[] | select(.scenario != "soak") | { (.scenario): . }] | add;

    # churn gates on leaks (alive timers/signals/fds), not spawn
    # counts: hyprsunset refreshes coalesce in-flight, so churn spawn
    # counts are dominated by leg timing and machine load (measured
    # 196→66, 140→64 on identical trees). idle measures rates instead.
    def gatedCounters: {
        timerAliveByLabel: (.timers.byLabel
            | with_entries(select(.key != "qsHeader:batTimeDebounce"
                and .key != "osd:hide"
                and .key != "osd:layerRuleWait"
                and .key != "bar:brightnessReveal"
                and .key != "tray.hollowGrace"
                and .key != "mpris:playingPulse"
                and .key != "captureWatch:v4l2Sweep"
                and (.key != "captureWatch:cameraPoll" or .value.alive > 1)))
            | with_entries(.value = .value.alive)),
        signalsByName: (.signals.byName
            | with_entries(select(.key
                | (startswith("AstalTray_TrayItem:") or startswith("Gtk_GestureClick:")
                    or startswith("AstalBluetooth_Device:")
                    or startswith("Gtk_EditableLabel:")
                    or startswith("AstalMpris_Player:")
                    # the frame probe handler — gjs names the clock
                    # type unknown_GdkFrameClockIdle, and the name has
                    # changed across gjs versions before
                    or (contains("FrameClock") and endswith(":after-paint")))
                | not))),
        fds: .process.fds,
        fdsOwned: .process.fdsOwned,
    };

    def gatedFor(scenario): .metrics as $m |
        if scenario == "churn" then $m | gatedCounters
        else ($m | gatedCounters) + {
            subprocesses: ($m.subprocesses | with_entries(.value = .value.count)),
        } + (if scenario == "idle-1mon" then
            { cpuTicks: $m.process.cpuTicks }
          else {} end) end;

    def reported: {
        rssKb: .metrics.process.rssKb,
        voluntaryCtxtSwitches: .metrics.process.voluntaryCtxtSwitches,
        cpuSeconds: ((.metrics.process.cpuTicks // 0) / 100),
        frames: (.metrics.frames // 0),
        blockingMs: (.metrics.subprocesses
            | with_entries(.value = .value.blockingMs)),
        http: .metrics.http,
        batteryTimer: .metrics.timers.byLabel["qsHeader:batTimeDebounce"],
        osdTimer: .metrics.timers.byLabel["osd:hide"],
        osdLayerRuleTimer: .metrics.timers.byLabel["osd:layerRuleWait"],
        brightnessRevealTimer: .metrics.timers.byLabel["bar:brightnessReveal"],
        hollowGraceTimer: .metrics.timers.byLabel["tray.hollowGrace"],
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
        # -12, then +12). fdsOwned excludes them and is the gated one —
        # except on churn, where it still swings with whatever the live
        # session plays between legs (44→51 against a branch, 51→44
        # comparing that same branch against itself): a real leak over
        # 100 cycles grows by hundreds, so ±8 costs no detection.
        # Outside churn the allowance is ±2, not ±1: one long-lived
        # watched child costs TWO owned fds on modern glib — the
        # stdout pipe plus a pidfd (measured: the dev shell holding
        # four streamLines children showed four pidfds beside the four
        # pipe read ends) — so any branch adding exactly one monitor
        # (the captureWatch pw-dump -m watcher, a new vpn listener) must
        # clear ±2. A real leak still fails: it grows by hundreds on
        # churn
        # NOTE: no apostrophes in this jq program — it is single-quoted
        if ($path | test("^churn\\.fdsOwned$")) then 8
        # idle runs with MPRIS unpinned now (#338: the frame gate must
        # see session media): hooking the session real player costs
        # its connection fds — measured +9 owned fds on the first
        # unpinned idle leg (soup/socket/pidfd set for the player) —
        # and the count follows the players the session has after
        # that. ±12 absorbs the unpin and player churn; churn stays
        # the strict leak gate at ±8, and it stays pinned
        elif ($path | test("^idle-1mon\\.fdsOwned$")) then 12
        elif ($path | test("\\.fdsOwned$")) then 2
        elif ($path | test("\\.fds$")) then 999
        elif ($path | test("\\.subprocesses\\.")) then 2
        # idle cpu, relative and coarse (500 ticks = 5 cpu-s per 20s
        # window = 25% of one core above base): both legs face the
        # same zram-refault weather, which bills whole random seconds
        # of kernel time to whichever leg runs (a healthy fixed tree
        # measured 350 ticks in a stormy window), so this gate only
        # means to catch busy-loop class burns. The sensitive idle-
        # animation detector is the frame-clock gate, which is
        # absolute because refaults do not render frames
        elif ($path | test("\\.cpuTicks$")) then 500
        else 0 end;

    def verdict:
        # Direction matters. Every gated counter is a resource count —
        # alive timers, signal handlers, fds, subprocess spawns — so
        # MORE is a regression and FEWER is the improvement you were
        # trying to make. Comparing the absolute difference gated both
        # equally, which meant deleting a timer failed the gate that
        # exists to stop you adding one.
        # NOTE: no apostrophes in this jq program — it is single-quoted
        if (.cur - .base) > tolerance(.path) then "gated"
        elif (.base - .cur) > tolerance(.path) then "improved"
        else "tolerated" end;

    (per_scenario($base)) as $b | (per_scenario($cur)) as $c |
    [ (($b|keys) + ($c|keys) | unique[]) as $s |
        ([diffs($b[$s]|gatedFor($s); $c[$s]|gatedFor($s); [$s])]) as $d |
        {
            scenario: $s,
            gated: [$d[] | select(verdict == "gated")],
            improved: [$d[] | select(verdict == "improved")],
            tolerated: [$d[] | select(verdict == "tolerated")],
            reported: { base: ($b[$s]|reported), current: ($c[$s]|reported) },
        } ]
')"

[[ -n "$REPORT" ]] || inconclusive "report generation failed"
echo "$REPORT" | jq empty 2>/dev/null || inconclusive "report is not valid JSON"

# --- absolute idle rules (#338 gates) -------------------------------------
# These fire on the WORKING TREE regardless of what the base did: the
# gate exists to catch the tree you are about to push animating at
# idle — and to fail the unfixed tree itself (run against itself,
# pre-fix master measures ~60 fps at idle and fails here). A pre-fix
# BASE reads the same ~60 fps; that is reported, not gated.
#   - frames ≤ 10/s on every idle window (idle-1mon, soak A and B):
#     an idle frame clock sleeps (~1-2/s); ~60/s is a never-settling
#     animation on an always-mapped surface
#   - soak only: alive timers and live signals may grow by at most 2
#     across the 120s rest (flap headroom for one-shot sources); more
#     growth inside one leg is the per-event-accumulation leak class
# Idle cpu is NOT here: refault weather makes an absolute bound false-
# positive (a healthy fixed tree measured 350 ticks in a stormy 20s
# window), so it is a relative A/B gate instead — see gatedCounters.
ABS="$(jq -rn --slurpfile base "$OUT/base.json" --slurpfile cur "$OUT/current.json" '
    def windows($files):
        [$files[]
            | if .scenario == "soak" then
                ({scenario: .scenario, win: "A", windowSec: .windowSec,
                  frames: (.metricsA.frames // 0),
                  cpuTicks: (.metricsA.process.cpuTicks // 0)},
                 {scenario: .scenario, win: "B", windowSec: .windowSec,
                  frames: (.metricsB.frames // 0),
                  cpuTicks: (.metricsB.process.cpuTicks // 0)})
              else
                ({scenario: .scenario, win: "-", windowSec: (.windowSec // 20),
                  frames: (.metrics.frames // 0),
                  cpuTicks: (.metrics.process.cpuTicks // 0)})
              end];
    def idleish: .scenario == "idle-1mon" or .scenario == "soak";
    def fps: ((.frames * 10 / .windowSec | round) / 10);
    (windows($base)) as $b | (windows($cur)) as $c |
    [
      # candidate violations — these fail the gate
      [$c[] | select(idleish) |
        (if .frames / .windowSec > 10 then
           "frame clock does not settle at idle: \(.frames) frames in \(.windowSec)s = \((.frames * 10 / .windowSec | round) / 10) fps > 10  (\(.scenario) window \(.win))"
         else empty end)],
      [$cur[] | select(.scenario == "soak") |
        (if ((.metricsB.timers.alive // 0) - (.metricsA.timers.alive // 0)) > 2 then
           "alive timers grow within the soak leg: A \(.metricsA.timers.alive // 0) → B \(.metricsB.timers.alive // 0) (>2 in 120s — a source re-armed per event)"
         else empty end),
        (if ((.metricsB.signals.live // 0) - (.metricsA.signals.live // 0)) > 2 then
           "live signals grow within the soak leg: A \(.metricsA.signals.live // 0) → B \(.metricsB.signals.live // 0) (>2 in 120s)"
         else empty end)],
      # base readings — reported, never gated (a pre-fix base animates)
      [$b[] | select(idleish) |
        (if .frames / .windowSec > 10 then
           "(base) frame clock does not settle at idle: \(.frames) frames in \(.windowSec)s = \((.frames * 10 / .windowSec | round) / 10) fps  (\(.scenario) window \(.win))"
         else empty end)]
    ] | flatten[]'
)"
ABS_CANDIDATE="$(printf '%s\n' "$ABS" | grep -v '^(base)' || true)"
CAND_IDLE_FPS="$(jq -rs '[.[] | select(.scenario == "idle-1mon" or .scenario == "soak") | ((.metrics.frames // 0) * 10 / .windowSec | round) / 10] | if length > 0 then .[0] else empty end' "$OUT/current.json" 2>/dev/null || echo "")"

GIT_STATUS="$(git -C "$ROOT" status --short)"
CANDIDATE_SHA="$(git -C "$ROOT" rev-parse HEAD)"

if [[ -n "$(echo "$REPORT" | jq -r '.[] | .gated[]?')" ]]; then
    VERDICT=REGRESSION
fi

if [[ -n "$ABS_CANDIDATE" ]]; then
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
        --argjson absViolations "$(printf '%s\n' "$ABS_CANDIDATE" | jq -R . 2>/dev/null | jq -sc 'map(select(length > 0))' 2>/dev/null || echo '[]')" \
        --argjson scenarios "$REPORT" \
        '{ verdict: $verdict, base: $base, candidate: $candidate,
           compositor: $compositor, gitStatus: $gitStatus,
           absViolations: $absViolations,
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
        ($s.improved[] | "  - \(difflabel(.path))  \(.base) → \(.cur)  (\($s.scenario), improvement)"),
        ($s.tolerated[] | "  ~ \(difflabel(.path))  \(.base) → \(.cur)  (\($s.scenario), within environment tolerance)")
    '
    if [[ -n "$ABS" ]]; then
        printf '%s\n' "$ABS" | sed 's/^/  /'
    fi
    [[ -n "$CAND_IDLE_FPS" ]] && echo "  idle frames/s (candidate): $CAND_IDLE_FPS"
    echo ""
    echo "  base:       $BASE_SHA"
    echo "  candidate:  $CANDIDATE_SHA (working tree)"
    echo "  compositor: $S_CUR"
    [[ -n "$GIT_STATUS" ]] && echo "$GIT_STATUS" | sed 's/^/  /'
fi

[[ "$VERDICT" == "OK" ]]
