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
  countdown, and a quick-settings button.
- **Quick settings** — audio and brightness sliders with per-device
  panes, Wi-Fi, wired, Bluetooth (including pairing), VPN, power
  profiles, night light, sway gaps, a media player card and the tray.
- **A notification center and banners.** By default the shell *is* the
  notification daemon; it steps aside if another one is already running.
  Banners honour the sender's own `expire_timeout`, fold per app, and
  never bury a critical.
- **Service integrations** that merge into the same notification center:
  GitHub notifications, Todoist due tasks, ProtonMail unread mail (via
  Bridge's local IMAP), YouTube subscription uploads, and Google
  Calendar. Each is one lib module behind a shared provider interface —
  see [docs/Providers.md](docs/Providers.md).
- **A sleep timer** that pauses playback, dims the screen, and survives
  a shell restart or crash.
- **An OSD** for volume, microphone, brightness, keyboard layout and
  lock keys, with per-kind durations.
- **Theming** from scss: six themes ship, `theme` picks one, and
  `scss/user.scss` is yours and never overwritten.

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
  rebuilt. Cached *state* — seen markers, sleep timer, calendar and
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
- `wam start` / `stop` / `restart` / `force-start` — lifecycle for the
  running shell. `force-start` kills EVERY ags instance first — the fix
  for "some stale instance holds the bus name".
- `wam autostart enable|disable|status` — a systemd user service
  (`wam-shell.service`) that starts the shell at login. Enable is enough
  once; no compositor config edits.
- `wam status` — install location, current commit, runtime and autostart
  state at a glance.
- `wam version` — the installed shell's commit (hash, branch, date).

## Driving it from the compositor

The shell answers requests on its instance name, so keybinds toggle
things without knowing anything about its internals:

```shell
ags request -i wam-shell notifications   # toggle the notification center
ags request -i wam-shell qSettings       # toggle quick settings
ags request -i wam-shell "qsPane wifi"   # open straight onto a pane
ags request -i wam-shell "sleep-timer 30"
ags request -i wam-shell style           # recompile the stylesheet
ags request -i wam-shell help            # every command, with help
```

## Documentation

| | |
|---|---|
| [docs/Architecture.md](docs/Architecture.md) | how the layers fit together |
| [docs/Providers.md](docs/Providers.md) | the notification-center provider contract |
| [docs/Styling.md](docs/Styling.md) | themes, `user.scss`, the class names to target |
| [docs/Tray.md](docs/Tray.md) | tray behaviour and pinning |
| [docs/gcal.md](docs/gcal.md) | Google Calendar and the shared OAuth stack |
| [docs/qSettings.md](docs/qSettings.md) | quick settings panes |
| [AGENTS.md](AGENTS.md) | conventions, gates and the reasoning behind them |

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
pnpm perf             # A/B perf comparison against the merge-base
```

There is deliberately no CI: the gates run locally, once, at the end of
a piece of work. [AGENTS.md](AGENTS.md) explains why, and what each gate
does and does not cover.
