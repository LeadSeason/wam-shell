Debugging:

```
GTK_DEBUG=interactive ags run
ags inspect -i [config name, wam]
```

### Install

```shell
git clone https://github.com/LeadSeason/wam-shell.git
cd wam-shell
scripts/wam install
```

`wam` is the shell's management command (it links itself into
`~/.local/bin` during install):

- `wam install` — dependencies (ags + astal libraries, AUR helper on
  Arch, `--source` build otherwise), the Nerd Fonts the shell uses
  (`ttf-firacode-nerd` + `ttf-nerd-fonts-symbols-mono` on Arch,
  upstream release zips into `~/.local/share/fonts` elsewhere), node
  modules and TypeScript types. Passes extra args to `scripts/setup.sh`
  (e.g. `wam install --source`).
- `wam update` — `git pull --ff-only` + `pnpm i` (restarts the systemd
  service when active).
- `wam start` / `stop` / `restart` / `force-start` — lifecycle for the
  running shell. `force-start` kills EVERY ags instance first — the
  fix for "some stale instance holds the bus name".
- `wam autostart enable|disable|status` — a systemd user service
  (`wam-shell.service`) that starts the shell at login. Enable is
  enough once; no compositor config edits.

Notes:

- The shell talks to sway over IPC using the `i3ipc-1.0` typelib from
  [i3ipc-glib](https://github.com/acrisci/i3ipc-glib) — required even for
  non-sway sessions, since the sway modules are imported at startup.

- Nix users: get ags via `nix shell github:aylur/ags` and point the setup
  at it with `AGS_JS_DIR=/path/to/ags/js pnpm run setup`.
- Runtime features need their daemons: battery needs `upower`, the audio
  slider needs `wireplumber`, power profiles need `power-profiles-daemon`.
- Upstream ags install docs: https://aylur.github.io/ags/guide/install.html

## Archlinux update checker script Install
will show in bar if enough available updates.
```shell
mkdir ~/.config/systemd/user/ 
mkdir ~/.local/bin
cp pending-updates-daemon.service ~/.config/systemd/user/pending-updates-daemon.service
cp pending-updates-daemon ~/.local/bin/pending-updates-daemon
systemctl --user daemon-reload
systemctl --user enable --now pending-updates-daemon.service
```