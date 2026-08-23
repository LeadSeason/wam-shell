# Architecture

One page on how the pieces fit.

## Layers

- **`src/config.ts`** — static, import-time. Finds and parses the config
  file once (first hit of `$XDG_CONFIG_HOME/wam-shell/config.toml`,
  `~/.config/wam-shell/config.toml`, repo `config-override.toml`, repo
  `config.toml`), validates every key with a named error + fallback, and
  exposes the `Config` class. Validation goes through the typed readers
  in `src/lib/configSchema.ts`, where the flat-fallback rule (a key may
  also be written at the top level) is a named parameter rather than an
  implicit `?? configData[key]` — `sectionOnly` for keys whose bare name
  another section would claim, `flatKey` where the top-level spelling
  differs. Nothing in it is reactive; changing config means a restart
  (theme reload is the one exception).
- **`src/lib/`** — shared reactive state and services (gnim
  `createState`/`createBinding`). One module per concern: `notifd`,
  `mpris`, `bluetooth`, `sleepTimer`, `harvest`, `gcal`, `github`,
  `googleAuth`, `youtube`, `screenShare`, `sysstats`, `kbLayout`, `vpn`, `hyprsunset`, `brightness`, `osd`,
  `requestHandler`, … Widgets never talk to the system directly; they
  consume these.
    - Cross-cutting helpers rather than services: `lifecycle` (the
      shutdown registry), `providerCore` + `seenStore` + `httpJson` +
      `paths` + `credentials` (the notification-center provider plumbing,
      see [Providers.md](Providers.md)), `configSchema`, `atomicWrite`,
      `metrics` (the instrumented wrappers all timer/subprocess/signal
      code must use), `styleCompile`.
- **`src/widgets/`** — GTK4/JSX UI. Bars per monitor, the quick settings
  popup, notification popups + center, media popup, harvest
  popup, OSD, sway scratchpad.

## Windows

Two lifetimes:

- **Eager** (built at startup): the bars and the OSD — they react to
  events and must always exist (a hidden layer window still claims
  input, so visibility is bound on content).
- **Lazy** (built on first use): notification center, media
  popup, harvest popup. They register a request command at import and
  construct their window inside `ensureWindow()` on first toggle.

## Shutdown

Lib modules that own long-lived sources (timers, D-Bus subscriptions,
GObject handlers, streamed children) expose a `dispose()` and register
it with `src/lib/lifecycle.ts` at import. `app.tsx` runs the registry on
the app's `shutdown` signal, newest registration first.

A registry rather than one module importing all of them: the importer
would force-load every service at startup, including the ones that call
`AstalX.get_default()` at import time. Registering from inside a module
means only what the shell actually loaded is torn down, and
`lifecycle.ts` keeps zero imports so nothing can cycle through it.
Disposers must be idempotent and safe to call when the module never
started anything.

## IPC

`src/lib/requestHandler.ts` is a singleton command registry. Widgets
`register()` named commands; external callers use
`ags request -i wam-shell <name>` (compositor keybinds toggle the
notification center this way).

## Styling

`src/lib/styleCompile.ts` copies the configured theme into the cache dir
as `active-theme.scss` and runs sass over `scss/style.scss` (with
`--load-path` for cache/theme/scss dirs). Compiles are skipped when no
scss file is newer than the cached css. `src/lib/style.ts` is the
display-side half: it decides when to compile and applies the result
with `app.apply_css`, and owns the `style` request command
(`scripts/style-watch.sh` drives that on save).

The split exists so the compile can run headlessly: `styleCompile` has
no `ags/gtk4/app` import (which would run `Gtk.init()`), so
`scripts/precompile-style.ts` bundles it and `wam install` / `wam
update` build the stylesheet ahead of time. A genuinely cold cache still
compiles synchronously at startup — ags loads the css at activation, so
an async compile there races the first frame — but that path is now
reached only after a cache wipe.

Colors come from theme variables only — never hardcode hex in widget
styles. `scss/widgets/QSettings/` is split per region to match
`src/widgets/QSettings/`; each part reopens `window#QSettings`.

## Compositor backends

`Config.desktopSession` picks hyprland or sway/i3 (i3 IPC protocol).
Compositor-specific code lives behind lib modules (`workspaces-*`,
`kbLayout`, `swayGaps`, `sway-scratchpad`); everything else is
compositor-agnostic.
