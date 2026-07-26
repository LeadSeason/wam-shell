Debugging:

```
GTK_DEBUG=interactive ags run
ags inspect -i [config name, wam]
```

### Dev env install
Clone
```shell
git clone https://github.com/LeadSeason/wam-shell.git
```
Typescript types
```shell
ags types -d ./wam-shell
```
installing modules.
```shell
cd ./wam-shell
pnpm i
```
`ags` and `gnim` are linked from the system AGS install
(`/usr/local/share/ags/js`) via `link:` dependencies in `package.json`,
so no manual symlinks are needed.

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