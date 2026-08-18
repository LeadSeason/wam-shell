# wam-shell conventions

## Runtime services

- Notifications come from AstalNotifd — by default the shell IS the
  notification daemon. If the user runs another daemon (swaync, dunst),
  the shell defers to it at startup (`[notifications] daemon`, default
  "auto"); "wam-shell"/"system" force one or the other.
- The notification center toggles via `ags request -i wam-shell
  notifications` (bind it in the compositor config).
- External services merge into the center through the provider registry
  (`src/lib/notificationProviders.ts`): one lib module per service, a
  filter icon per provider in the center's header. New providers need no
  center changes. Shared plumbing — arrival diffing, banner horizon,
  seen store, JSON client, refresh age gate — lives in
  `lib/providerCore.ts`, `lib/seenStore.ts`, `lib/httpJson.ts`; use it
  rather than growing another copy. Contract + checklist:
  `docs/Providers.md`. Google providers share the OAuth stack in
  `src/lib/googleAuth.ts` (embedded desktop client, per-account tokens,
  `google.env`/env override). A provider can mark an item `actionable`
  (someone is waiting on YOU) to lift it into the center's "Needs you"
  zone — only the provider can tell. A provider with FUTURE-dated
  items (calendar) registers `soonestFirst` to list next-first above
  the newest-first feed; the sort is `compareRows` in
  `widgets/notifications/feed.ts`.
- The clock popover is a Google Calendar (`src/lib/gcal.ts`,
  `[calendar]`): OAuth installed-app flow over loopback, one sign-in
  per account. Refresh tokens live in the Secret Service keyring when
  available (`src/lib/secretStore.ts`), falling back to mode-0600
  `~/.config/wam-shell/*-tokens.json`. Design notes: `docs/gcal.md`.
  Event reminders (Google's own reminder times, then
  `remind_before_minutes`; banners again at start, CRITICAL) and the
  center's "calendar" provider live in `src/lib/gcalReminders.ts`,
  re-armed off `visibleEvents`.
- Performance counters: start with `WAM_SHELL_METRICS=1`, then query
  `ags request -i <instance> metrics` (or `"metrics reset"`).
  Instrumentation lives in `src/lib/metrics.ts`; new code must use its
  `exec`/`execAsync`/`timeoutAdd`/`timeoutAddSeconds`/`sourceRemove`/
  `connect`/`disconnect` wrappers instead of the ags/GLib originals.
  When the env var is unset the wrappers ARE the original functions —
  zero added work on hot paths.

## Notifications: two surfaces, one shape

The banner and the notification center are **deliberately separate
components**, not one card reused: a banner is read in the second it
takes to decide whether to care, a center row is browsed. Don't
re-merge them.

- `widgets/notifications/rowData.ts` — the one normalised shape both
  surfaces render (`fromDesktop`, `fromItem`). Derive fields HERE, not
  in a widget.
- `widgets/notifications/Toast.tsx` — the banner.
  `widgets/notifications/CenterRow.tsx` — the center row.
  `widgets/notifications/feed.ts` — day dividers and per-app folding,
  kept GTK-free so it can be tested directly; folds only CONSECUTIVE
  runs, where the banner stack's `groupPopups` folds by app outright.
- `lib/relTime.ts` — relative ages, plus a refcounted clock the center
  holds only while open. `lib/exclusivePopups.ts` — panels that own the
  same screen corner close each other; a new corner-owning popup is one
  `registerPopup` plus one `closeOtherPopups` call, and the closer must
  be safe to call when already closed.

Three rules that are easy to regress:

- **A sender's `expire_timeout` wins**, per the freedesktop spec: `0`
  means the banner stays until dismissed, any positive value is honoured
  as-is. `[notifications] popup_timeout` applies only when the sender
  defers (`-1`), and urgency only decides within that fallback.
- **Criticals are never folded away or evicted** — they carry no
  timeout, so hiding one hides it indefinitely.
- **Day and month names are deliberately English**, spelled out in
  `relTime.ts` rather than taken from `%A`/`%B` (those follow the
  locale; everything else the shell draws is English). If real
  localisation ever lands, these belong in it.

