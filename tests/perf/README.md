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

| scenario  | what it does |
|-----------|--------------|
| idle-1mon | no interaction, 20s window (the 1s and 3s intervals dominate) |
| churn     | 100 open/close cycles over the five toggleable popups, then a forced GC |
| startup   | time to first metrics response + blocking exec totals before it |

Each scenario is one single-line JSON blob from `run.sh`; `compare.sh`
diffs the blobs of two legs.

## The gate

Gated (exact unless noted): subprocess spawns per binary (±2),
alive timer sources per label, alive signal handlers per bucket,
fd count (±1; `startup.fds` report-only).

Tolerances and exclusions exist because the session is live, and each
one is measured, not guessed (see the comment block in compare.sh):
poll-phase jitter on spawn counts (±2 on idle; churn spawn counts are
not gated at all — refresh coalescing makes them load-dominated, so
churn gates on leaks only), physical battery events
(`qsHeader:batTimeDebounce`), OSD triggers from the session's
WirePlumber/MPRIS (`osd:hide`), and per-tray-item signal buckets that
scale with whatever tray apps the developer happens to run.

Report-only (never gated): time to first frame, RSS, context switches,
blocking-ms, HTTP counts. Local runs have real desktop noise — an
incoming notification, a track change triggering a cover download.

## Isolation

- Fixture config (`fixtures/config.toml`) sets
  `instance_name = "wam-shell-perf"` and
  `notifications.daemon = "system"`, and is copied into a fresh
  per-leg tmp `XDG_CONFIG_HOME` — the developer's real config can't
  leak in.
- `XDG_CACHE_HOME` is a fresh per-leg tmp dir (style.css et al.).
- `WAM_SHELL_NO_MPRIS=1` pins MPRIS players absent in the measured
  instance (`lib/mpris.ts` returns an empty list): the seek-scale
  connection count and the `mpris:position` timer otherwise flap with
  whatever is playing on the developer's session (#58), which produced
  false REGRESSION verdicts on media-free diffs.
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
