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
  center changes. The shared plumbing — arrival diffing, the banner
  horizon, the persisted seen store, the JSON client, the refresh age
  gate — lives in `lib/providerCore.ts`, `lib/seenStore.ts` and
  `lib/httpJson.ts`; use it rather than growing a fifth copy. Full
  contract and checklist: `docs/Providers.md`. Google providers share the OAuth stack in
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
- Validation goes through `lib/configSchema.ts` — `createReader(data,
  section)` then `bool` / `num` / `str` / `oneOf` / `strList`. Don't
  hand-roll a `typeof` check and a `console.error`; the readers already
  emit a consistent, named message and return the documented default.
- **Decide the flat fallback explicitly.** Historically any key could
  also be written at the top level, and the top level is shared: pass
  `sectionOnly` for any key whose bare name another section might claim
  (`enabled`, `on_panel`, `position`, `poll_minutes`, and anything named
  after a section — `bluetooth.notifications` read the `[notifications]`
  TABLE for years because of this), and `flatKey` where the top-level
  spelling differs (`tray.position` ← `tray_position`). Service sections
  (`[github]`, `[calendar]`, …) set `sectionOnly` section-wide.
- After any config change, regenerate `config-override.toml`: copy of
  `config.toml` plus the user's active values appended.

## Wiki

- `wiki/` is the user-facing configuration reference: one page per
  config section (`Config-<Section>.md`), indexed in `wiki/Home.md`,
  named so the directory can be pushed verbatim to the GitHub wiki
  (`git@github.com:LeadSeason/wam-shell.wiki.git` — copy `wiki/*.md`
  over; the file name is the page name).
- A change that adds, renames, removes or re-defaults a config key —
  or changes user-visible behavior of a feature — updates the matching
  page in the SAME commit. A new section gets a new page plus a link in
  `Home.md`. A new user-facing feature with no config keys still gets a
  page when a user would look for one.
- `config.toml` stays the exhaustive reference; a wiki page carries only
  what a user needs: a table row per key (name, type, default, what it
  does) and at most a few bullets for setup/auth/caveats. No internal
  reasoning or history. `wiki/Config-Workspaces.md` is the house style —
  match it.

## Styling

- Colors come from the active theme (`scss/theme/*.scss`, selected via
  the `theme` config key) — never hardcode hex in widget styles.
- Shared spacing/radius/type values live in `scss/conf.scss`; the mixins
  that spend them — `surface`, `card`, `button-quiet/framed/accent`,
  `icon-button`, `chip`, `row`, `eyebrow`, `slider`, `meter`, `switch`,
  `checkbox`, `text-field`, `menu` — live in `scss/ui.scss`. A widget
  sheet includes those rather than restating them. Reach for a token or
  a mixin BEFORE writing a literal: every popup silhouette, button
  vocabulary and slider design in the tree was individually reasonable,
  and there were four, five and three of them respectively. Override
  after an include when a widget must differ, and say why.
  Full table + the two rules the mixins encode: `docs/Styling.md`.
- Big widgets get a stylesheet DIRECTORY, not a 1000-line file:
  `scss/widgets/QSettings/` mirrors `src/widgets/QSettings/`, and each
  part reopens `window#QSettings`. Compiling is split the same way —
  `lib/styleCompile.ts` is display-free so `wam install`/`update` can
  precompile it (`scripts/precompile-style.ts`), and `lib/style.ts` only
  decides when to compile and applies the result.
- **A button nested inside a button gets no click — the OUTER one fires.**
  Measured both ways with a synthetic click on a plain window: with a box
  root, clicking an inner button fires only that button; with a button
  root, clicking the inner button fires only the ROW. Reasoning about it
  the other way round (that the inner button "claims" the sequence) is
  what shipped an inert × in the notification centre. The fix is to claim
  the sequence explicitly, in the CAPTURE phase, on the inner button:

      <Gtk.GestureClick button={1}
          propagationPhase={Gtk.PropagationPhase.CAPTURE}
          onPressed={g => g.set_state(Gtk.EventSequenceState.CLAIMED)} />

  Clicking the row BODY still activates it. Both halves are worth
  re-checking whenever a button gains a button child — and they are
  checkable: drive the real widget in a nested compositor, where
  `swaymsg seat - cursor set/press` synthesises the click in the same
  coordinate space the shell is rendering into.
