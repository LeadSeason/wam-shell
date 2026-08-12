# Workspaces

Workspace indicator on the panel (hyprland, sway and i3).

Section: `[workspaces]`. These keys can also be set flat at the top
level; the section wins when both are set.

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | bool | `true` | Show the widget at all (classic layout only — a `[[panel]]` list that names `workspaces` always renders it) |
| `position` | `"left"` / `"right"` | `"left"` | Next to the OS icon, or at the right edge of the tray section |
| `show_icons` | bool | `true` | Per-workspace app icons |
| `show_labels` | bool | `true` | Workspace number/name |
| `hide_empty` | bool | `false` | Hide workspaces with no windows; the focused workspace always shows |
| `collapse_icons` | bool | `false` | One icon per app per workspace, however many windows of it are open |
| `playing_indicator` | bool | `true` | Highlight workspaces holding a currently playing media player (pulsing accent tint) |
| `playing_pulse_ms` | int | `650` | Pulse tempo: half a breath in ms (fade and beat both run on it); min 200 |
