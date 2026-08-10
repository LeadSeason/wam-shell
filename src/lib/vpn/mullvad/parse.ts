// The `mullvad` CLI's human-readable output, parsed.
//
// Its own module, with no import-time side effects, so the unit suite
// can pin these against real CLI output. The backend next door spawns
// `mullvad status listen` at module scope, which made importing it from
// a test start a real listener against the developer's live daemon for
// the length of the run — AGENTS.md names vpn among the modules tests
// must not pull in. Same split as lib/popupStack: the rules here, the
// machinery that runs them there.
//
// These are all total functions over a string: null means "the CLI did
// not say", which is different from "it said no".

import type { VpnState } from "../types"

/** the five tunnel state words `mullvad status` prints, as a regex
 *  alternation — shared by the one-shot read and the listener */
export const STATE_WORDS = "Connected|Connecting|Disconnecting|Disconnected|Blocked"

/** Mullvad's vocabulary onto the shared enum. An unknown word maps to
 *  "blocked" rather than "disconnected": a state we cannot read is not
 *  one we should report as safely off. */
export function mapState(word: string): VpnState {
    switch (word) {
        case "Connected":
            return "connected"
        case "Connecting":
            return "connecting"
        case "Disconnecting":
            return "disconnecting"
        case "Disconnected":
            return "disconnected"
        default:
            return "blocked"
    }
}

export interface VerboseStatus {
    relay: string
    endpoint: string // "170.62.100.66:8306/UDP" (the "In" line)
    protocol: string // inferred from the relay id ("-wg-" = WireGuard)
    ip: string // exit IP (the "Out" line)
    location: string // "Sweden, Stockholm"
    features: string[] // ["DAITA", "Quantum Resistance", ...]
}

export function parseStatusVerbose(out: string): VerboseStatus | null {
    const relayM = out.match(/^\s*Relay:\s*(\S+) \((\S+)\)/m)
    if (!relayM) return null
    const features =
        out
            .match(/^\s*Features:\s*(.+)$/m)?.[1]
            ?.split(",")
            .map(s => s.trim())
            .filter(Boolean) ?? []
    const loc = out.match(/^\s*Visible location:\s*(.+?)\.\s*IPv4:\s*(\S+)/m)
    if (!loc) return null
    return {
        relay: relayM[1],
        endpoint: relayM[2],
        protocol: relayM[1].includes("-wg-") ? "WireGuard" : "OpenVPN",
        ip: loc[2],
        location: loc[1],
        features,
    }
}

export interface RelayLocation {
    country: string
    countryCode: string
    city: string
    cityCode: string
}

// The two halves of a shared VpnLocation, and the marker the pane
// compares them against. Here rather than in the backend so the unit
// suite can pin them: they are the reason a picker row lights up as the
// current one, and getting either side's spelling wrong just means no
// row ever matches — a silent failure with nothing to see in a log.

/** "se-sto" — a location's identity, and the id half of a VpnLocation */
export const locationId = (l: RelayLocation) => `${l.countryCode}-${l.cityCode}`

/** "Stockholm, Sweden" — what the picker row prints and searches on */
export const locationLabel = (l: RelayLocation) => `${l.city}, ${l.country}`

/** the same identity read back off a connected relay id
 *  ("se-sto-wg-208" -> "se-sto") */
export const relayLocationId = (relay: string) => relay.split("-").slice(0, 2).join("-")

// "Albania (al)" / "\tTirana (tia) @ 41.3°N, 19.8°W" /
// "\t\tal-tia-wg-001 (...) - hosted by ..." — two indent levels:
// country, then city; double-indented relay lines are skipped
export function parseRelayList(out: string): RelayLocation[] {
    const locations: RelayLocation[] = []
    let country = "",
        countryCode = ""
    for (const line of out.split("\n")) {
        if (line.startsWith("\t\t")) continue // individual relays
        if (line.startsWith("\t")) {
            const m = line.match(/^\t(.+?) \((\w+)\) @/)
            if (m && country) {
                locations.push({ country, countryCode, city: m[1], cityCode: m[2] })
            }
        } else {
            const m = line.match(/^(.+?) \((\w+)\)\s*$/)
            if (m) {
                country = m[1]
                countryCode = m[2]
            }
        }
    }
    return locations
}

// "Mullvad account: 877...\nExpires at: 2027-03-18 09:15:40 +01:00\nDevice name: Stable Mole"
export function parseAccountInfo(out: string): { expiryMs: number | null; deviceName: string } {
    const m = out.match(/Expires at:\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2}:\d{2})/)
    const t = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}`) : NaN
    return {
        expiryMs: Number.isNaN(t) ? null : t,
        deviceName: out.match(/^\s*Device name:\s*(.+)$/m)?.[1]?.trim() ?? "",
    }
}

export function parseTunnelOptions(out: string): {
    quantum: boolean | null
    daita: boolean | null
} {
    const q = out.match(/Quantum resistance:\s*(\S+)/)?.[1]
    const d = out.match(/^\s*DAITA:\s*(\S+)/m)?.[1]
    return {
        quantum: q === undefined ? null : q === "on",
        daita: d === undefined ? null : d === "true",
    }
}

// any block flag on = the content blocker toggle is on
export function parseDnsBlocking(out: string): boolean | null {
    const flags = [
        ...out.matchAll(/^Block (?:ads|trackers|malware|adult content): (true|false)$/gm),
    ]
    if (flags.length === 0) return null
    return flags.some(f => f[1] === "true")
}

export function parseLan(out: string): boolean | null {
    const m = out.match(/Local network sharing setting: (allow|block)/)
    return m ? m[1] === "allow" : null
}

export function parseLockdown(out: string): boolean | null {
    const m = out.match(/Block traffic when the VPN is disconnected: (on|off)/)
    return m ? m[1] === "on" : null
}

export function parseAutoConnect(out: string): boolean | null {
    const m = out.match(/Autoconnect: (on|off)/)
    return m ? m[1] === "on" : null
}
