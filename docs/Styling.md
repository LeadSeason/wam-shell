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
- Light and dark are told apart from `$base`'s own lightness, so a
  theme does not have to declare which it is. Two things follow from
  it: the drop shadow under every floating surface (12% black on a
  light theme, 35% on a dark one) and the bar's wash, which is mixed
  from `$crust`, `$peach` and `$blue` rather than being a colour of its
  own.
- A theme **may** set `$shadow` to overrule the inferred one — for a
  palette where neither default lands. Nothing else in a theme file is
  optional; everything above is required.

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

## The design system: `conf.scss` and `ui.scss`

Two files carry everything the shell's surfaces have in common.

**`scss/conf.scss` is the values** — pure numbers and font stacks, no
theme dependency, so anything may `@use` it:

| group | tokens |
| --- | --- |
| space | `$padding-small` `$padding` `$gap-small` `$gap` `$gap-large` `$bar-widget-spacing` |
| shape | `$radius-small` `$radius` `$radius-large` `$radius-pill`, `$border` `$hairline` |
| type | `$font-tiny` `$font-small` `$font-title` `$font-display`, `$weight-medium` `$weight-bold`, `$font-ui` `$font-mono` |
| states | `$disabled-opacity` `$quiet-opacity`, `$transition-time` `$transition-slow` `$ease` |
| presets | `$btn-padding{,-icon,-lg}` `$chip-padding` `$row-padding{,-tight}` `$card-padding` `$popup-padding` `$popup-margin` |
| sizes | `$icon` `$icon-medium` `$icon-large`, `$slider-height` `$meter-height` `$seek-height` `$pill-size` |

Which radius to use is decided by **what the thing is**, not by how big
it looks: `$radius-small` for inline marks, `$radius` for buttons, rows
and cards, `$radius-large` for anything that is a window, `$radius-pill`
for anything whose ends should be round.

### Density

Every space token goes through `space()`, which multiplies it by
`[appearance] density` — `compact` (×0.8), `comfortable` (×1, default)
or `relaxed` (×1.2), rounded to whole pixels and floored at 1px:

```toml
[appearance]
density = "compact"
```

It is a **space** axis only. Type, icon and radius tokens are
deliberately outside it: scaling those too stops being "tighter" and
becomes "smaller", which is what a font size is for.

The multiplier reaches sass the same way the theme does — the shell
writes `~/.cache/wam-shell/active-tuning.scss` (`$density: 0.8;`) before
compiling, and `conf.scss` `@use`s it by bare name through the load
path. A density change touches no scss mtime, so, like a theme change,
it forces the compile that the freshness sweep would otherwise skip.
Anything writing a token that comes from `config.toml` rather than from
a theme belongs in that generated file. `$surface-opacity` is the other
such token: `1` normally, `[appearance] blur_opacity` when `blur` is on
(Hyprland only — `lib/layerBlur.ts` wires the compositor side), and the
`surface()` mixin and the bar's fill scale their background alpha by it.

Only ever use `space()` on a **new** token in `conf.scss`. A widget
sheet should be spending tokens, not multiplying them a second time.

**`scss/ui.scss` is what the values add up to** — the theme-aware
mixins. Include these instead of restating them:

| mixin | for |
| --- | --- |
| `surface($bg, $radius)` | a floating window: popup, toast, dialog, OSD |
| `card($bg, $padding)` | a card inside a surface — no border, no shadow |
| `button-quiet` / `button-framed` / `button-accent` | the three buttons |
| `icon-button` / `chip` | icon-only (square) / one of a pickable set |
| `row($padding)` / `row-active` | a list row, and the one in effect |
| `eyebrow` / `eyebrow-rule` / `title` / `display` / `subtitle` | the type roles |
| `slider($height, $fill)` / `meter($fill)` | a control you aim at / a readout you glance at |
| `switch` / `checkbox` / `text-field` | the form controls |
| `menu` | `modelbutton`/`separator`/`arrow` for GTK menus |
| `focus-ring` | keyboard focus, for the surfaces driven by one |

Two rules the mixins encode, worth knowing before overriding them:

- **Accent is feedback on stateless things, surface on stateful ones.**
  A button has no state, so the pointer paints it accent (hover
  `$accent20`, press `$accent40`). A list row, a workspace or a tile
  *can be the active one*, and accent is reserved for saying so — the
  pointer speaks in surface there (`$surface050` / `$surface1`) or the
  two collide, and hovering a workspace looks like switching to it.
- **A card does not frame itself.** Depth is the surface's job. A card
  that also drew a border and a shadow turned every pane into boxes in
  boxes.

When a widget genuinely needs to differ, override *after* the include
and say why. A deliberate exception reads as one; a fresh literal reads
as drift — which is how the tree ended up with popup radii of 6, 12, 14
and 15px at the same time, three unrelated slider designs, and the
`modelbutton`/`separator`/`arrow` block written out twice, identically,
in two files.

One node-path trap, since it cost a working rule: in `Gtk.Scale` the
`slider` and `highlight` nodes are **siblings** under `trough`
(`scale > trough > {fill, highlight, slider}`). `slider highlight`
therefore matches nothing — always reach a fill as
`scale trough highlight`.

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

Two conventions keep the names coherent:

- **`pan-*` is an expander, `go-*` is navigation.** `pan-down`/`pan-up`
  disclose something in place; `go-next`/`go-previous` drill into a pane
  or step through months and days. An expander whose two states are
  different *shapes* — a chevron one way, a lightbulb the other — is the
  bug this rule exists to prevent.
- **Prefer a name Adwaita does not define over one it defines
  differently.** The bundled copies are only a fallback, so a name the
  system theme also ships resolves to *its* drawing, not ours. For the
  handful of concepts Adwaita has no name for (cpu, memory, temperature,
  gpu, hourglass, speedometer, dark-mode) the shell ships original
  drawings on Adwaita's 16px grid rather than importing a second icon
  set — see the README for how to draw one.

## Live reload while developing

`scripts/style-watch.sh` watches `scss/` and triggers `reloadStyle` on
every change. Run it in a terminal alongside `ags run app.tsx` for
instant feedback.

## Checking it: `pnpm verify:scss`

None of the project's five gates compile the scss — they cover
TypeScript, and a shell that starts is a shell that started, styled or
not. So this exists:

```sh
pnpm verify:scss
```

It compiles `style.scss` against **every** theme in `scss/theme/` and
loads each result through GTK's own CSS parser. That is three failures
it catches which reading the diff does not:

- a declaration GTK refuses — its parser reports the error and drops the
  rule, and the shell simply renders without it;
- a theme that stopped compiling while the one you are running is fine,
  which is five themes out of six, most of the time;
- a **dart-sass deprecation**, which exits zero. A compile can succeed
  and still print warnings into every user's log on every start.

Pass a directory to keep the output:

```sh
git stash && pnpm verify:scss /tmp/before && git stash pop
pnpm verify:scss /tmp/after
diff /tmp/before/catppuccin-mocha.selectors /tmp/after/catppuccin-mocha.selectors
```

A change meant to alter values and not structure should show an empty
selector diff. `DENSITY=0.8 pnpm verify:scss` checks a compact build.