- **A fullscreen layer-shell window does not paint its own background.**
  The compositor sizes the SURFACE, but GTK still allocates the window's
  content by natural size, so `window.Foo { background-color: … }` on an
  overlay whose child is a centred card paints a full-width band the
  height of that card and leaves the rest of the screen untouched. Put
  the fill on a child with `hexpand`/`vexpand` instead (`.sessionScrim`).
  While you are there: a non-expanding child of a horizontal box gets its
  natural width at the START edge, so `halign: CENTER` alone centres it
  inside a cell that is already exactly its own width — it needs
  `hexpand` too, or it stays pinned left.
- **A FlowBox lays out only visible FlowBoxChildren.** Every child
  appended to one is wrapped in a `FlowBoxChild`, so `visible` on an
  inner box hides the content but leaves the wrapper behind as a full
  blank cell in a homogeneous grid. Bind `visible` on an explicit
  `<Gtk.FlowBoxChild>` instead — unlike returning `<></>`, the child
  still holds its slot, so one that becomes visible later (an async
  probe answering, an NM profile appearing) lands in place instead of
  at the end of the grid. The QSettings toggle pills (`vpn.tsx`,
  `NightLightButton`) are the reference.
- **No gate compiles the scss. `pnpm verify:scss` does** — run it after
  touching anything under `scss/`. It compiles `style.scss` once per
  theme (generating the `active-theme.scss` and `active-tuning.scss` that
  `lib/styleCompile.ts` writes at runtime) and loads each result through
  GTK's own parser, so it catches a rule GTK silently drops and a theme
  that broke while the one you happen to be running is fine. It also
  treats a **dart-sass deprecation as a failure**: those go to stderr
  with a zero exit, so a compile that "succeeded" can still print
  warnings into the user's log on every single start — the `if()`
  function did exactly that. Pass an output directory to keep the
  compiled css and a selector set per theme; a change meant to alter
  values and not structure should show an empty selector diff.
- Icons: always prefer symbolic icon names (`-symbolic`) over
  full-color ones wherever possible. `pan-down`/`pan-up` is an expander,
  `go-next`/`go-previous` is navigation — don't mix them, and never give
  an expander two different SHAPES for its two states. Don't import a
  second icon set for a name Adwaita lacks: the bundled icons are a
  fallback the system theme overrides, and Papirus next to Adwaita in
  one FlowBox is visible at a glance. Draw it on Adwaita's grid instead
  (`assets/icons/README.md`).

## Libraries vs hand-rolled

Reach for the platform before writing the thing yourself: libsoup, GLib,
Gio, Pango and the Astal libraries are already dependencies and already
solve most of what a shell needs. `Soup.Server` replaced a hand-written
loopback HTTP server in `googleAuth`; `GLib.Uri.parse_params` replaced a
query-string parser; `Soup.form_encode_hash` builds form bodies. When
adding one, prefer a dependency-free package that bundles cleanly under
esbuild (`smol-toml`) over one that pulls half of node in.

Two things in this tree are hand-rolled on purpose, and both have a note
at the top of the file saying so. Do not "fix" them:

- **The IMAP client** (`lib/protonmail.ts`). Every JS IMAP library is
  built on `node:net`, which GJS does not have and esbuild cannot shim
  into a Gio socket — the transport is exactly the part a library would
  supply, and it is the part that cannot work here.
- **The test framework** (`tests/framework.ts`). `pnpm test` bundles the
  whole suite into one executable with `ags bundle`; there is no runtime
  module loader for jasmine-gjs to hook and no CLI to hand a spec glob
  to.

