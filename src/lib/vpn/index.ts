// The VPN surface's public address. Importing this imports every
// backend module, which is what makes them register — the widgets ask
// the registry, never a backend directly.
//
// Import order here is the pill order in the toggle section, and the
// order `firstActiveId()` resolves a bare `qsPane vpn` against: vendor
// backends before the generic NetworkManager one, so a Mullvad or
// Proton user lands on the pane that knows the most about their tunnel.
import "./mullvad"
import "./protonvpn"
import "./networkmanager"

export * from "./registry"
export * from "./types"
