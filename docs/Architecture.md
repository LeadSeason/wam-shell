# Architecture

One page on how the pieces fit.

## Layers

- **`src/config.ts`** — static, import-time. Finds and parses the config
  file once (first hit of `$XDG_CONFIG_HOME/wam-shell/config.toml`,
  `~/.config/wam-shell/config.toml`, repo `config-override.toml`, repo
  `config.toml`), validates every key with a named error + fallback, and
  exposes the `Config` class. Nothing in it is reactive; changing config
  means a restart (theme reload is the one exception).
- **`src/lib/`** — shared reactive state and services (gnim
  `createState`/`createBinding`). One module per concern: `notifd`,
  `mpris`, `bluetooth`, `sleepTimer`, `harvest`, `gcal`, `screenShare`,
  `sysstats`, `kbLayout`, `vpn`, `hyprsunset`, `brightness`, `osd`,
  `requestHandler`, … Widgets never talk to the system directly; they
  consume these.
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

## IPC

`src/lib/requestHandler.ts` is a singleton command registry. Widgets
`register()` named commands; external callers use
`ags request -i wam-shell <name>` (compositor keybinds toggle the
notification center this way).

## Styling

`src/lib/style.ts` copies the configured theme into the cache dir as
`active-theme.scss` and runs sass over `scss/style.scss` (with
`--load-path` for cache/theme/scss dirs). Compiles are skipped when no
scss file is newer than the cached css; cold start compiles
synchronously; `ags request -i wam-shell style` forces a recompile
(`scripts/style-watch.sh` drives that on save). Colors come from theme
variables only — never hardcode hex in widget styles.

## Compositor backends

`Config.desktopSession` picks hyprland or sway/i3 (i3 IPC protocol).
Compositor-specific code lives behind lib modules (`workspaces-*`,
`kbLayout`, `swayGaps`, `sway-scratchpad`); everything else is
compositor-agnostic.
