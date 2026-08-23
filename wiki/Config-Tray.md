# Tray

System tray icons, shown either inside the quick settings popup or
directly on the panel.

Section: `[tray]`. These keys can also be set flat at the top
level; the section wins when both are set.

| Key               | Type                 | Default  | What it does                                                                              |
| ----------------- | -------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `on_panel`        | bool                 | `false`  | Show tray items directly on the bar instead of inside the quick settings popup            |
| `spacing`         | int (px)             | `0`      | Horizontal gap between tray icons                                                         |
| `position`        | `"left"` / `"right"` | `"left"` | Side of the quick settings button                                                         |
| `always_on_panel` | list                 | `[]`     | App ids whose tray icons always show on the bar, even when the rest of the tray is nested |
| `popup_icon_size` | int (px)             | `22`     | Tray icon size inside the quick settings popup; the pill around them scales with it       |

- Flat at the top level, `position` must be spelled `tray_position` — a
  bare `position` would collide with `workspaces.position`.
- `always_on_panel` is matched against the SNI Id, title and icon name,
  and as a substring of the tooltip. For Electron apps, match on the
  tooltip: they all report `chrome_status_icon_1` as Id with an empty
  title.
