# Styling

wam-shell is styled with SCSS, compiled to
`~/.cache/wam-shell/style.css` at startup and on `reloadStyle`.

## Themes

Set the color theme in your config:

```toml
theme = "gruvbox"
```

Shipped themes (files in `scss/theme/`): `catppuccin-mocha` (default),
`catppuccin-macchiato`, `catppuccin-frappe`, `catppuccin-latte`,
`gruvbox`. Unknown names fall back to mocha.

Switch live, no restart:

```sh
ags request -i wam-shell style
```

This re-reads the `theme` key, recompiles and applies the CSS.

## Your own overrides: `scss/user.scss`

Put personal tweaks in `scss/user.scss` (gitignored, created empty on
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
`$bar-widget-spacing` (gap between panel widgets),
`$transition-time`. Theme colors come from `scss/theme/*.scss`
(`t.$accent`, `t.$base`, …) — never hardcode hex in widget styles.

## Targeting widgets and panels

Every widget carries a CSS class (see the list comment in
`scss/widgets/bar/bar.scss`): `.osIcon`, `workspaces`, `clock button`,
`.sysStats`, `.trayItem`, `.QSettings`, `.keyboardLayout`, `.swayNC`.

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

## Live reload while developing

`scripts/style-watch.sh` watches `scss/` and triggers `reloadStyle` on
every change. Run it in a terminal alongside `ags run app.tsx` for
instant feedback.