GTK has no logical CSS properties (no `padding-inline-start`), so
anything that must mirror uses direction-aware widget props
(`marginStart`) or an explicit `.rtl` variant. Set the direction on the
widget that actually needs it: GTK does **not** push an explicitly set
direction down to children that never had one.

## Widgets must be CSS-targetable

Every new widget must carry a stable CSS class so users can style it
from scss — spacing, colors, per-panel overrides
(`window.Bar.<panel-class>`), per-widget margins. Name classes after
the widget (`.sysStats`, `.keyboardLayout`) and add it to the
widget-class list comment in `scss/widgets/bar/bar.scss`.

## Config

- User-facing options live in `config.toml` (all commented, defaults
  documented) and are parsed in `src/config.ts`.
- Validation goes through `lib/configSchema.ts` — `createReader(data,
  section)` then `bool` / `num` / `str` / `oneOf` / `strList`. Don't
  hand-roll `typeof` checks.
- **Decide the flat fallback explicitly.** Any key could historically
  also be written at the top level, and the top level is shared: pass
  `sectionOnly` for any key whose bare name another section might claim
  (`enabled`, `on_panel`, `position`, `poll_minutes`, anything named
  after a section), and `flatKey` where the top-level spelling differs
  (`tray.position` ← `tray_position`). Service sections set
  `sectionOnly` section-wide.
- After any config change, regenerate `config-override.toml`: copy of
  `config.toml` plus the user's active values appended.

## Wiki

- `wiki/` is the user-facing configuration reference: one page per
  config section (`Config-<Section>.md`), indexed in `wiki/Home.md`,
  named so the directory can be pushed verbatim to the GitHub wiki
  (copy `wiki/*.md` over; the file name is the page name).
- A change that adds, renames, removes or re-defaults a config key —
  or changes user-visible behavior — updates the matching page in the
  SAME commit. A new section gets a new page plus a link in `Home.md`.
- `config.toml` stays the exhaustive reference; a wiki page carries a
  table row per key (name, type, default, what it does) and at most a
  few bullets for setup/auth/caveats. `wiki/Config-Workspaces.md` is
  the house style — match it.

## Styling

- Colors come from the active theme (`scss/theme/*.scss`, selected via
  the `theme` config key) — never hardcode hex in widget styles.
- Shared spacing/radius/type values live in `scss/conf.scss`; the
  mixins that spend them — `surface`, `card`, `button-*`, `icon-button`,
  `chip`, `row`, `eyebrow`, `slider`, `meter`, `switch`, `checkbox`,
  `text-field`, `menu` — live in `scss/ui.scss`. Reach for a token or
  mixin BEFORE writing a literal; override after an include when a
  widget must differ, and say why. Full table: `docs/Styling.md`.
- Big widgets get a stylesheet DIRECTORY, not a 1000-line file:
  `scss/widgets/QSettings/` mirrors `src/widgets/QSettings/`.
  `lib/styleCompile.ts` is display-free so `wam install`/`update` can
  precompile it; `lib/style.ts` only decides when to compile and
  applies the result.
