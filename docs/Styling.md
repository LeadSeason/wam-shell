# Theming and styling

wam-shell is styled with SCSS. At startup (and on `reloadStyle`) the
configured theme file is copied to `~/.cache/wam-shell/active-theme.scss`
(outside the source tree, so read-only installs work; `sass` finds it
through `--load-path`), the whole `scss/` tree is compiled with `sass`
to `~/.cache/wam-shell/style.css`, and that CSS is applied. The compile
is skipped entirely when no `scss/` file is newer than the emitted CSS.
Everything visual — colors, spacing, radii — flows from that one compile.

## Picking a theme

Set the `theme` key in `config.toml`:

```toml
theme = "gruvbox"
```

Shipped themes (files in `scss/theme/`):

| theme | flavor |
| --- | --- |
| `catppuccin-mocha` | dark (default) |
| `catppuccin-macchiato` | dark |
| `catppuccin-frappe` | dark |
| `catppuccin-latte` | light |
| `gruvbox` | dark |
| `gruvbox-light` | light |

Unknown names fall back to `catppuccin-mocha`.

Switch live, no restart (re-reads the `theme` key, recompiles,
applies):

```sh
ags request -i wam-shell style
```

## Dark Style: following the system color scheme

The **Dark Style** quick-settings toggle flips
`org.gnome.desktop.interface color-scheme` for your apps — and also
switches the shell's own theme live, using the `[appearance]` pair:

```toml
[appearance]
dark_theme = "gruvbox"
light_theme = "gruvbox-light"
```

Notes:

- The switch is **live only, not persisted**. On restart the plain
  `theme` key wins again — the shell does not read the gsettings state
  at startup.
- Both values are validated against `scss/theme/`; invalid names fall
  back to the defaults (`catppuccin-mocha` / `catppuccin-latte`).

## Writing your own theme

Add `scss/theme/<name>.scss` and set `theme = "<name>"`. A theme is a
palette in catppuccin-style roles plus one accent; alpha mixes are
generated from it. Start from a copy of an existing theme and change
the header — everything below it is boilerplate:

```scss
@use "sass:color";

$blue: #458588;
$green: #98971a;
/* … the other color roles … */

$text: #3c3836;        // primary foreground
$subtext1: #504945;    // dimmer foreground
$subtext0: #665c54;    // dimmest foreground
$overlay2: #7c6f64;    // borders, separators (strong → weak)
$overlay1: #928374;
$overlay0: #a89984;
$surface2: #bdae93;    // widget backgrounds (strong → weak)
$surface1: #d5c4a1;
$surface0: #ebdbb2;
$base: #fbf1c7;        // panel/window background
$mantle: #f2e5bc;      // slightly off-base
$crust: #ebdbb2;       // deepest background (popups, cards)

$accent: $blue;        // sliders, active toggles, focus rings, spines
```

Rules of thumb:

- `$accent` drives most interactive styling; `$accent10`…`$accent90`
  (10–90% opacity mixes) are used for hovers and highlights.
- For a light theme, `$text` is dark and `$base` is light; for dark,
  the inverse. Keep the role semantics, not specific hues.
- Widget styles must use these tokens — never hardcode hex in
  `scss/widgets/`.

## Your own overrides: `scss/user.scss`

Personal tweaks go in `scss/user.scss` (gitignored, created empty on
compile). It is loaded **last**, so its rules win over the shipped
styles — the repo stays clean and updates never conflict with your
changes.

```scss
// scss/user.scss
window.Bar > centerbox > box > *:not(:last-child) {
    margin-right: 12px;
}
```

## Design tokens

Shared values live in `scss/conf.scss`: `$padding`, `$gap`,
`$gap-small`, `$radius`, `$font-small`, `$slider-height`, `$pill-size`,
`$bar-widget-spacing` (gap between panel widgets), `$transition-time`.
Theme colors come from `scss/theme/*.scss` (`t.$accent`, `t.$base`, …).

## Targeting widgets and panels

Every widget carries a stable CSS class (see the list comment in
`scss/widgets/bar/bar.scss`): `.osIcon`, `workspaces`, `clock button`,
`.sysStats`, `.trayItem`, `.QSettings`, `.keyboardLayout`, `.swayNC`,
`.media`, `.sleepTimer`. Windows have their own classes too —
`window.NotificationPopups .popup`, `window.Notifications
.notification`, `window.QSettings`, `window.MediaPopup`, the OSD, …

Per-widget spacing:

```scss
.sysStats { margin-right: 12px; }
```

Per-panel styling: give a panel a class in its `[[panel]]` block and
target it:

```toml
[[panel]]
class = "laptop"
```

```scss
window.Bar.laptop { opacity: 0.95; }
```

## Icons

Widget icons are looked up by name from your **system icon theme**
(GTK). So the shell never hardcodes icon files, only names
(`bluetooth-symbolic`, …). Because some of those names only exist in
recent adwaita-icon-theme releases, the shell also bundles fallback
copies under `assets/icons/` (registered as an extra search path) —
system themes always take precedence. See `assets/icons/README.md`.

## Live reload while developing

`scripts/style-watch.sh` watches `scss/` and triggers `reloadStyle` on
every change. Run it in a terminal alongside `ags run app.tsx` for
instant feedback.
