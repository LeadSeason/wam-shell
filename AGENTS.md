# wam-shell conventions

## Runtime services

- Notifications come from AstalNotifd — by default the shell IS the
  notification daemon. If the user runs another daemon (swaync, dunst),
  the shell defers to it at startup (`[notifications] daemon`, default
  "auto"); "wam-shell"/"system" force one or the other. Running swaync
  alongside is still not recommended.
- The app launcher and notification center toggle via request
  commands: `ags request -i wam-shell launcher` and
  `ags request -i wam-shell notifications` (bind these in the
  compositor config).
- Performance counters: start the shell with `WAM_SHELL_METRICS=1`,
  then query `ags request -i <instance> metrics` (single-line JSON,
  prefixed with `<instance>: ` by the request handler) or
  `ags request -i <instance> "metrics reset"` to zero the counters.
  Instrumentation lives in `src/lib/metrics.ts`; new code must use its
  `exec`/`execAsync`/`timeoutAdd`/`timeoutAddSeconds`/`sourceRemove`/
  `connect`/`disconnect` wrappers instead of the ags/GLib originals.
  When the env var is unset the wrappers ARE the original functions —
  zero added work on hot paths.

## Widgets must be CSS-targetable

Every new widget (bar module, quick settings section, etc.) must carry
a stable CSS class so users can style it from scss — spacing, colors,
per-panel overrides (`window.Bar.<panel-class>`), and per-widget margin
tweaks. Name classes after the widget (`.sysStats`, `.keyboardLayout`,
`.swayNC`) and add it to the widget-class list comment in
`scss/widgets/bar/bar.scss`.

## Config

- User-facing options live in `config.toml` (all commented, with
  defaults documented) and are parsed in `src/config.ts`.
- After any config change, regenerate `config-override.toml`: copy of
  `config.toml` plus the user's active values appended.

## Styling

- Colors come from the active theme (`scss/theme/*.scss`, selected via
  the `theme` config key) — never hardcode hex in widget styles.
- Shared spacing/radius values live in `scss/conf.scss`.

## Tests

- `pnpm test` runs the unit suite: tests in `tests/*.test.ts` are bundled
  with `ags bundle` and run under `gjs` against the real modules (see
  `tests/run.sh`). New suites must be registered in `tests/main.ts` —
  the bundler needs static imports.
- `pnpm test:smoke` (opt-in) boots the real shell as an isolated
  `wam-shell-test` instance and asserts a clean startup.
- `pnpm test:perf` (opt-in) measures an isolated `wam-shell-perf`
  instance (tests/perf/run.sh): idle, churn and startup scenarios, one
  single-line JSON blob per scenario on stdout. Requires
  WAM_SHELL_METRICS instrumentation and refuses to run when no
  notification daemon owns org.freedesktop.Notifications.
- `pnpm test:perf:diff` (opt-in) compares the working tree against a
  base ref (default: merge-base with origin/develop) in a git
  worktree, sequentially. It gates only on counters (subprocess spawns,
  alive timers, alive signal handlers, fd count) and exits non-zero on
  any gated difference; timing/RSS/HTTP are report-only.
- The harness runs on a live desktop session and must never disturb it:
  XDG_CONFIG_HOME / XDG_CACHE_HOME / HOME stay redirected to a tmp dir,
  no test imports modules that call `AstalX.get_default()` at import
  time (`notifd`, `osd`, `bluetooth`, `mpris`, `brightness`,
  `hyprsunset`, `vpn`, `swayGaps`, …), nothing owns
  `org.freedesktop.Notifications`, and `ags quit` is only ever called
  with `-i wam-shell-test`.
- A bare checkout is not runnable (`.sys/`, `node_modules/` are
  gitignored): run `scripts/setup.sh` (or `pnpm i`) first.

## Commits

- One logical change per commit; split unrelated changes into separate
  commits when asked.
- Before merging a branch, do a code review of its changes
  (correctness, races, leaks, consistency) unless one was already done
  in this session.
- Verify the shell starts clean before committing:
  `ags quit -i wam-shell; timeout 8 ags run app.tsx` (no Gjs-CRITICAL /
  JS ERROR output).
