# tests/perf — local perf harness

Measures the shell's runtime behavior on the developer's **real, live
session** and gates on counters, not wall-clock time. There is no
budgets.json: absolute budgets assume one controlled environment, and
developer machines differ in CPU, compositor, monitor count and
background load. A delta measured on one machine minutes apart cancels
all of that — nothing to calibrate, nothing to go stale.

## Usage

```sh
pnpm perf                          # A/B: working tree vs merge-base with origin/master
pnpm perf --base <ref>             # compare against a specific ref
pnpm perf --scenario idle-1mon     # one scenario (about a minute)
pnpm perf --json                   # full per-scenario data
pnpm test:perf                     # single-checkout measurement (no diff)
pnpm perf:install-hook             # opt-in pre-push gate (never automatic)
```

Output protocol: the first stdout line is always the verdict.

- `VERDICT: OK` — exit 0, no gated differences
- `VERDICT: REGRESSION` — exit 1, gated counter differences follow
- `VERDICT: INCONCLUSIVE` — exit 2; base leg failed, compositor
  mismatch/empty, no session, harness error. **Never infer a pass from
  an inconclusive run** — read the reason and re-run.

## Scenarios

| scenario  | what it does                                                                             |
| --------- | ---------------------------------------------------------------------------------------- |
| idle-1mon | no interaction, 20s window (the 1s and 3s intervals dominate)                            |
| churn     | 100 open/close cycles over the five toggleable popups, then a forced GC                  |
| startup   | time to first metrics response + blocking exec totals before it                          |
| soak      | opt-in; two 20s idle windows 120s apart in one leg — the gap is where accumulation shows |

Each scenario is one single-line JSON blob from `run.sh`; `compare.sh`
diffs the blobs of two legs. soak is never run by default (`pnpm perf`
runs idle-1mon, churn, startup; `pnpm perf --scenario soak` adds it).

## The gate

Gated (exact unless noted): subprocess spawns per binary (±2),
alive timer sources per label, alive signal handlers per bucket,
`fdsOwned` (±1; ±8 on churn) — file descriptors minus the gpu buffers
(dmabuf, drm syncobj) a gtk process holds for whatever the session
happens to be drawing. The raw `fds` total is report-only in every
scenario: it moved by 12 in both directions when the same commit was
compared against itself, so it can only produce false verdicts. Even
`fdsOwned` still shifts with the live session's audio streams between
legs (44→51 against a branch, then 51→44 comparing that same branch
against itself), which is what the churn tolerance absorbs — a real
leak over 100 cycles grows by hundreds, so it costs no detection.

Tolerances and exclusions exist because the session is live, and each
one is measured, not guessed (see the comment block in compare.sh):
poll-phase jitter on spawn counts (±2 on idle; churn spawn counts are
not gated at all — refresh coalescing makes them load-dominated, so
churn gates on leaks only), physical battery events
(`qsHeader:batTimeDebounce`), OSD triggers from the session's
WirePlumber/MPRIS (`osd:hide`), one-shot startup timers whose
alive-at-sample count races the live session (`osd:layerRuleWait`,
`bar:brightnessReveal`, `tray.hollowGrace` — one per tray item still
waiting on its final icon), per-tray-item signal buckets that
scale with whatever tray apps the developer happens to run,
per-Bluetooth-device signal buckets that scale with whatever devices
are in range during a leg, and the `Gtk_EditableLabel` signal bucket
(`PercentEntry` rows in the audio panes scale with the live session's
audio streams — measured 4→0, 0→6 and 2→0 across runs of identical
trees). `captureWatch:cameraPoll` is exempted up to one alive
instance: it is the direct-V4L2 camera sweep, which must poll /proc
on a slow cadence forever while nothing holds the camera (a direct
grab produces no PipeWire stream to watch), and its guard refuses a
second timer, so the bound still catches a respawn bug.
`mpris:playingPulse`, the `AstalMpris_Player:*` buckets and the
frame-clock `after-paint` bucket are excluded for the same
live-session reason (see below — idle and soak run with MPRIS
deliberately unpinned, so the player count is whatever the session
is doing; the sweep slicer `captureWatch:v4l2Sweep` reads 0 or 1
alive by luck of where its walk is; and the probe's own handler is
absent in a base leg that predates it).

## The idle frame-clock and cpu gates (#338)

Two ABSOLUTE rules on the candidate leg — they fire regardless of
what the base did, and they fail the unfixed tree itself (run
`pnpm perf` on pre-fix master and the candidate _is_ master, reading
~60 fps at idle). A pre-fix BASE shows the same numbers; those are
reported with a `(base)` prefix, never gated — the verdict is about
the tree you are about to push.

- **Frame clock ≤ 10 fps on every idle window** (idle-1mon, soak A
  and B). `metrics.frames` counts rendered frames on the first bar's
  frame clock (`installFrameProbe` in the bar widget; a no-op without
  `WAM_SHELL_METRICS=1`). An idle shell's clock sleeps — ~1-2 fps:
  the clock label flip and the odd tray refresh. ~60 fps means a
  never-settling animation on an always-mapped surface, which is
  exactly what #338 was: the workspace playing indicator pulsed a CSS
  transition for as long as ANY player reported Playing (including a
  muted background tab), measured at ~7% kernel CPU (GL submit
  ioctls, zero user time) on a two-minute-old shell, Hyprland
  recompositing both bars at full refresh, and growing with uptime
  as each frame's heap walk collected zram refaults. A counter A/B
  could not have caught it — nothing accumulated; the base and the
  candidate merely both rendered.
