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
    - **Tailscale** (poll-based — its CLI has no follow mode): the
      picker lists the tailnet's exit nodes, the details card shows the
      WireGuard endpoint, and a Devices card lists the tailnet's
      machines — this one first, named and badged "this device" (online
      status, OS/IP, direct-or-DERP-relay, exit-node marker, last seen
      when offline) — clicking a device copies its magic-DNS name
      (falling back to the tailscale IP). A logged-out
      node gets a "Login…" action that starts the auth flow and opens
      the URL in the browser. A Features card exposes four set-flags:
      shields-up, accept-dns, accept-routes, and Tailscale SSH — the
      last gated on the tailnet actually offering SSH (cap/ssh in the
      status document; locked switches explain why). (Read
      back via `tailscale get`, applied via `tailscale set`.) The CLI
      exposes no per-peer OS version, so rows show the OS name only.
      `tailscale up/down/set` need root or operator
      rights — run `sudo tailscale up --operator=$USER` once (it grants
      control AND performs the login; the `set --operator` form the CLI
      suggests is broken upstream, tailscale/tailscale#18294), or the
      toggle fails and the pane names the fix in red: a Fix button runs
      it through pkexec/polkit (the session agent draws the password
      dialog, and the auth URL the command prints still opens in the
      browser) when pkexec is installed, and a copy button puts the
      bare command on the clipboard as the manual fallback (older
      builds failed silently; the reason lands in the journal either
      way). A yellow warning line under the status carries health news
      without demanding action: daemon health lines (read every poll)
      and netcheck's blocking facts (read on pane open — outbound UDP
      blocked means everything relays through DERP, a captive portal
      means sign in to the network first). A
      logged-out
      node shows "Logged out" and Login alone: reconnect and location
      picking hide (nothing to reconnect to), the auth URL opens in the
      browser — the shell streams the CLI's output so both the URL and
      an operator-rights denial reach the pane — and the picker,
      Features and Devices stay visible but insensitive under a "Last
      known state" heading. A
      connected Tailscale also gets its own passive indicator on the
      panel (next to the generic VPN one, which only shows the first
      connected backend) — tray-style interaction is left to the
      Tailscale tray app itself.
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
