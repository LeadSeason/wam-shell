# General

Top-level settings that shape the whole shell: its instance identity,
theme, and a few module switches that belong to no section.

Section: none — all of these keys live at the top level of `config.toml`.

| Key                        | Type                             | Default              | What it does                                                                                                                                                                                                                  |
| -------------------------- | -------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance_name`            | string                           | `"wam-shell"`        | Name of the ags instance, used for `ags request -i <name>` and the cache dir (`~/.cache/<name>`); leave it alone unless you run more than one copy                                                                            |
| `desktop_session_override` | `"hyprland"` / `"sway"` / `"i3"` | `$DESKTOP_SESSION`   | Overrides compositor detection when it guesses wrong                                                                                                                                                                          |
| `os_icon`                  | string                           | unset                | Icon in the top left of the panel: an icon name, or a file path when the string contains `/` (relative paths start at the repo root); unset falls back to the distro logo from `/etc/os-release`, then a generic missing icon |
| `show_os_icon`             | bool                             | `true`               | Set `false` to remove the panel's OS icon entirely — the `osicon` widget renders nothing, in the legacy layout and in any `[[panel]]` list                                                                                    |
| `theme`                    | string                           | `"catppuccin-mocha"` | Color theme — a file `scss/theme/<name>.scss`; shipped: `catppuccin-mocha`, `catppuccin-macchiato`, `catppuccin-frappe`, `catppuccin-latte`, `gruvbox`, `gruvbox-light`                                                       |
| `timezone`                 | string                           | `"auto"`             | Zone the clock, the calendar and every "is it X o'clock" answer is read in. `"auto"` follows the machine's; otherwise an IANA id (`"Asia/Tokyo"`) or a fixed offset (`"+02:00"`, `"-0530"`)                                   |
| `sway_gaps`                | bool                             | `true`               | Runtime-adjustable inner/outer gaps via `ags request`; only relevant on sway/i3                                                                                                                                               |
| `arch_updates_threshold`   | int                              | `50`                 | Minimum pending Arch updates before the update icon shows on the panel; requires the `pending-updates-daemon` user service (see `extra/`)                                                                                     |

- Environment variables do not expand inside `config.toml` — write paths out in full.
- Set `WAM_SHELL_DIR` to the repo path when launching the shell from elsewhere; paths (like `os_icon`) resolve against the repo root.
- `WAM_SHELL_METRICS=1` enables the performance counters; read them with `ags request -i <instance_name> metrics` (or `metrics reset` to zero them).

### `timezone`

Top-level only: it cannot be set inside a section, and a section key of the same
name is ignored. Change it with the CLI rather than by hand — it rewrites
`config.toml` for you and validates the zone first:

```sh
wam timezone Asia/Tokyo   # an IANA identifier
wam timezone +02:00       # a fixed offset
wam timezone auto         # back to the machine's own zone
```

The value is rejected before it is written unless it is `auto`, parses as an
offset, or names an id in `/usr/share/zoneinfo`. A bad value in an existing file
falls back to `auto` at startup rather than refusing to start.

Two surfaces deliberately do **not** follow it:

- **Prayer times** — `adhan` computes them from a plain `Date` and has no
  timezone parameter, so a shifted date would render one location's times as
  another's. The astronomical answer belongs with the `[prayer_times]`
  coordinates.
- **The Harvest timeline's day strip** — each cell is a Harvest `spent_date`,
  which the account writes in its own zone, so the strip stays on the machine's
  to match.
