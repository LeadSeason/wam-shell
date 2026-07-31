Debugging:

```
GTK_DEBUG=interactive ags run
ags inspect -i [config name, wam]
```

### Install

One line, no clone needed:

```shell
curl -fsSL https://raw.githubusercontent.com/LeadSeason/wam-shell/master/scripts/wam | bash -s -- install
```

or from a clone: `scripts/wam install` (extra args go to
`scripts/setup.sh`, e.g. `--source`).

Install clones the repo into `~/.local/share/wam-shell` and installs
the `wam` command itself into `~/.local/bin`. Everything runs from
those two spots, so **the original clone can be deleted** — `wam` is
all you need from then on:

- `wam install` — dependencies (ags + astal libraries, AUR helper on
  Arch, `--source` build otherwise), the Nerd Fonts the shell uses
  (`ttf-firacode-nerd` + `ttf-nerd-fonts-symbols-mono` on Arch,
  upstream release zips into `~/.local/share/fonts` elsewhere), node
  modules and TypeScript types. Passes extra args to `scripts/setup.sh`
  (e.g. `wam install --source`).
- `wam update` — `git fetch` + fast-forward merge (the branch's
  upstream when set, `origin/master` otherwise) + `pnpm i`, all in
  `~/.local/share/wam-shell`. Restarts the systemd service when active.
- `wam start` / `stop` / `restart` / `force-start` — lifecycle for the
  running shell. `force-start` kills EVERY ags instance first — the
  fix for "some stale instance holds the bus name".
- `wam autostart enable|disable|status` — a systemd user service
  (`wam-shell.service`) that starts the shell at login. Enable is
  enough once; no compositor config edits.
- `wam status` — install location, current commit, runtime and
  autostart state at a glance.
- `wam version` — the installed shell's commit (hash, branch, date).

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