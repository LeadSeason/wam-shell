# Harvest

Harvest time tracking (getharvest.com): the running timer on the panel, plus a
picker popup to start/stop/resume timers, edit notes and add new entries.

Section: `[harvest]`.

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | bool | `true` | Master toggle (requires credentials, see below) |
| `on_panel` | bool | `true` | Show the timer on the panel: elapsed time while running, day total when idle inside work hours. Left-click opens the picker, right-click stops/resumes. Position it like any other widget: `"harvest"` in a `[[panel]]` list |
| `poll_interval` | int (seconds) | `10` | Time between syncs (clamped to 5 or more). Full re-sync every 5 minutes; 60s while the session is locked |
| `recents` | int | `5` | Recent project/task pairs listed in the picker's Resume section |
| `work_start` / `work_end` | `"HH:MM"` | `""` | When both are set, the panel widget also shows while idle inside this window (dimmed, with the day total); the window may wrap midnight. Empty: the widget only appears while a timer runs |
| `work_days` | string | `""` (every day) | Days the widget shows while idle: comma-separated numeric ranges, `0`=Sunday … `6`=Saturday (`"1-5"` = Mon–Fri); ranges may wrap (`"5-1"` = Fri–Mon). A running/paused timer always shows |
| `collapse_off_days` | bool | `false` | On days outside `work_days`, shrink to a bare icon instead of hiding (a click still opens the popup) |
| `hide_when_screen_sharing` | bool | `true` | While screen sharing, mask the elapsed time, pause button and project/task (tooltip included); the pill shows only a blinking icon. `false` disables the mask entirely |
| `notify` | bool | `true` | Notification on every timer start/pause/stop, wherever it happened. Starts are transient; pauses/stops stay until dismissed |

## Credentials

Without credentials the widget stays off even when `enabled`.

- Run `wam harvest setup` — it walks you through creating a Harvest Personal
  Access Token, verifies it and writes it for you.
- Or write them yourself in `~/.config/wam-shell/harvest.env` (never in
  `config.toml`), as `HARVEST_TOKEN` and `HARVEST_ACCOUNT_ID`, and
  `chmod 600` the file.
- Real environment variables with the same names work too and take precedence.
