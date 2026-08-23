# wam-shell

A desktop shell for **Hyprland** and **sway/i3**, written in TypeScript
and GTK4 on top of [ags](https://aylur.github.io/ags/) and
[astal](https://github.com/Aylur/astal).

It replaces the usual pile of separate programs — a bar, a notification
daemon, a quick-settings panel, an OSD — with one process that shares
state between them, so the volume you change from the panel is the same
volume the OSD shows and the same one the sleep timer restores.

## What it gives you

- **A panel**, per monitor or per `[[panel]]` config entry: workspaces,
  clock (with a Google Calendar popover), window title, system stats,
  tray, keyboard layout, media, a Harvest timer, a sleep-timer
  countdown, and a quick-settings button. Configurable height, and it
  can float off the screen edge (`bar_floating`).
- **A launcher** that is also a command palette and a clipboard
  history: applications by default, `>` for every shell command with its
  arguments, `:` for the clipboard.
- **A session menu** — lock, suspend, hibernate, log out, restart, shut
  down — that hides what the machine cannot actually do.
- **Quick settings** — audio and brightness sliders with per-device
  panes, Wi-Fi, wired, Bluetooth (including pairing), VPN, power
  profiles, night light, sway gaps, a media player card and the tray.
- **A notification center and banners.** By default the shell _is_ the
  notification daemon; it steps aside if another one is already running.
  Banners honour the sender's own `expire_timeout`, fold per app, and
  never bury a critical. Middle-click a banner to snooze it for ten
  minutes; mute a chatty app from its row in the center, and it keeps
  collecting there without interrupting again.
- **Service integrations** that merge into the same notification center:
  GitHub notifications, Todoist due tasks, ProtonMail unread mail (via
  Bridge's local IMAP), YouTube subscription uploads, and Google
  Calendar. Each is one lib module behind a shared provider interface —
  see [docs/Providers.md](docs/Providers.md).
- **A sleep timer** that pauses playback, dims the screen, and survives
  a shell restart or crash — and its opposite, a keep-awake toggle that
  holds off the idle timeout and shows a cup on the bar while it does.
- **Screenshots and screen recording**: region, focused window (the
  compositor supplies the geometry, so there is no rectangle to draw) or
  whole screen, saved and copied at once.
- **An OSD** for volume, microphone, brightness, keyboard layout and
  lock keys, with per-kind durations.
- **Theming** from scss: six themes ship, `theme` picks one, and
  `scss/user.scss` is yours and never overwritten. Shadows and the bar's
  wash follow the palette rather than being fixed, and
  `[appearance] density` tightens or loosens every space in the shell.

## Install

One line, no clone needed:

```shell
curl -fsSL https://raw.githubusercontent.com/LeadSeason/wam-shell/master/scripts/wam | bash -s -- install
```

or from a clone: `scripts/wam install` (extra args go to
`scripts/setup.sh`, e.g. `--source`).

Install clones the repo into `~/.local/share/wam-shell` and symlinks the
`wam` command itself into `~/.local/bin`. Everything runs from those two
spots, so **the original clone can be deleted** — `wam` is all you need
from then on. Because it is a link rather than a copy, `wam update`
moves the command itself forward with the shell; an install from before
this was true is converted to a link on its next update.

Then either `wam start`, or `wam autostart enable` to start it at login.

### Requirements

Arch is the smooth path (the AUR has the astal libraries); everything
else builds them from source with `--source`. Runtime features need
their daemons: battery needs `upower`, the audio slider needs
`wireplumber`, power profiles need `power-profiles-daemon`, and the
stylesheet needs `dart-sass`. The shell talks to sway over the
`i3ipc-1.0` typelib from
[i3ipc-glib](https://github.com/acrisci/i3ipc-glib) — required even on
non-sway sessions, since the sway modules are imported at startup.

Nix users: get ags via `nix shell github:aylur/ags` and point the setup
at it with `AGS_JS_DIR=/path/to/ags/js pnpm run setup`.

## Configuring it

Everything lives in one TOML file, looked up in this order:

1. `$XDG_CONFIG_HOME/wam-shell/config.toml`
2. `~/.config/wam-shell/config.toml`
3. `config-override.toml` in the repo
4. `config.toml` in the repo

**[`config.toml`](config.toml) is the reference**: every option appears
there, commented out, with its default and an explanation. Copy the
lines you want to change into your own file rather than copying the
whole thing — anything absent falls back to the documented default, and
a value that fails validation is reported on stderr and replaced with
that default rather than taken.

Credentials for the service integrations are separate, one file per
service in `~/.config/wam-shell/` (`github.env`, `todoist.env`,
`protonmail.env`, `google.env`), or the matching environment variables.
Each provider prints setup instructions into the notification center's
empty state when it is enabled but unconfigured, so you can also just
turn one on and read what it asks for.

## The `wam` command

- `wam install` — dependencies (ags + astal libraries, AUR helper on
  Arch, `--source` build otherwise), the Nerd Fonts the shell uses, node
  modules, TypeScript types, and a precompiled stylesheet.
- `wam update` — `git fetch` + fast-forward merge + `pnpm i`, all in
  `~/.local/share/wam-shell`. Restarts the systemd service when active.
- `wam update --force` — for when the above refuses because the tree has
  diverged. Stashes any local changes (they are recoverable, and the
  discarded HEAD is printed so a reset undoes the whole thing),
  hard-resets to the remote, and drops the cached stylesheet so it is
  rebuilt. Cached _state_ — seen markers, sleep timer, calendar and
  YouTube data — is left alone.
- `wam logs [-f]` — the shell's log from wherever this start method put
  it: the journal under autostart, `~/.cache/wam-shell/shell.log` after
  `wam start`. `-f` follows.
- `wam report` — **what to paste when reporting a bug.** One fenced
  block with the versions (wam-shell, ags, compositor, distro, node),
  `wam status`, the options you set in your config, and a bounded slice
  of the log: its first 20 lines (the startup banner a plain tail would
  drop) plus the last 200. Home paths, your username, email addresses,
  IP addresses and token-shaped values are redacted on the way out, so
  it is safe to paste without reading it first. `--lines N` for a bigger
  slice, `--file [PATH]` to write it out instead, `--copy` for the
  clipboard.
- `wam screen-share` — the PipeWire video-input streams the privacy mask
  (`hide_when_screen_sharing`) sees right now, plus what it recently
  masked on, with the exact `[screen_share] ignore_apps` value for each.
- `wam start` / `stop` / `restart` / `force-start` — lifecycle for the
  running shell. `force-start` kills EVERY ags instance first — the fix
  for "some stale instance holds the bus name".
- `wam autostart enable|disable|status` — a systemd user service
  (`wam-shell.service`) that starts the shell at login. Enable is enough
  once; no compositor config edits.
- `wam status` — install location, current commit, runtime and autostart
  state at a glance.
- `wam doctor` — **run this before reporting that a feature does
  nothing.** Checks every runtime dependency the shell can use — the
  typelibs it imports at startup, the daemons the panel reads, who owns
  the notification bus name, the fonts, and the helper binaries behind
  the optional features (cliphist, grim, slurp, wf-recorder) — and for
  each one says what its absence costs you and the command that fixes
  it. Exits non-zero only when something the shell genuinely needs is
  missing, so it is usable from a script.
- `wam version` — the installed shell's commit (hash, branch, date).

## Driving it from the compositor

The shell answers requests on its instance name, so keybinds toggle
things without knowing anything about its internals:

```shell
ags request -i wam-shell launcher        # apps, shell commands, clipboard
ags request -i wam-shell session         # lock/suspend/log out/restart/shut down
ags request -i wam-shell notifications   # toggle the notification center
ags request -i wam-shell qSettings       # toggle quick settings
ags request -i wam-shell "qsPane wifi"   # open straight onto a pane
ags request -i wam-shell "sleep-timer 30"
ags request -i wam-shell keep-awake      # hold off idle and suspend
ags request -i wam-shell "screenshot region"   # or window, or screen
ags request -i wam-shell record          # start/stop a screen recording
ags request -i wam-shell clipboard       # clipboard history (needs cliphist)
ags request -i wam-shell style           # recompile the stylesheet
ags request -i wam-shell help            # every command, with help
```

The launcher is also the shell's **command palette**: `>` in its entry
searches every command in that list — the same descriptions `help`
prints — and passes arguments through, so `>sleep-timer 30` works
without remembering which keybind you gave it. `:` switches it to the
clipboard history.

### Keybinds

None of these are bound for you — the shell does not touch your
compositor config, so nothing it can do has a key until you give it one.
A starting set, which is what the surfaces were designed around:

```conf
# ~/.config/hypr/hyprland.conf
bind = SUPER, D, exec, ags request -i wam-shell launcher
bind = SUPER, Escape, exec, ags request -i wam-shell session
bind = SUPER, N, exec, ags request -i wam-shell notifications
bind = SUPER, S, exec, ags request -i wam-shell qSettings
bind = SUPER SHIFT, V, exec, ags request -i wam-shell clipboard
bind = SUPER SHIFT, C, exec, ags request -i wam-shell keep-awake
bind = SUPER SHIFT, R, exec, ags request -i wam-shell record
bind = , Print, exec, ags request -i wam-shell "screenshot region"
bind = SUPER, Print, exec, ags request -i wam-shell "screenshot window"
bind = SHIFT, Print, exec, ags request -i wam-shell "screenshot screen"
```

```conf
# ~/.config/sway/config
bindsym $mod+d exec ags request -i wam-shell launcher
bindsym $mod+Escape exec ags request -i wam-shell session
bindsym $mod+n exec ags request -i wam-shell notifications
bindsym $mod+s exec ags request -i wam-shell qSettings
bindsym $mod+Shift+v exec ags request -i wam-shell clipboard
bindsym $mod+Shift+c exec ags request -i wam-shell keep-awake
bindsym $mod+Shift+r exec ags request -i wam-shell record
bindsym Print exec ags request -i wam-shell "screenshot region"
bindsym $mod+Print exec ags request -i wam-shell "screenshot window"
bindsym Shift+Print exec ags request -i wam-shell "screenshot screen"
```

Four notes on these:

- **`-i wam-shell` is the instance name**, not a fixed string. If you set
  `instance_name` in the config, every one of these has to match it.
  `ags request` does say so (`error: instance "…" is not runnning`), but
  a keybind's stderr goes to the compositor's log, so from the keyboard
  the bind simply does nothing.
- **A request is a toggle where the surface is one.** Pressing the
  launcher bind while the launcher is up closes it; pressing the
  clipboard bind while it is up in app mode _switches_ it to the
  clipboard rather than dismissing it, so the bind you pressed is the
  one that answers.
- **`record` needs no second bind to stop.** The same request stops a
  running recording — and stopping it is what finalises the file, so
  reach for the key rather than for `pkill`.
- **`clipboard` needs cliphist** and a recorder running:
  `exec-once = wl-paste --watch cliphist store` on Hyprland,
  `exec wl-paste --watch cliphist store` on sway. The shell deliberately
  does not start it for you — silently recording everything you copy is
  not a thing to switch on for someone. `wam doctor` reports whether it
  is running.

## Documentation

|                                                      |                                                  |
| ---------------------------------------------------- | ------------------------------------------------ |
| [wiki](https://github.com/LeadSeason/wam-shell/wiki) | every config option, one page per section        |
| [docs/Architecture.md](docs/Architecture.md)         | how the layers fit together                      |
| [docs/Providers.md](docs/Providers.md)               | the notification-center provider contract        |
| [docs/Styling.md](docs/Styling.md)                   | themes, `user.scss`, the class names to target   |
| [docs/Tray.md](docs/Tray.md)                         | tray behaviour and pinning                       |
| [docs/gcal.md](docs/gcal.md)                         | Google Calendar and the shared OAuth stack       |
| [docs/qSettings.md](docs/qSettings.md)               | quick settings panes                             |
| [AGENTS.md](AGENTS.md)                               | conventions, gates and the reasoning behind them |

Debugging:

```shell
GTK_DEBUG=interactive ags run app.tsx
ags inspect -i wam-shell
WAM_SHELL_METRICS=1 ags run app.tsx     # then: ags request -i wam-shell metrics
```

## Optional: the pending-updates daemon

Shows a pill on the bar when enough updates are available (Arch).

```shell
mkdir -p ~/.config/systemd/user ~/.local/bin
cp extra/pending-updates-daemon.service ~/.config/systemd/user/
cp extra/pending-updates-daemon ~/.local/bin/
systemctl --user daemon-reload
systemctl --user enable --now pending-updates-daemon.service
```

## Development

A bare checkout is not runnable — `.sys/` and `node_modules/` are
gitignored, so run `scripts/wam install` (or `scripts/setup.sh`) first.

```shell
pnpm start            # restart the shell from this checkout
pnpm typecheck        # scoped tsc over src/lib, src/config.ts, tests
pnpm test             # unit suite, bundled and run under gjs
pnpm test:smoke       # boots an isolated instance, asserts a clean start
pnpm test:smoke:sway  # the same inside a nested sway (needs sway installed)
pnpm verify:scss      # compile every theme, through GTK's own CSS parser
pnpm perf             # A/B perf comparison against the merge-base
```

There is deliberately no CI: the gates run locally, once, at the end of
a piece of work. [AGENTS.md](AGENTS.md) explains why, and what each gate
does and does not cover.
