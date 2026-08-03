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
  allows >100% on supported setups).
- **Toggle section** (`quicksettings` FlowBox): Wi-Fi, Bluetooth, Wired,
  Power Mode, Sway Gaps (sway only), Night Light, Dark Style, VPN
  (Mullvad), Airplane Mode, Sleep Timer, Peripherals (peripheral
  brightness; only when a manageable device exists). Toggles with a
  chevron either navigate to a pane (Wi-Fi, Bluetooth, Wired, Power
  Mode, Peripherals) or expand an inline dropdown (Sway Gaps, Sleep
  Timer). The Peripherals pane has one slider per device; staged
  devices (asusctl) also get one-tap Off/Low/Med/High buttons.
  Backends, all optional and zero-cost when absent: writable
  `/sys/class/leds` backlights, asusctl, ddcutil (external monitors
  over DDC/CI, re-read on pane open) and OpenRGB (RGB gear; the CLI
  can't read brightness, so the level is what was last set, 100%
  until then).
- **Stats section** (optional, `quicksettings.show_stats`): cpu/ram/gpu/
  network graphs; the same stats can go on the panel
  (`quicksettings.stats_on_panel`).
- **Media section**: the active MPRIS player with controls.
- **Tray**: when `tray.on_panel` is off, the non-pinned tray items live
  here as a pill row.

## Config

See the commented keys in `config.toml`: `[quicksettings]` (stats, avatar,
charge cap), `[bluetooth]` (notifications), `[sleep_timer]`
(presets, panel countdown, dim).

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
