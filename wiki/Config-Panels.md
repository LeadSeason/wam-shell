# Panels

The panel bar: which monitors it appears on, its size, and — via
`[[panel]]` blocks — multiple bars with their own edge and widget
layout.

Section: none — these keys live at the top level of `config.toml`.
`[[panel]]` blocks are a TOML array of tables.

| Key | Type | Default | What it does |
|---|---|---|---|
| `bar_monitors` | list of strings | `[]` | Monitors that get a panel; entries match the connector (`"HDMI-A-1"`), the model (`"X34 P"`) or a substring of the description (`"Acer"`). Empty = every monitor. Ignored once `[[panel]]` blocks are defined |
| `bar_height` | int (px) | `30` | Panel height — a minimum, not a cap: raising works freely, lowering past what the content needs does nothing |
| `bar_floating` | bool | `false` | Detach the panel from the screen edge so it reads as a floating bar; the window keeps full width and its exclusive zone |
| `bar_float_margin` | int (px) | `6` | The gap floating leaves; added to the panel's height, so floating never shortens the strip |

Each `[[panel]]` block spawns a bar on the matching monitors. When none
are defined the classic single bar is used and the keys above apply.

| Key | Type | Default | What it does |
|---|---|---|---|
| `monitors` | list of strings | `[]` | Same matching as `bar_monitors`; empty = every monitor |
| `position` | `"top"` / `"bottom"` | `"top"` | Which screen edge the bar sits on |
| `class` | string | unset | Extra CSS class on the panel window for per-panel styling (`class = "laptop"` → `window.Bar.laptop`) |
| `height` | int (px) | `bar_height` | This panel's height |
| `floating` | bool | `bar_floating` | Whether this panel floats |
| `left` / `center` / `right` | list of strings | — | Widgets per section; available: `osicon`, `workspaces`, `clock`, `stats`, `tray`, `quicksettings`, `language`, `notifications`, `media`, `sleeptimer`, `harvest`, `windowtitle` |

```toml
[[panel]]
monitors = ["HDMI-A-1"]
position = "bottom"
class = "external"
floating = true
left = ["osicon", "workspaces"]
center = ["clock"]
right = ["stats", "tray"]
```

- The widget lists are authoritative: a listed widget always renders,
  regardless of global toggles like `stats_on_panel` or
  `workspaces.enabled` — those only apply to the classic layout.
