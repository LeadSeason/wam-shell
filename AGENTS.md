# wam-shell conventions

## Runtime services

- Notifications come from AstalNotifd — by default the shell IS the
  notification daemon. If the user runs another daemon (swaync, dunst),
  the shell defers to it at startup (`[notifications] daemon`, default
  "auto"); "wam-shell"/"system" force one or the other. Running swaync
  alongside is still not recommended.
- The notification center toggles via a request command:
  `ags request -i wam-shell notifications` (bind it in the compositor
  config).
- External services merge into the center through the provider registry
  (`src/lib/notificationProviders.ts`): one lib module per service
  (`src/lib/github.ts` is the first, `[github]` + `github.env`), a
  filter icon per provider in the center's header. New providers
  (YouTube, ProtonMail) need no center changes.
- The clock popover is a Google Calendar (`src/lib/gcal.ts`,
  `[calendar]`): OAuth installed-app flow over loopback (the project
  ships a desktop client; `google.env`/env vars override it), one
  sign-in per Google account, tokens in
  `~/.config/wam-shell/gcal-tokens.json`. Design notes + resume
  checklist: `docs/gcal.md`.
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

## Formatting

- Prettier is the formatter; config lives in `.prettierrc` (there is
  intentionally no `prettier` key in package.json — it would shadow the
  file). Run `node_modules/.bin/prettier --check "src/**/*.{ts,tsx}"`
  (`--write` to fix) once at the end of a piece of work — before
  creating the PR and/or merging, whichever comes last, same
  checkpoint as the perf gate. Don't gate every intermediate commit
  on it.
- Imports of gnim API (`createState`, `For`, `With`, accessors) come
  from `"gnim"`, GObject from `"ags/gobject"` — not from `"ags"`.

## Resources

- Widget subscriptions pair `subscribe` with `onCleanup`.
- Lib modules with long-lived sources (timers, D-Bus subscriptions,
  GObject handlers) expose a `dispose()` that tears everything down,
  even when nothing calls it yet (see `lib/harvest.ts`,
  `lib/screenShare.ts`).

## Perf gate

- Run `pnpm perf` once at the end of a piece of work — before creating
  the PR and/or merging, whichever comes last. Don't run it on every
  intermediate iteration. Include the verdict line in your summary. If
  it reports a regression, either fix it or state explicitly why the
  cost is justified.
- `pnpm perf` compares the working tree against the merge-base with
  origin/develop. Flags: `--base <ref>`, `--scenario <name>` (one
  scenario in about a minute), `--json` (full data).
- Verdicts: `VERDICT: OK` (exit 0), `VERDICT: REGRESSION` (exit 1),
  `VERDICT: INCONCLUSIVE` (exit 2 — never infer a pass from it; read
  the reason and re-run).
- Optional pre-push gate: `pnpm perf:install-hook` (opt-in, never
  automatic). See `tests/perf/README.md` for design and limitations.

## Tests

- `pnpm test` runs the unit suite: tests in `tests/*.test.ts` are bundled
  with `ags bundle` and run under `gjs` against the real modules (see
  `tests/run.sh`). New suites must be registered in `tests/main.ts` —
  the bundler needs static imports. Run the suite once at the end of a
  piece of work — before creating the PR and/or merging, whichever
  comes last, same checkpoint as prettier and the perf gate. Don't run
  it on every intermediate iteration.
  the bundler needs static imports.
- `pnpm test:smoke` (opt-in) boots the real shell as an isolated
  `wam-shell-test` instance and asserts a clean startup.
- `pnpm test:perf` (opt-in) measures an isolated `wam-shell-perf`
  instance (tests/perf/run.sh): idle, churn and startup scenarios, one
  single-line JSON blob per scenario on stdout. Requires
  WAM_SHELL_METRICS instrumentation and refuses to run when no
  notification daemon owns org.freedesktop.Notifications. The A/B
  comparison interface is `pnpm perf` (see "Perf gate").
- The harness runs on a live desktop session and must never disturb it:
  XDG_CONFIG_HOME / XDG_CACHE_HOME / HOME stay redirected to a tmp dir,
  no test imports modules that call `AstalX.get_default()` at import
  time (`notifd`, `osd`, `bluetooth`, `mpris`, `brightness`,
  `hyprsunset`, `vpn`, `swayGaps`, …), nothing owns
  `org.freedesktop.Notifications`, and `ags quit` is only ever called
  with `-i wam-shell-test`.
- A bare checkout is not runnable (`.sys/`, `node_modules/` are
  gitignored): run `scripts/wam install` (or `scripts/setup.sh`) first.
  `scripts/wam` is the user-facing management command: install, update,
  start/stop/restart/force-start, and `autostart` (systemd user
  service).

## Issues

- When work surfaces a bug or problem unrelated to the current branch,
  do not fix it in passing and do not let it evaporate: file a GitHub
  issue (`gh issue create`) with evidence and a repro, reference it in
  the summary, and leave the fix to a branch of its own.

## Commits

- One logical change per commit; split unrelated changes into separate
  commits when asked.
- Always sync before merging: `git fetch origin`, then merge
  `origin/develop` into the branch and resolve conflicts there, before
  merging the branch into develop. Several sessions commit to develop;
  a stale branch conflicts at PR time and has orphaned commits before.
- Before merging a branch, do a code review of its changes
  (correctness, races, leaks, consistency) unless one was already done
  in this session.
- Verify the shell starts clean before committing:
  `ags quit -i wam-shell; timeout 8 ags run app.tsx` (no Gjs-CRITICAL /
  JS ERROR output).
