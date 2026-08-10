// The `protonvpn` CLI's human-readable output, parsed.
//
// Its own module, with no import-time side effects, so the unit suite
// can pin these against the CLI's real formats. The backend next door
// imports the shared NM watch (../nm/watch), which spawns
// `nmcli monitor` at module scope — AGENTS.md names vpn among the
// modules tests must not pull in. Same split as the mullvad backend:
// the rules here, the machinery that runs them there.
//
// Formats pinned against proton-vpn-cli 1.0.1 (installed source, since
// the CLI on the dev machine is not signed in — see the test file).
// All total functions over a string.

/** Proton's official stack manages its tunnel through NetworkManager:
 *  it creates a profile named "ProtonVPN <server>" on connect and
 *  removes it on disconnect (proton/vpn/backend/networkmanager/
 *  core/networkmanager.py). This prefix is also the CLAIM the generic
 *  NM backend filters on, so the tunnel is not double-exposed */
export const PROFILE_PREFIX = "ProtonVPN "

export const isProtonProfile = (name: string) => name.startsWith(PROFILE_PREFIX)

/** "ProtonVPN SE#215" -> "SE#215" — what the pill and pane print */
export const serverFromProfile = (name: string) =>
    isProtonProfile(name) ? name.slice(PROFILE_PREFIX.length) : name

/** a country the picker lists, and the payload `connect --country`
 *  takes back */
export interface ProtonCountry {
    code: string // "SE"
    name: string // "Sweden"
}

/** `protonvpn countries list` — a tabulate "simple" table:
 *
 *      Country          Code
 *      ---------------  -----
 *      Albania          AL
 *
 *  Country names contain spaces, so split on the LAST whitespace run:
 *  the code is always the trailing two capitals. Header, dashes and
 *  the "Server list is outdated, updating..." line all fail the regex
 *  on their own. */
export function parseCountries(out: string): ProtonCountry[] {
    const countries: ProtonCountry[] = []
    for (const line of out.split("\n")) {
        const m = line.match(/^(.+?)\s{2,}([A-Z]{2})\s*$/)
        if (m) countries.push({ name: m[1].trim(), code: m[2] })
    }
    return countries
}

/** the picker's "current" marker, guessed from a connected server name:
 *  "SE#215" -> "SE", "US-FREE#1" -> "US". A guess, not a fact — the
 *  backend only trusts it when the code is in the loaded country list */
export function serverCountryGuess(server: string): string {
    return server.split(/[-#]/)[0]?.toUpperCase() ?? ""
}

/** `protonvpn config list` — again a plain two-column table:
 *
 *      Current configuration
 *      Setting                  Value
 *      -----------------------  ------------
 *      netshield                malware-only
 *
 *  Returns only the settings we recognise, keyed by name; an
 *  unrecognised row (a new setting, the "Use 'protonvpn …'" footer)
 *  is skipped. A missing known setting is "the CLI did not say" — the
 *  caller renders that switch insensitive rather than guessing */
export function parseConfigList(out: string): Record<string, string> {
    const values: Record<string, string> = {}
    for (const line of out.split("\n")) {
        const m = line.match(/^(\S+)\s{2,}(\S+)\s*$/)
        if (m && FEATURE_KEYS.includes(m[1])) values[m[1]] = m[2]
    }
    return values
}

export interface ProtonFeatureDef {
    key: string // the `config set` name, and the widget's list identity
    label: string
    tooltip?: string
    // the value `set(on)` writes. Only "off" reads as off — see below
    onValue: string
}

// The settings surfaced as pane toggles. Two of the eight are
// deliberately absent: custom-dns takes a server address to turn ON
// (a bare toggle cannot honestly enable it), and anonymous-crash-reports
// is a privacy setting, not a tunnel feature.
//
// Two of these are tri-state in the CLI. A boolean switch cannot show
// three values, so anything but "off" reads as on and `set(true)`
// writes the middle value — the tooltip says so, or "permanent"
// kill-switch users would wonder why their switch shows merely "on".
export const FEATURE_DEFS: ProtonFeatureDef[] = [
    {
        key: "kill-switch",
        label: "Kill Switch",
        tooltip: "Blocks internet if the VPN drops. Toggles between off and standard",
        onValue: "standard",
    },
    {
        key: "netshield",
        label: "NetShield",
        tooltip: "Block malware domains. On enables ads and tracker blocking too",
        onValue: "malware-ads-trackers",
    },
    {
        key: "port-forwarding",
        label: "Port Forwarding",
        onValue: "on",
    },
    {
        key: "vpn-accelerator",
        label: "VPN Accelerator",
        onValue: "on",
    },
    {
        key: "moderate-nat",
        label: "Moderate NAT",
        onValue: "on",
    },
    {
        key: "ipv6",
        label: "IPv6",
        onValue: "on",
    },
]

const FEATURE_KEYS = FEATURE_DEFS.map(f => f.key)

/** a config value onto the switch: null = "the CLI did not say" (not
 *  "off"), anything but "off" is on — the tri-state mapping above */
export function featureOn(value: string | undefined): boolean | null {
    if (value === undefined) return null
    return value !== "off"
}