And one where the library exists and is deliberately not used: the
consent URL in `googleAuth` is built by hand rather than with
`Soup.form_encode_hash`, because that takes a GHashTable and so does not
preserve parameter order (and encodes space as `+`). Both are legal;
neither is worth an auth URL that comes out shuffled between runs.

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
  GObject handlers) expose a `dispose()` that tears everything down —
  and REGISTER it: `registerDispose("<module>", dispose)` from
  `lib/lifecycle.ts`, which `app.tsx` runs on the app's `shutdown`
  signal. Singletons register from inside `get_default()`, so a session
  that never builds one is never handed a disposer that would build one
  at shutdown. Disposers must be idempotent (`runDisposers` can be
  reached twice) and safe to call when the module started nothing.
  For two dozen releases these functions existed with no caller at all;
  don't let that come back.

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
  that produces this. It matches a known upstream bug —
  [GNOME/gtk#3090](https://gitlab.gnome.org/GNOME/gtk/-/issues/3090),
  open: GTK keeps the old hover target across a dispatch, and a widget
  recycled mid-flight leaves that pointer stale.
- **Removing a banner from inside a click is therefore deferred one idle
  turn** (`removePopupDeferred` in `lib/notifd`). Still not reproduced —
  the 210-round soak came back clean — so this removes a known hazard
  rather than closing a case; do not record it as the fix.
  Two things about it are easy to get wrong:
  - The banner's own buttons do not reach `removePopup` through
    `PopupRow`. `desktop.dismiss()` and `desktop.invoke()` make astal
    emit `resolved` **synchronously**, and that handler removes the
    popup — so deferring only the call in `PopupRow` looks like a fix
    and changes nothing. The `resolved` handler is the funnel.
  - Deferred sources must be tracked and cleared in `dispose()`, like
    `expiring` already is, or they fire against a torn-down module.
  Use plain `removePopup` from timers and async callbacks (todoist's
  `complete()` runs from a Soup callback and is correctly synchronous);
  use the deferred one from anything reachable by a click.
- Same shape, not changed: the notification CENTER's rows are also
  destroyed from their own click handlers (a provider's `hide()` calls
  `setItems`). No crash has ever been traced there, so it was left
  alone — but it is where to look first if one is.
- **There is a THIRD signature, and it is unrelated to the other two**
  (2026-08-08, issue #223). `gdk_wayland_toplevel_remove_from_session`
  (gdktoplevel-wayland.c:2893) reached from `gtk_window_destroy` →
  `window-removed` → `gtk_application_impl_wayland_window_forget`, with
  `SEGV_MAPERR` — an unmapped address, so a dangling pointer, not a
  NULL one. `xx_session` is GTK 4.22's new xdg-session-management
  support. Do not confuse it with the crossing-event crash: different
  stack, different cause, and the banner deferral does nothing for it.

  **It reproduces 100% in one cycle, and the trigger is MONITOR REMOVAL,
  not teardown:**

      hyprctl output create headless
      sleep 2
      hyprctl output remove HEADLESS-1   # shell is dead here

  No physical display involved, so it is safe to run on a laptop — and
  it means any monitor going away (undock, unplug, output reconfigure)
  takes the shell down. The graceful-quit path was tested and does NOT
  reproduce it: two clean `ags quit` cycles exited 0 with no core, so
  the teardown-ordering theory was wrong. The path is the per-monitor
  `<For>` cleanup in `app.tsx` — the only JS caller of
  `Gtk.Window.destroy` besides teardown.

  **Do not try to fix it by reordering the teardown.** `set_application
  (null)` before `destroy()` was tested and crashes identically, one
  frame earlier (`gtk_window_set_application` instead of
  `gtk_window_destroy`) — it emits `window-removed` too. The toplevel is
  already freed before any JS cleanup runs, so hiding first or deferring
  to an idle are worse, not better. The fix that shipped keeps the
  per-monitor windows out of the `Gtk.Application` entirely (no
  `application={app}` on Bar/OSD — the crash came through the app's
  `window-removed` emission). What it costs: those windows are not in
  `app.windows` and `app.get_window()`/`toggle_window()` cannot reach
  them; neither is used for per-monitor windows.

  When testing a candidate, check `ags list` between cycles: once the
  shell has crashed, further cycles are silent no-ops that look like a
  pass.
- **Monitor hotplug, the non-crash half** (2026-08-11): Gdk announces a
  new monitor with connector, description and model all still NULL —
  they arrive in later `notify::` emissions, which neither
  `items-changed` nor ags's `app.monitors` refires on. A `[[panel]]`
  monitors filter matching on identity (a description substring like
  "Acer") therefore never matched a hotplugged monitor: no bar on it
  until the NEXT monitor change. `app.tsx` tracks the monitor list
  itself and bumps its state on `notify::connector/description/model`.
  Verified with `hyprctl output create headless WAMTEST` (named outputs
  work) plus a panel filtered to `monitors = ["WAMTEST"]`: no bar at
  birth, bar once the connector lands.
- **A FOURTH signature** (2026-08-07, issue #225):
  `astal_hyprland_hyprland_get_default` → `g_io_stream_get_input_stream`
  on a NULL stream. astal reads from the Hyprland IPC connection without
  checking the connect succeeded, so a missing or not-yet-ready socket
  segfaults the process at STARTUP. Three cores 71 seconds apart is what
  it looks like: crash, restart, socket still not ready, crash. It is a
  segfault inside the library, so wrapping `get_default()` in a
  `try`/`catch` does nothing. Distinct from #70, which was the socket
  NOISE from the same area, not a crash.
- Four signatures, four different causes. Classify a new core by its
  frame 0 before assuming it is one of the known ones — the first
  instinct on the 2026-08-08 crash was that it was the crossing-event
  bug, and it was not.

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
- **One error code is reported everywhere, `src/widgets` included:
  TS2304, "Cannot find name."** The scope exists because incomplete JSX
  prop typings produce false positives about things that work at
  runtime; an identifier that does not exist is the opposite — a
  `ReferenceError` the moment the line runs, which no typing gap can
  explain away. Issue #229 was four of these in the sway workspaces
  widget, left behind when a refactor deleted a declaration and kept its
  uses: the widget threw on construction for every sway and i3 user, and
  every gate was green, because the smoke test only ever boots on the
  developer's own compositor. Add an error code to `ALWAYS` only when it
  has that property — a runtime failure that cannot be a false positive.
- Because the scope is narrow, `tsconfig.json` can afford to be stricter
  than `strict`: `noUnusedLocals`, `noUnusedParameters` and
  `noFallthroughCasesInSwitch` are on. An intentionally unused parameter
  takes a leading underscore (`_allDay` in `lib/gcal.ts`) with a comment
  saying why it stays in the signature. `noUncheckedIndexedAccess` is
  deliberately NOT on: it is the right rule and it does not survive
  contact with the JSX layer, so it would bury the covered paths' real
  findings under widget noise the gate exists to filter out.
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
- They cover TYPESCRIPT, and only TypeScript. Prettier globs
  `src/**/*.{ts,tsx}`; typecheck covers `src/lib`, `src/config.ts` and
  `tests`; the unit suite is gjs modules; smoke and perf start and
  measure the shell. A change confined to `scripts/`, `*.md`,
  `config.toml` or the systemd unit is invisible to every one of them —
  running the set there proves nothing and spends minutes of perf
  measurement on a live desktop to say so.
- Verify those the way that actually tests them. For a shell script:
  `bash -n` for syntax, then exercise it in a sandbox — redirect `HOME`
  and `WAM_HOME` at a temp tree, put a stub for anything slow or
  destructive (`pnpm`) first on `PATH`, and drive the real branches. The
  `wam update` self-refresh was checked that way: a fake install running
  from `~/.local/bin/wam` replaced its own file mid-run and the inode
  changed underneath it, which is the whole reason it writes through a
  temp file and a rename rather than in place.

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
- `pnpm test:smoke:sway` (opt-in) does the same inside a **nested sway**
  (`WLR_BACKENDS=wayland`, so it needs no VT, no seatd and no logout) and
  asserts the shell detected the sway backend and ran clean on it.
  Plain smoke boots on whatever compositor the developer is sitting in
  front of, which for everyone so far is hyprland — so `workspaces-sway`,
  `lib/sway` and the i3ipc paths were never once constructed by a gate.
  Issue #229 is the bill for that: a deleted declaration left four uses
  behind, the widget threw on construction, and the whole panel was gone
  on sway and i3 with every gate green. Two things it gets right that are
  easy to get wrong — it sets `DESKTOP_SESSION=sway` (what `config.ts`
  actually reads; the parent session's value is inherited, and without
  this the nested shell detects the HOST compositor and the test proves
  nothing), and it switches workspaces afterwards, because the crash was
  in a computed that re-runs on workspace changes rather than only at
  build time.
  The compositor itself is started by `tests/nested-sway.sh`, which is
  also usable by hand (`start` / `ctl` / `sock` / `log` / `stop`) when
  something on the sway path needs poking at rather than asserting on.
  Its structure and most of its safety reasoning are lifted from hy3's
  `test/nested.sh`; two of that harness's hazards are wlroots-level and
  are guarded here the same way. **Do not remove `LIBSEAT_BACKEND=noop`
  or the physical-output check.** libseat falling back to logind can
  activate the seat the real session is on and log the user out — with
  no crash and nothing in any log — and if the DRM backend ever comes
  up, the harness is driving the actual screens; the check is what turns
  that from a silent disaster into a refusal to start.
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