- **Idle cpu, relative, ≤ 500 ticks above base per 20s window**
  (`process.cpuTicks` = utime+stime; i.e. 5 cpu-s = 25% of one core
  above the base leg, idle-1mon only). Coarse and relative on
  purpose: zram refault storms bill whole seconds of kernel time to
  whichever leg happens to run (measured ~1 cpu-s inside a single
  second under memory pressure, and a healthy FIXED tree reading 350
  ticks in a stormy window), so a tight or absolute bound is weather.
  Relative cancels it — both legs run through the same weather — and
  the coarse tolerance catches busy-loop class burns the frame clock
  cannot see.
- **soak, within-leg growth:** alive timers and live signals may
  grow by at most 2 across the 120s rest (flap headroom for
  one-shot sources). More growth inside a single leg is the
  re-armed-per-event leak class — #16's shape. Minute horizon: it
  catches per-event accumulation, not 21-hour drift, which no
  harness of this shape can watch for.

The soak/idle scenarios run **without** `WAM_SHELL_NO_MPRIS` on
purpose: the frame gate must see real session media to catch a pulse
that only animates while something plays. Their gates are absolute
or rate-based precisely so a player coming and going between legs
cannot flip them; churn and startup keep the pin for their exact
counters (#58).

Report-only (never gated): time to first frame, RSS, context switches,
blocking-ms, HTTP counts. `frames` and `cpuSeconds` are reported in
every scenario; `frames` is gated by the absolute idle rule above and
`cpuTicks` by the relative idle gate. Local runs have real desktop
noise — an incoming notification, a track change triggering a cover
download.

**RSS includes the instrumentation's own retention, and cannot not.**
The signal-handler leak detector in `src/lib/metrics.ts` keys its
buckets on the connecting object (`signalBuckets`), so every object that
ever connected a signal stays strongly referenced until the next
`metrics reset` — including exactly the objects a leak would strand,
which is the point: they are the suspects, and a WeakMap would let them
be collected before they could be counted. The cost is that a measured
instance's RSS is structurally higher than an uninstrumented one's, and
grows with churn rather than plateauing. Read RSS as a comparison
between two legs of the same harness, never as the shell's real
footprint, and never treat its growth across a churn scenario as
evidence of a leak on its own — the alive-timer and live-signal counts
are the gated signals for that, and they are the ones that mean it.

## Isolation

- Fixture config (`fixtures/config.toml`) sets
  `instance_name = "wam-shell-perf"` and
  `notifications.daemon = "system"`, and is copied into a fresh
  per-leg tmp `XDG_CONFIG_HOME` — the developer's real config can't
  leak in.
- `XDG_CACHE_HOME` is a fresh per-leg tmp dir (style.css et al.).
- `WAM_SHELL_NO_MPRIS=1` pins MPRIS players absent for **churn and
  startup** (`lib/mpris.ts` returns an empty list): the seek-scale
  connection count and the `mpris:position` timer otherwise flap with
  whatever is playing on the developer's session (#58), which produced
  false REGRESSION verdicts on media-free diffs. **idle and soak run
  unpinned** — the frame gate must see session media to catch a
  #338-shaped pulse (see above), and their absolute/rate gates are
  immune to a player appearing between legs.
- `WAM_SHELL_NO_FOCUS_WATCH=1` disables the focus-loss popup watcher
  (`lib/popupFocus.ts`) in the measured instance: focus bounces from
  the live session would otherwise churn popup hide timers wildly past
  any tolerance (#25).
- The run refuses to start when `org.freedesktop.Notifications` has no
  owner on the session bus: the measured instance must never become
  the developer's notification daemon.
- Cleanup is trapped on EXIT/INT/TERM and only ever runs
  `ags quit -i wam-shell-perf`; a crashed run must not leave an orphan
  shell behind.
- `compare.sh` builds the base in a git worktree and symlinks `.sys/`
  and `node_modules/` from the main checkout (both gitignored — a bare
  worktree is not runnable). It asserts the base leg produced non-zero
  counters before believing any diff.

## Limitations (read this before trusting a number)

- **Advisory.** It runs on one machine, against one compositor, and
  nothing enforces it at review time. The verdict is evidence, not a
  gatekeeper.
- The Phase 1 metrics module (`src/lib/metrics.ts`) is
  environment-independent, so a CI leg can be added later without
  reworking anything beneath it.
- Don't trust a number until it's been cross-checked once against an
  external tool: `strace -f -e trace=execve` for spawns (count only
  `= 0` lines — GLib's PATH search adds ~8 ENOENT attempts per spawn),
  `ls /proc/<pid>/fd` for descriptors.
- A missing or misdetected compositor looks identical to a fixed
  regression: if `DESKTOP_SESSION` is unset, `getDesktopSession()`
  returns `""`, whole subsystems no-op and every counter drops. The
  comparer asserts matching, non-empty sessions; single-checkout runs
  inherit the environment they start in.
- `config.ts` does I/O at import time and its static fields evaluate
  when the class is defined — everything the harness controls via env
  is set before the process starts, never injected later.
- `createPoll` is lazy: it does nothing until something subscribes. A
  scenario that doesn't render a widget won't see its poll, which will
  look like an improvement and isn't.
- `ags request` exits 0 even when the instance isn't up yet — the
  harness waits for a valid metrics payload, not for exit codes.

## Out of scope (deliberately)

- **CI, containers, headless compositors, dbusmock.** The whole point
  of the local design is that the developer's real session provides
  all of it for free.
- **Micro-benchmarks of individual functions.** Nothing here is slow
  because of hot-loop arithmetic.
- **Multi-monitor scenarios.** They depend on physical setup and can't
  be controlled on an arbitrary machine; per-monitor costs have to be
  caught by review.
- **Refactoring anything the harness touches.** If instrumenting a
  call site reveals a bug, note it and move on — a perf-tooling PR
  that also changes behavior is unreviewable.
