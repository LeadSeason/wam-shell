# General

Top-level settings that shape the whole shell: its instance identity,
theme, and a few module switches that belong to no section.

Section: none — all of these keys live at the top level of `config.toml`.

| Key                        | Type                             | Default              | What it does                                                                                                                                                                                                                  |
| -------------------------- | -------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance_name`            | string                           | `"wam-shell"`        | Name of the ags instance, used for `ags request -i <name>` and the cache dir (`~/.cache/<name>`); leave it alone unless you run more than one copy                                                                            |
| `desktop_session_override` | `"hyprland"` / `"sway"` / `"i3"` | `$DESKTOP_SESSION`   | Overrides compositor detection when it guesses wrong                                                                                                                                                                          |
| `os_icon`                  | string                           | unset                | Icon in the top left of the panel: an icon name, or a file path when the string contains `/` (relative paths start at the repo root); unset falls back to the distro logo from `/etc/os-release`, then a generic missing icon |
| `theme`                    | string                           | `"catppuccin-mocha"` | Color theme — a file `scss/theme/<name>.scss`; shipped: `catppuccin-mocha`, `catppuccin-macchiato`, `catppuccin-frappe`, `catppuccin-latte`, `gruvbox`, `gruvbox-light`                                                       |
| `sway_gaps`                | bool                             | `true`               | Runtime-adjustable inner/outer gaps via `ags request`; only relevant on sway/i3                                                                                                                                               |
| `arch_updates_threshold`   | int                              | `50`                 | Minimum pending Arch updates before the update icon shows on the panel; requires the `pending-updates-daemon` user service (see `extra/`)                                                                                     |

- Environment variables do not expand inside `config.toml` — write paths out in full.
- Set `WAM_SHELL_DIR` to the repo path when launching the shell from elsewhere; paths (like `os_icon`) resolve against the repo root.
- `WAM_SHELL_METRICS=1` enables the performance counters; read them with `ags request -i <instance_name> metrics` (or `metrics reset` to zero them).
