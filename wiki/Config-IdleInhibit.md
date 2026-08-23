# Idle Inhibit

Controls what the "Keep Awake" quick settings toggle (also the bar's cup
indicator and the `keep-awake` request command) does when switched on.

Section: `[idle_inhibit]`

| Key       | Type | Default | What it does                                                                                                                                                                     |
| --------- | ---- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command` | list | `[]`    | Run this instead of the built-in inhibitor; started when keep awake goes on, killed when it goes off — must BLOCK for as long as it should inhibit. Empty uses the built-in lock |

- By default the shell takes a logind inhibitor lock — no helper process, released automatically if the shell dies.
- The built-in lock covers logind's own idle actions and hypridle (unless you set `ignore_systemd_inhibit` there).
- swayidle does NOT look at logind inhibitors — on sway, use a Wayland idle-inhibit helper instead, e.g. `command = ["wlinhibit"]` or `command = ["systemd-inhibit", "--what=idle", "--who=wam-shell", "--why=Keep awake", "sleep", "infinity"]`.
