Debugging:

```
GTK_DEBUG=interactive ags run
ags inspect -i [config name, wam]
```

### Dev env install

```shell
git clone https://github.com/LeadSeason/wam-shell.git
cd wam-shell
pnpm run setup
pnpm start
```

`pnpm run setup` installs ags and the required astal libraries, links the
ags js modules into `.sys/`, installs node modules, and generates the
TypeScript types. It picks the install method automatically:

- **Arch with an AUR helper** (paru or yay): installs `aylurs-gtk-shell`,
  `dart-sass`, the `libastal-*-git` packages, and `i3ipc-glib-git`
  (sway IPC) from the AUR and official repos.
- **Everything else**: builds the astal libraries and i3ipc-glib from
  source (build deps installed via pacman/dnf when available). You can
  force this path with `pnpm run setup -- --source`.

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