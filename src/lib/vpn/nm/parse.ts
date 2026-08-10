// The `nmcli` CLI's terse output, parsed — shared by every backend whose
// tunnel lives in NetworkManager (the generic NM backend, and Proton,
// whose official stack creates NM connections on connect).
//
// Its own module, with no import-time side effects, so the unit suite
// can pin these against real CLI output. The watcher next door
// (./watch) spawns `nmcli monitor` at module scope, which made
// importing it from a test start a real monitor against the developer's
// NetworkManager for the length of the run — AGENTS.md names vpn among
// the modules tests must not pull in.
//
// All total functions over a string; "the CLI did not say" is an empty
// list, never an exception.

import type { VpnState } from "../types"

/** nmcli's terse mode joins fields with ":" and escapes a literal ":"
 *  as "\:" and "\" as "\\" — a naive split(":") corrupts profile names
 *  like "vpn: work" */
export function splitTerse(line: string): string[] {
    const fields: string[] = []
    let cur = ""
    for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (c === "\\" && i + 1 < line.length) {
            cur += line[i + 1]
            i++
        } else if (c === ":") {
            fields.push(cur)
            cur = ""
        } else {
            cur += c
        }
    }
    fields.push(cur)
    return fields
}

/** the two connection types backends treat as VPNs. "tun" is
 *  deliberately NOT one: a tun device managed outside NM (mullvad's
 *  wg0-mullvad) shows up as an auto-generated tun profile, and listing
 *  those would double-expose a tunnel a vendor backend owns */
export const isVpnType = (t: string) => t === "vpn" || t === "wireguard"

export interface NmConnection {
    name: string
    uuid: string
    type: string
    device: string // "" while inactive (or activation has no device yet)
}

/** `nmcli -t -f NAME,UUID,TYPE,DEVICE connection show` — ALL rows,
 *  unfiltered. Which of them a backend owns (isVpnType, a vendor name
 *  prefix) is that backend's call, not this parser's */
export function parseConnections(out: string): NmConnection[] {
    const connections: NmConnection[] = []
    for (const line of out.split("\n")) {
        if (!line) continue
        const [name, uuid, type, device] = splitTerse(line)
        if (name && uuid) connections.push({ name, uuid, type: type ?? "", device: device ?? "" })
    }
    return connections
}

export interface NmDevice {
    device: string
    state: string // "connected", "connecting (configuring)", …
    connection: string // profile NAME, "" when unassociated
}

/** `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status` */
export function parseDevices(out: string): NmDevice[] {
    const devices: NmDevice[] = []
    for (const line of out.split("\n")) {
        if (!line) continue
        const [device, , state, connection] = splitTerse(line)
        if (device) devices.push({ device, state: state ?? "", connection: connection ?? "" })
    }
    return devices
}

/** NM's device state words onto the shared enum. An unknown word maps
 *  to "blocked" rather than "disconnected": a state we cannot read is
 *  not one we should report as safely off (same rule as mullvad's
 *  mapper, and the reason "failed" lands there too). */
export function mapState(word: string): VpnState {
    if (word === "connected" || word === "connected (externally)") return "connected"
    if (word.startsWith("connecting")) return "connecting"
    if (word === "deactivating") return "disconnecting"
    if (word === "disconnected" || word === "unavailable") return "disconnected"
    return "blocked"
}

export interface NmProfileRef {
    name: string
    uuid: string
}

export interface ResolvedVpn {
    uuid: string
    server: string // profile name, what the pill and pane print
    state: VpnState
}

/** A snapshot folded into one status, over the connections a backend
 *  OWNS (already filtered by the caller). Two ways a tunnel in flux
 *  shows up: an UP connection (its device may be absent from the device
 *  listing for a beat yet), or a device mid-activation that names one
 *  of the owned profiles — the second is what catches an activation
 *  started outside the shell. Devices naming a profile we do not track
 *  (the externally-managed tun case above) are ignored. Returns null
 *  when no owned profile is active or activating.
 *
 *  The device branch matches on the profile NAME, because that is what
 *  `device status` prints; two profiles sharing a name would resolve to
 *  the first — pathological, and noted rather than handled. */
export function resolveStatus(
    profiles: NmProfileRef[],
    active: { uuid: string; device: string }[],
    devices: NmDevice[],
): ResolvedVpn | null {
    const first = active[0]
    if (first) {
        const dev = devices.find(d => d.device === first.device)
        return {
            uuid: first.uuid,
            server: profiles.find(p => p.uuid === first.uuid)?.name ?? "",
            // active but no device visible yet = early activation
            state: dev ? mapState(dev.state) : "connecting",
        }
    }
    for (const d of devices) {
        if (!d.connection) continue
        const profile = profiles.find(p => p.name === d.connection)
        if (!profile) continue
        const state = mapState(d.state)
        if (state === "disconnected" || state === "blocked") continue
        return { uuid: profile.uuid, server: profile.name, state }
    }
    return null
}
