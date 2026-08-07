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
  (`src/lib/github.ts`, `src/lib/youtube.ts`), a filter icon per
  provider in the center's header. New providers (ProtonMail) need no
  center changes. Google providers share the OAuth stack in
  `src/lib/googleAuth.ts` (embedded desktop client, per-account tokens,
  `google.env`/env override). A provider can mark an item `actionable`
  (someone is waiting on YOU: a review request, a task now due) to lift
  it into the center's "Needs you" zone — only the provider can tell,
  since a PR you opened and one you were asked to review look identical
  from outside.

## Notifications: two surfaces, one shape

The banner and the notification center are **deliberately separate
components**, not one card reused. They answer different questions: a
banner is read in the second it takes to decide whether to care, a
center row is browsed. Sharing one card made banners as tall as list
rows (four of them walled off the side of the screen) and made the
center a stack of identical slabs. Don't re-merge them.

- `widgets/notifications/rowData.ts` — the one normalised shape both
  surfaces render (`fromDesktop`, `fromItem`). Derive fields HERE, not
  in a widget: the two cards drifted apart precisely because each
  re-derived its own, and only one of them learned to drop a summary
  that just repeats the app name.
- `widgets/notifications/Toast.tsx` — the banner. Countdown along the
  bottom edge; several banners from one app fold into one card that
  opens on hover.
- `widgets/notifications/CenterRow.tsx` — the center row. Not a card:
  hairlines between rows, paint only on hover.
- `widgets/notifications/feed.ts` — the center's day dividers and
  per-app folding, kept GTK-free so it can be tested directly. Note it
  folds only CONSECUTIVE runs (reordering a chronological list would be
  a lie), where the banner stack's `groupPopups` folds by app outright.
- `lib/relTime.ts` — relative ages, plus a refcounted clock the center
  holds only while it is open.
- `lib/exclusivePopups.ts` — how panels that own the same screen corner
  close each other. A new corner-owning popup is one `registerPopup`
  plus one `closeOtherPopups` call; the closer must be safe to call when
  already closed.

Three rules that are easy to regress:

- **A sender's `expire_timeout` wins**, per the freedesktop spec: `0`
  means the banner stays until dismissed, any positive value is honoured
  as-is. `[notifications] popup_timeout` applies only when the sender
  defers (`-1`), and urgency only decides within that fallback. The
  shell ignored the field entirely until it was fixed; don't reintroduce
  a blanket duration.
- **Criticals are never folded away or evicted.** A burst of ordinary
  banners must not push one out of the stack, and grouping must not hide
  one behind whichever banner arrived last — they carry no timeout, so
  hiding one hides it indefinitely.
- **Day and month names are deliberately English**, spelled out in
  `relTime.ts` rather than taken from `%A`/`%B`. Those follow the
  locale, and every other string the shell draws is English, so the
  center's dividers read "Today / Yesterday / tisdag / måndag" —
  switching language partway down the list. If real localisation ever
  lands, these belong in it; reverting them to `%A` only restores the
  half-translated version.

GTK has no logical CSS properties (no `padding-inline-start`), so
anything that must mirror uses direction-aware widget props
(`marginStart`) or an explicit `.rtl` variant. When setting a direction,
set it on the widget that actually needs it: GTK does **not** push an
explicitly set direction down to children that never had one, so setting
it on an ancestor silently does nothing.
- The clock popover is a Google Calendar (`src/lib/gcal.ts`,
  `[calendar]`): OAuth installed-app flow over loopback (the project
  ships a desktop client; `google.env`/env vars override it), one
  sign-in per Google account. Refresh tokens live in the Secret Service
  keyring when available (`src/lib/secretStore.ts`), falling back to
  mode-0600 `~/.config/wam-shell/*-tokens.json` (the file always keeps
  account metadata + access tokens). Design notes + resume
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
- Icons: always prefer symbolic icon names (`-symbolic`) over
  full-color ones wherever possible.

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
  origin/master. Flags: `--base <ref>`, `--scenario <name>` (one
  scenario in about a minute), `--json` (full data).
- Verdicts: `VERDICT: OK` (exit 0), `VERDICT: REGRESSION` (exit 1),
  `VERDICT: INCONCLUSIVE` (exit 2 — never infer a pass from it; read
  the reason and re-run).
- Optional pre-push gate: `pnpm perf:install-hook` (opt-in, never
  automatic). See `tests/perf/README.md` for design and limitations.

## Reading a crash

