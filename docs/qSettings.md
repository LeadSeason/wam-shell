# Quick Settings

The quick settings popup (`window.QSettings`) is the shell's main control
surface. Toggle it with the panel button or:

```
ags request -i wam-shell qSettings
```

It closes on ESC, on click-away, and on the panel button (it's a toggle).

## Layout (main pane)

- **Header**: avatar (see below), battery ring (charge-cap aware), uptime
  and load, lock/reboot/power buttons.
- **Sliders**: speaker volume, microphone, screen brightness (outdoor mode
  allows >100% on supported setups). The speaker dropdown also lists
  applications with playback streams: per-app volume and a mute toggle,
  so a muted app never needs pwvucontrol.
- **Toggle section** (`quicksettings` FlowBox): Wi-Fi, Bluetooth, Wired,
  Power Mode, Sway Gaps (sway only), Night Light, Dark Style, VPN,
  Airplane Mode, Sleep Timer. Toggles with a chevron either
  navigate to a pane (Wi-Fi, Bluetooth, Wired, Power Mode) or expand an
  inline dropdown (Sway Gaps, Sleep Timer).
- **VPN** is one pill and one pane per detected backend
  (`src/lib/vpn/`), so a machine with two VPNs installed gets two.
  Each backend declares which surfaces it has — server picker, feature
  toggles, account expiry, connection details — and the pane renders
  only those, rather than cutting every backend down to what they all
  share. `qsPane vpn:<backend>` opens one directly; a bare `qsPane vpn`
  opens the first detected.
- **Stats section** (optional, `quicksettings.show_stats`): cpu/ram/gpu/
  network graphs; the same stats can go on the panel
  (`quicksettings.stats_on_panel`).
- **Media section**: the active MPRIS player as a big-cover card:
  seek with undo, shuffle/repeat, and multi-player switching
  (segments, scroll, arrow keys).
- **Tray**: when `tray.on_panel` is off, the non-pinned tray items live
  here as a pill row.

## Config

See the commented keys in `config.toml`: `[quicksettings]` (stats, avatar,
charge cap), `[bluetooth]` (notifications), `[sleep_timer]`
(presets, panel countdown, dim, alarm).

## Avatar

Avatar should be located in
/var/lib/AccountsService/icons/<user>

https://wiki.archlinux.org/title/KDE#Faces

```
busctl call \
    org.freedesktop.Accounts \
    /org/freedesktop/Accounts/User$uid \
    org.freedesktop.Accounts.User \
    SetIconFile \
    s /path/to/image.png
```

`quicksettings.avatar` overrides with an absolute path (square, ~96px;
`scripts/prepare-avatar.sh` resizes). Empty = the login avatar above,
falling back to the OS icon.