- **A `With`/Fragment rebuild appends at the END of its parent box.**
  gnim does not remember where a Fragment sat, so a binding that
  resolves LATE (an async probe, a device switch) re-lands its widget
  last, and panel order becomes timing-dependent — a restart just
  re-rolls the dice. Give it a wrapper box that holds the slot (bind
  `visible` on it when the parent's `spacing` would leave a hole), the
  pattern of `QSettingsLabel.tsx`'s `audioSlot` and Updates pill.
- **A button nested inside a button gets no click — the OUTER one
  fires.** Fix: claim the sequence explicitly, in the CAPTURE phase, on
  the inner button:

      <Gtk.GestureClick button={1}
          propagationPhase={Gtk.PropagationPhase.CAPTURE}
          onPressed={g => g.set_state(Gtk.EventSequenceState.CLAIMED)} />

  Clicking the row BODY still activates it. Re-check both halves
  whenever a button gains a button child — drive the real widget in a
  nested compositor (`swaymsg seat - cursor set/press`).
- **A fullscreen layer-shell window does not paint its own background.**
  The compositor sizes the SURFACE, but GTK allocates content by
  natural size, so `window.Foo { background-color: … }` paints only a
  band the height of the content. Put the fill on a child with
  `hexpand`/`vexpand` instead (`.sessionScrim`). Similarly, a
  non-expanding child of a horizontal box sits at the START edge:
  `halign: CENTER` needs `hexpand` too.
- **A FlowBox lays out only visible FlowBoxChildren.** `visible` on an
  inner box hides the content but leaves the wrapper behind as a blank
  cell. Bind `visible` on an explicit `<Gtk.FlowBoxChild>` instead —
  the child keeps its slot, so one that becomes visible later lands in
  place. Reference: `vpn.tsx`, `NightLightButton`.
- **A too-wide FlowBox child flips the grid to one column — and the
  overflow is below the scroll fold, not gone.** A homogeneous FlowBox
  derives column width from the widest child's NATURAL width, and a
  GtkLabel's natural width is its initial text. Keep a StatTile's `big`
  to the number and put words in `sub`; when tiles "disappear" from a
  pane, check column count and scroll before suspecting bindings —
  a scrolled-out tile and an unbuilt one look identical in a
  screenshot.
- **No gate compiles the scss. `pnpm verify:scss` does** — run it after
  touching anything under `scss/`. It compiles per theme and loads each
  result through GTK's parser, and treats a dart-sass deprecation as a
  failure (those go to stderr with a zero exit). Pass an output
  directory to keep the compiled css and selector sets; a values-only
  change should show an empty selector diff.
- Icons: prefer symbolic names (`-symbolic`). `pan-down`/`pan-up` is an
  expander, `go-next`/`go-previous` is navigation — don't mix them.
  Don't import a second icon set for a name Adwaita lacks; draw it on
  Adwaita's grid instead (`assets/icons/README.md`).

## Libraries vs hand-rolled

Reach for the platform first: libsoup, GLib, Gio, Pango and the Astal
libraries are already dependencies. When adding a JS package, prefer a
dependency-free one that bundles cleanly under esbuild (`smol-toml`).

Hand-rolled on purpose (notes at the top of each file — do not "fix"):

- **The IMAP client** (`lib/protonmail.ts`) — JS IMAP libraries are
  built on `node:net`, which GJS does not have.
- **The test framework** (`tests/framework.ts`) — the suite is bundled
  into one executable; there is no runtime module loader for
  jasmine-gjs to hook.

Deliberately not used: the consent URL in `googleAuth` is built by hand
rather than with `Soup.form_encode_hash`, which takes a GHashTable and
so does not preserve parameter order.

## Formatting

- Prettier is the formatter; config lives in `.prettierrc`. Run
  `node_modules/.bin/prettier --check "src/**/*.{ts,tsx}"` (`--write`
  to fix) when a PR is about to be opened, not on every commit.
- Imports of gnim API (`createState`, `For`, `With`, accessors) come
  from `"gnim"`, GObject from `"ags/gobject"` — not from `"ags"`.

## Resources

- Widget subscriptions pair `subscribe` with `onCleanup`.
- Prefer imperative `createState` over array-form `createComputed` for
  derived display values: its dep cache keys on falsy checks, and an
  initially-falsy dep (`""`, `[]`) can leave the computed stale —
  observed twice (`eligiblePlayers` in `lib/mpris.ts`, and the enriched
  media subtitle in `lib/mediaMeta.ts`, where the title label updated
  on resolution and the sub never did).
- Lib modules with long-lived sources expose a `dispose()` and REGISTER
  it: `registerDispose("<module>", dispose)` from `lib/lifecycle.ts`,
  run by `app.tsx` on `shutdown`. Singletons register from inside
  `get_default()`. Disposers must be idempotent and safe to call when
  the module started nothing.

## Perf gate

- Run `pnpm perf` once when a PR is about to be opened — and again
  before merging if the tree moved. Include the verdict line in your
  summary; on a regression, fix it or state why the cost is justified.
- It compares the working tree against the merge-base with
  origin/master. Flags: `--base <ref>`, `--scenario <name>`, `--json`.
- Verdicts: `VERDICT: OK` (exit 0), `VERDICT: REGRESSION` (exit 1),
  `VERDICT: INCONCLUSIVE` (exit 2 — never infer a pass; read the reason
  and re-run).
- Optional pre-push gate: `pnpm perf:install-hook`. See
  `tests/perf/README.md`.

## Reading a crash

- `coredumpctl` backtraces are useless by default here (every frame is
  `??? () at /usr/lib/libgtk-4.so.1`). Enable debuginfod first:

  ```sh
  export DEBUGINFOD_URLS="https://debuginfod.archlinux.org https://debuginfod.cachyos.org"
  coredumpctl debug <PID> --debugger=gdb \
      --debugger-arguments="-batch -iex 'set debuginfod enabled on' -ex 'bt 16'"
  ```

  The first run downloads a few hundred MB; after that it is cached.
  Do this BEFORE theorising about a crash.
- Four known crash signatures, four different causes — classify a new
  core by its frame 0 before assuming it is one of these:
  1. `gtk_synthesize_crossing_events` (matches upstream
     [GNOME/gtk#3090](https://gitlab.gnome.org/GNOME/gtk/-/issues/3090)):
     crossing-event synthesis over a widget tree changed mid-dispatch —
     banner rows destroyed from inside gesture handlers.
  2. `gdk_wayland_toplevel_remove_from_session`, trigger is MONITOR
     REMOVAL (`hyprctl output create headless` + remove reproduces it
     100%). Fix that shipped: per-monitor windows stay out of the
     `Gtk.Application` (no `application={app}` on Bar/OSD); they are
     therefore not in `app.windows` and unreachable by
     `app.get_window()`/`toggle_window()`. Do NOT try to fix this by
     reordering teardown — the toplevel is freed before any JS cleanup
     runs.
  3. `astal_hyprland_hyprland_get_default` →
     `g_io_stream_get_input_stream` on a NULL stream: missing Hyprland
     IPC socket segfaults at startup; a segfault inside the library, so
     `try`/`catch` does nothing.
- For signature 1: removing a banner from inside a click is deferred
  one idle turn (`removePopupDeferred` in `lib/notifd`). The `resolved`
  handler is the funnel — `desktop.dismiss()`/`invoke()` emit it
  synchronously, so deferring only `PopupRow` changes nothing. Deferred
  sources must be tracked and cleared in `dispose()`. Use plain
  `removePopup` from timers and async callbacks; the deferred one from
  anything reachable by a click. The notification CENTER's rows are
  also destroyed from their own click handlers — no crash traced there,
  but it is where to look first if one appears.
- Monitor hotplug, the non-crash half: Gdk announces a new monitor with
  connector/description/model still NULL; they arrive in later
  `notify::` emissions, which `items-changed` does not refire on.
  `app.tsx` tracks the monitor list itself and bumps state on
  `notify::connector/description/model`.
- When testing a candidate fix, check `ags list` between cycles: once
  the shell has crashed, further cycles are silent no-ops that look
  like a pass.

## Typecheck gate

- `pnpm typecheck` is DELIBERATELY scoped: it filters `tsc` output to
  `src/lib`, `src/config.ts` and `tests`, because a plain run is
  drowned by generated `@girs` duplicate symbols, gnim's `.ts` sources,
  and incomplete ags/gnim JSX prop typings (`src/widgets` carries ~97
  known-false errors).
- Do not "fix" widget errors with casts to widen the scope. If the JSX
  typings improve upstream, widen `COVERED` in `scripts/typecheck.sh`.
- **One error code is reported everywhere, `src/widgets` included:
  TS2304 "Cannot find name"** — an identifier that does not exist is a
  runtime `ReferenceError`, never a typing-gap false positive. Add a
  code to `ALWAYS` only when it has that property.
- `tsconfig.json` is stricter than `strict`: `noUnusedLocals`,
  `noUnusedParameters`, `noFallthroughCasesInSwitch` are on (an
  intentionally unused parameter takes a leading underscore with a
  comment). `noUncheckedIndexedAccess` is deliberately NOT on — it does
  not survive contact with the JSX layer.

## No CI

- There is no CI, deliberately. Five gates run LOCALLY, once, when a PR
  is about to be opened — and again before merging if the tree moved:

      prettier --check "src/**/*.{ts,tsx}"
      pnpm typecheck
      pnpm test
      pnpm test:smoke
      pnpm perf

- Do not add a hosted-runner workflow back in (a PR-time-only one was
  tried: the `pull_request` trigger silently failed to fire, and queued
  runners meant a merge cancelled its own verification run).
- All five are not optional — nothing else will catch a regression.
  Report results honestly, including the perf verdict line.
- They cover TYPESCRIPT only. A change confined to `scripts/`, `*.md`,
  `config.toml` or the systemd unit is invisible to every one of them —
  verify those the way that actually tests them. For a shell script:
  `bash -n`, then exercise it in a sandbox (redirect `HOME`/`WAM_HOME`
  at a temp tree, stub slow or destructive commands on `PATH`, drive
  the real branches).

## Tests

- `pnpm test` runs the unit suite: `tests/*.test.ts` bundled with
  `ags bundle`, run under `gjs` against the real modules
  (`tests/run.sh`). New suites must be registered in `tests/main.ts` —
  the bundler needs static imports. Run once when a PR is about to be
  opened.
- `pnpm test:smoke` (opt-in) boots the real shell as an isolated
  `wam-shell-test` instance and asserts a clean startup.
- `pnpm test:smoke:sway` (opt-in) does the same inside a **nested
  sway** (`WLR_BACKENDS=wayland`) and asserts the sway backend was
  detected. It sets `DESKTOP_SESSION=sway` (what `config.ts` reads —
  without it the nested shell detects the HOST compositor and proves
  nothing) and switches workspaces afterwards. The compositor is
  started by `tests/nested-sway.sh`, also usable by hand
  (`start`/`ctl`/`sock`/`log`/`stop`). **Do not remove
  `LIBSEAT_BACKEND=noop` or the physical-output check** — libseat
  falling back to logind can log the user out, and a live DRM backend
  would drive the actual screens.
- `pnpm test:perf` (opt-in) measures an isolated `wam-shell-perf`
  instance (`tests/perf/run.sh`); the A/B comparison interface is
  `pnpm perf` (see "Perf gate").
- The harness runs on a live desktop session and must never disturb it:
  XDG_CONFIG_HOME / XDG_CACHE_HOME / HOME stay redirected to a tmp dir,
  no test imports modules that call `AstalX.get_default()` at import
  time, nothing owns `org.freedesktop.Notifications`, and `ags quit` is
  only ever called with `-i wam-shell-test`.
- A bare checkout is not runnable (`.sys/`, `node_modules/` are
  gitignored): run `scripts/wam install` first. `scripts/wam` is the
  user-facing management command: install, update,
  start/stop/restart/force-start, autostart (systemd user service).

## Privacy

- Never put personal data in commits, PRs, issues, code comments or
  docs: no SSIDs/network names, host or device names, MAC/IP addresses,
  usernames, real names, media titles, or account details. Use
  placeholders ("MyWiFi") or generic descriptions. The same applies to
  screenshots and log excerpts quoted in artifacts.

## Issues

- When work surfaces a bug unrelated to the current branch, do not fix
  it in passing and do not let it evaporate: file a GitHub issue
  (`gh issue create`) with evidence and a repro, reference it in the
  summary, and leave the fix to a branch of its own.

## Commits

- NEVER merge or create-and-merge a PR without the user's explicit
  instruction. "Implement", "fix", "do the task" mean: implement, run
  the gates, push the branch, open the PR — then STOP and wait. Only an
  explicit approval ("merge", "lgtm", "ship it") authorizes the merge.
- One logical change per commit; split unrelated changes when asked.
- Always sync before merging: `git fetch origin`, merge
  `origin/master` into the branch and resolve conflicts there first.
- Before merging a branch, do a code review of its changes unless one
  was already done in this session.
- Verify the shell starts clean before committing: `ags quit -i
  wam-shell; timeout 8 ags run app.tsx` (no Gjs-CRITICAL / JS ERROR).
- When a change is ready for the user to SEE, restart the live shell
  without being asked: `ags quit -i wam-shell`, then `ags run app.tsx`
  detached (it must keep running — no `timeout`). Do not leave the user
  staring at the old build, and do not just tell them to restart it.
  FIRST `systemctl --user stop wam-shell.service` when it is active:
  with `Restart=always` the service respawns the INSTALLED copy
  (~/.local/share/wam-shell) on every quit, and that old shell races the
  dev build for the instance name and clobbers the shared cache
  (active-tuning.scss, style.css, the ags.js bundle) with old-code
  artifacts — styles silently revert to a build without the new rules.
