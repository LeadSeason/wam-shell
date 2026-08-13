# Sleep Timer

A sleep timer in quick settings that pauses all playing media after a
picked duration, with optional screen dimming and a wake-up chime.

Section: `[sleep_timer]`

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | bool | `true` | Show the sleep timer toggle in quick settings |
| `presets` | list of minutes | `[10, 15, 20, 30, 45, 60]` | Durations offered in the dropdown; a custom value can always be typed into the entry. Must be a non-empty list of positive numbers |
| `time_format` | `"24h"` / `"12h"` / `"auto"` | `"24h"` | How the entry reads clock times. It takes minutes (`45`) or a time of day (`23:30`, told apart by the colon); a time of day resolves forwards, so one that already passed today means tomorrow. `"12h"` reads a bare `7:30` as whichever of 07:30/19:30 comes first and shows an am/pm placeholder; `"auto"` follows the system locale. An explicit am/pm is always honoured |
| `on_panel` | bool | `true` | Show a countdown on the panel while a timer runs; click it to pause/resume. Position it like any other widget: `"sleeptimer"` in a `[[panel]]` list |
| `dim` | bool | `true` | Dim the screen when the timer fires; the pre-dim brightness is remembered across restarts |
| `dim_level` | fraction | `0.4` | Dim target, as a fraction of the current brightness |
| `dim_floor` | fraction | `0.15` | Absolute minimum the dim never goes below |
| `alarm` | bool | `false` | Play a soft chime in a loop when the timer hits 0, until stopped from the pill. The volume is raised to `alarm_volume` and unmuted while it rings, then restored. This key is only the default for the pill's checkbox, which remembers its own state across restarts |
| `alarm_volume` | percent | `80` | Volume the chime rings at; only ever raises the volume, never lowers a louder one |
| `restore_on_play` | bool | `false` | When media starts playing again after the timer fired, also restore the pre-dim brightness (playing always lifts the timer's mutes). Only the default for the pill's checkbox |
| `alarm_only` | bool | `true` | Treat the alarm as a pure reminder: while the chime rings nothing is paused, muted or dimmed, and with the alarm checkbox off the timer is a plain sleep timer again. Set to `false` to pause media and ring at once |

- A running or paused timer survives shell restarts (state is kept in
  `$XDG_RUNTIME_DIR/wam-shell/sleep-timer.json`) but not a reboot. A
  timer that expires while the shell is down does not fire
  retroactively — you get one notification that it expired.
- With the alarm on, the pill also offers a text field: whatever you
  type shows as a critical, never-expiring notification when the timer
  hits 0. It is a per-timer message, not a config key — stopping the
  alarm clears it.