- `coredumpctl` backtraces are useless by default here — every frame is
  `??? () at /usr/lib/libgtk-4.so.1`. Arch/CachyOS ship the URL files but
  nothing exports them, so gdb never fetches symbols:

  ```sh
  export DEBUGINFOD_URLS="https://debuginfod.archlinux.org https://debuginfod.cachyos.org"
  coredumpctl debug <PID> --debugger=gdb \
      --debugger-arguments="-batch -iex 'set debuginfod enabled on' -ex 'bt 16'"
  ```

  The first run downloads a few hundred MB and takes minutes; after that
  it is cached and instant. Do this BEFORE theorising about a crash.
- Applied to the two gjs segfaults of 2026-08-06, this put both in
  `gtk_synthesize_crossing_events` (gtkmain.c:1299) — GTK generating
  pointer enter/leave events and walking a widget's parent — reached from
  `gdk_surface_handle_event`. Not a drawing crash. An earlier guess that
  blamed a negative `cairo_arc` radius was wrong about these two; that
  radius guard is still correct on its own terms (a negative radius is
  undefined), it just was not what killed the shell.
- The lead that leaves: crossing-event synthesis running over a widget
  tree that changed underneath it. Banner rows are destroyed from inside
  gesture handlers (`removePopup` during a click), which is the shape
  that produces this. Not proven, and a 210-round hover/expiry/dismiss
  soak did not reproduce it, so nothing has been changed on the strength
  of it.

## Typecheck gate

- `pnpm typecheck` is one of the five gates (see No CI). It is
  DELIBERATELY scoped: it filters `tsc` output down to `src/lib`,
  `src/config.ts` and `tests`, because a plain run is drowned by things
  that are not this codebase's fault — the generated `@girs` typings
  declare the same symbols across every gtk/gdk/soup version, gnim ships
  `.ts` sources rather than `.d.ts` (scoping by tsconfig pulls its whole
  codebase in), and the ags/gnim JSX prop typings are incomplete, so
  `src/widgets` carries ~97 errors for things like `onChanged` on an
  `<entry>` that are documented and work at runtime.
- Do not "fix" those widget errors with casts to widen the scope. Casting
  to make a gate green makes the code worse and hides the next real one.
  If the JSX typings improve upstream, widen `COVERED` in
  `scripts/typecheck.sh` instead.
- It is worth having: its first run found `Gio.Bus.unwatch_name` (there
  is no `Gio.Bus`, so `dispose()` would have thrown) and three no-arg
  calls to a gnim state setter, which set the state to `undefined` — and
  because gnim skips notification when the value has not changed, every
  bump after the first was silently dropped.

## No CI

- There is no CI, deliberately. Five gates are the whole story, and they
  run LOCALLY, once, at the end of a piece of work — before creating the
  PR and/or merging, whichever comes last:

      prettier --check "src/**/*.{ts,tsx}"
      pnpm typecheck
      pnpm test
      pnpm test:smoke
      pnpm perf
- Do not add a GitHub Actions workflow (or any other hosted runner) back
  in. A PR-time-only workflow was tried and removed: the
  `pull_request` trigger silently failed to fire — no run object was
  created at all for an opened PR, on a workflow with no path or branch
  filters that had fired for every previous PR — so a PR could sit with
  no checks and nothing to say so. Queued hosted runners also meant a
  merge cancelled the very run that was meant to verify it.
- What this means in practice: all five are not optional, because nothing
  else will catch a regression. Run them and report the results honestly,
  including the perf verdict line.

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

## Privacy

- Never put personal data in commits, PRs, issues, code comments or
  docs: no SSIDs/network names, host or device names or descriptions,
  MAC/IP addresses, usernames, real names, media titles, or account
  details. Use placeholders ("MyWiFi") or generic descriptions ("a
  secondary machine"). The same applies to screenshots and log
  excerpts quoted in artifacts.

## Issues

- When work surfaces a bug or problem unrelated to the current branch,
  do not fix it in passing and do not let it evaporate: file a GitHub
  issue (`gh issue create`) with evidence and a repro, reference it in
  the summary, and leave the fix to a branch of its own.

## Commits

- NEVER merge or create-and-merge a PR without the user's explicit
  instruction. "Implement", "fix", "do the task" mean: implement, run
  the gates, push the branch, open the PR — then STOP and wait. Only
  an explicit approval ("merge", "lgtm", "ship it") authorizes the
  merge. Passing gates are never a substitute for the user's sign-off.
- One logical change per commit; split unrelated changes into separate
  commits when asked.
- Always sync before merging: `git fetch origin`, then merge
  `origin/master` into the branch and resolve conflicts there, before
  merging the branch into master. Several sessions commit to master;
  a stale branch conflicts at PR time and has orphaned commits before.
- Before merging a branch, do a code review of its changes
  (correctness, races, leaks, consistency) unless one was already done
  in this session.
- Verify the shell starts clean before committing:
  `ags quit -i wam-shell; timeout 8 ags run app.tsx` (no Gjs-CRITICAL /
  JS ERROR output).
