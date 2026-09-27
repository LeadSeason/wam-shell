// `tailscale status --json` output, parsed.
//
// Its own module, with no import-time side effects, so the unit suite can
// pin these against real CLI output (tailscale v1.102). The backend next
// door polls at module scope; importing it from a test would start polling
// the developer's live daemon. Same split as lib/vpn/mullvad/parse.
//
// These are total functions over a string: null means "the CLI did not
// say", which is different from "it said no". The CLI has no follow/
// stream mode, so everything here is fed by the one-shot status read,
// and the error-text parser covers what that read prints on stderr when
// tailscaled is down or the node is logged out (execAsync rejections
// carry the stderr text, so both channels reach the same funnel).

import type { VpnAccount, VpnDetails, VpnStatus } from "../types"

interface JsonPeer {
    HostName?: string
    DNSName?: string
    TailscaleIPs?: string[]
    CurAddr?: string
    Relay?: string
    OS?: string
    Online?: boolean
    LastSeen?: string
    ExitNode?: boolean
    ExitNodeOption?: boolean
}

interface StatusJson {
    BackendState?: string
    CurrentTailnet?: { Name?: string } | null
    Self?: {
        HostName?: string
        DNSName?: string
        TailscaleIPs?: string[]
        KeyExpiry?: string
        CurAddr?: string
        Relay?: string
        OS?: string
        Online?: boolean
        ExitNodeOption?: boolean
        CapMap?: Record<string, unknown>
    }
    Peer?: Record<string, JsonPeer>
    /** daemon health warnings — non-empty when tailscaled itself flags
     *  trouble; the pane's yellow warning line reads these */
    Health?: unknown
}

function parseJson(out: string): StatusJson | null {
    try {
        const d: unknown = JSON.parse(out)
        if (d && typeof d === "object") return d as StatusJson
    } catch {
        // not JSON: callers feed CLI error text to parseErrorText instead
    }
    return null
}

/** the tailscale IPv4 of a node: TailscaleIPs also carries the fd7a::
 *  v6, and the v4 is what `tailscale set --exit-node=` accepts */
function ipv4(ips: string[] | undefined): string {
    return ips?.find(ip => /^[0-9.]+$/.test(ip)) ?? ""
}

// Tailscale's official DERP regions, code → city — mirrors the default
// DERP map (controlplane.tailscale.com/derpmap/default, 28 regions as
// of 2026-09). Self-hosted or newer regions miss the table and fall
// back to the raw code, which is still what the daemon reports
const DERP_CITIES: Record<string, string> = {
    nyc: "New York City",
    sfo: "San Francisco",
    sin: "Singapore",
    fra: "Frankfurt",
    syd: "Sydney",
    blr: "Bengaluru",
    tok: "Tokyo",
    lhr: "London",
    dfw: "Dallas",
    sea: "Seattle",
    sao: "São Paulo",
    ord: "Chicago",
    den: "Denver",
    ams: "Amsterdam",
    jnb: "Johannesburg",
    mia: "Miami",
    lax: "Los Angeles",
    par: "Paris",
    mad: "Madrid",
    hkg: "Hong Kong",
    tor: "Toronto",
    waw: "Warsaw",
    dbi: "Dubai",
    hnl: "Honolulu",
    nai: "Nairobi",
    nue: "Nuremberg",
    iad: "Ashburn",
    hel: "Helsinki",
}

export function derpCity(code: string): string {
    return DERP_CITIES[code] ?? code
}

/** an action's stderr onto the one failure worth naming in the UI:
 *  missing operator rights. The CLI's wording is "Access denied:
 *  checkprefs access denied" — match loosely so a reword does not
 *  silently drop the notice */
export function isAccessDenied(err: string): boolean {
    return /access denied/i.test(err)
}

function activeExitNode(d: StatusJson): JsonPeer | null {
    for (const p of Object.values(d.Peer ?? {})) {
        if (p.ExitNode === true) return p
    }
    return null
}

/** BackendState onto the shared shape. The server word is the active
 *  exit node's hostname when one is set, else the tailnet name — the
 *  closest thing to "which tunnel" Tailscale has, and what the pill
 *  subtitle and indicator tooltip print */
export function parseStatusJson(out: string): VpnStatus | null {
    const d = parseJson(out)
    if (!d || typeof d.BackendState !== "string") return null
    const exit = activeExitNode(d)
    const tailnet = d.CurrentTailnet?.Name ?? ""
    const server = d.BackendState === "Running" ? (exit?.HostName ?? tailnet) : ""
    switch (d.BackendState) {
        case "Running":
            return { state: "connected", stateLabel: "Connected", server }
        case "Starting":
            return { state: "connecting", stateLabel: "Connecting", server: "" }
        case "Stopped":
            return { state: "disconnected", stateLabel: "Stopped", server: "" }
        // NoState is the daemon's pre-login word — practically the same
        // thing the user needs to hear
        case "NeedsLogin":
        case "NeedsMachineAuth":
        case "NoState":
            return { state: "disconnected", stateLabel: "Logged out", server: "" }
        default:
            return null
    }
}

/** stderr text of the status read onto the shared shape: tailscaled
 *  down and logged-out both exit non-zero, and execAsync rejections
 *  carry exactly these words */
export function parseErrorText(line: string): VpnStatus | null {
    const l = line.trim()
    if (/failed to connect to local tailscaled/i.test(l))
        return { state: "disconnected", stateLabel: "Stopped", server: "" }
    if (/tailscale is stopped/i.test(l))
        return { state: "disconnected", stateLabel: "Stopped", server: "" }
    if (/logged out/i.test(l) || /not logged in/i.test(l))
        return { state: "disconnected", stateLabel: "Logged out", server: "" }
    return null
}

/** the status document's logged-out word: BackendState NeedsLogin/
 *  NeedsMachineAuth/NoState all mean the node has no tailnet identity
 *  yet. `tailscale up` then prints an auth URL and BLOCKS on the
 *  browser flow — which is why connect/reconnect must stream it
 *  (execAsync would swallow the URL and never settle), and why an
 *  operator-rights denial reaches the UI through the stream instead */
export function parseLoggedOut(out: string): boolean {
    const d = parseJson(out)
    const s = d?.BackendState
    return s === "NeedsLogin" || s === "NeedsMachineAuth" || s === "NoState"
}

/** daemon health warnings from the status document: non-empty when
 *  tailscaled itself flags trouble (unreachable relays, cert
 *  problems...). Cheap — the same document the poll already reads */
export function parseHealth(out: string): string[] {
    const d = parseJson(out)
    if (!d || !Array.isArray(d.Health)) return []
    return d.Health.filter((w): w is string => typeof w === "string")
}

/** `tailscale netcheck` text onto the two blocking facts worth a pane
 *  warning: outbound UDP blocked (no direct paths — everything relays
 *  through DERP, slow) and a captive portal in front of the network */
export function parseNetcheck(out: string): { udpBlocked: boolean; captivePortal: boolean } {
    const udp = out.match(/^\s*\* UDP: (true|false)/m)
    const captive = out.match(/^\s*\* CaptivePortal: (true|false)/m)
    return {
        udpBlocked: udp?.[1] === "false",
        captivePortal: captive?.[1] === "true",
    }
}

export interface ExitNodeEntry {
    id: string
    label: string
}

/** exit-node catalogue: peers advertising ExitNodeOption, the currently
 *  selected one found by its ExitNode flag. id is the tailscale IPv4 —
 *  stable across renames and the spelling `tailscale set --exit-node=`
 *  accepts. current is "" when traffic exits directly (no exit node) */
export function parseExitNodes(out: string): { list: ExitNodeEntry[]; current: string } | null {
    const d = parseJson(out)
    if (!d) return null
    const peers = Object.values(d.Peer ?? {})
    const list = peers
        .filter(p => p.ExitNodeOption === true)
        .map(p => ({ id: ipv4(p.TailscaleIPs), label: p.HostName ?? "" }))
        .filter(n => n.id !== "" && n.label !== "")
    const current = peers.find(p => p.ExitNode === true)
    return { list, current: current ? ipv4(current.TailscaleIPs) : "" }
}

/** one tailnet peer, raw — Self included (isSelf), listed first.
 *  Display strings (meta, relative ages) are composed by the backend
 *  at refresh time — parse stays pure */
export interface TailscalePeer {
    // the Peer map's key: the node public key, stable across renames
    // (the hostname is not). Self gets the literal "self"
    id: string
    label: string
    online: boolean
    os: string
    ip: string
    // full magic-DNS name, trailing dot stripped — what a click on
    // the row copies (it resolves in a browser on the tailnet)
    dnsName: string
    // non-empty when the connection is direct; otherwise Relay names
    // the DERP region carrying it ("" when the daemon says neither)
    curAddr: string
    relay: string
    lastSeenMs: number | null
    exitNodeOption: boolean
    isSelf: boolean
}

/** every peer in the document plus Self, Self first — the order the
 *  pane's device list shows */
export function parsePeers(out: string): TailscalePeer[] | null {
    const d = parseJson(out)
    if (!d) return null
    const peers = Object.entries(d.Peer ?? {})
        .map(([id, p]): TailscalePeer => {
            const lastSeenMs = p.LastSeen ? Date.parse(p.LastSeen) : NaN
            return {
                id,
                label: p.HostName ?? "",
                online: p.Online === true,
                os: p.OS ?? "",
                ip: ipv4(p.TailscaleIPs),
                dnsName: (p.DNSName ?? "").replace(/\.$/, ""),
                curAddr: p.CurAddr ?? "",
                relay: p.Relay ?? "",
                lastSeenMs: Number.isNaN(lastSeenMs) ? null : lastSeenMs,
                exitNodeOption: p.ExitNodeOption === true,
                isSelf: false,
            }
        })
        .filter(p => p.label !== "")
    peers.sort((a, b) => Number(b.online) - Number(a.online) || a.label.localeCompare(b.label))
    // this machine leads the list — it is the one the pane's actions
    // operate on, so the reader should not have to hunt for it
    const self = d.Self
    if (self?.HostName) {
        peers.unshift({
            id: "self",
            label: self.HostName,
            online: self.Online === true,
            os: self.OS ?? "",
            ip: ipv4(self.TailscaleIPs),
            dnsName: (self.DNSName ?? "").replace(/\.$/, ""),
            curAddr: self.CurAddr ?? "",
            relay: self.Relay ?? "",
            lastSeenMs: null,
            exitNodeOption: self.ExitNodeOption === true,
            isSelf: true,
        })
    }
    return peers
}

/** which of the pane's feature toggles the tailnet actually offers
 *  this node, from Self.CapMap. A present key (even with a null
 *  payload) is a grant — tailcfg's own comments: cap/ssh is "feature
 *  enabled/available", cap/ssh-rule-in is "some SSH rule reach this
 *  node". Absent CapMap is "unknown", not "nothing" */
export function parseFeatureCaps(out: string): { ssh: boolean; sshRuleIn: boolean } | null {
    const d = parseJson(out)
    const caps = d?.Self?.CapMap
    if (!caps || typeof caps !== "object") return null
    return {
        ssh: "https://tailscale.com/cap/ssh" in caps,
        sshRuleIn: "https://tailscale.com/cap/ssh-rule-in" in caps,
    }
}

/** the feature toggles the pane renders, read back from
 *  `tailscale get --json` (which is keyed by the flag names `tailscale
 *  set` accepts — the stable read path, unlike debug prefs). null per
 *  key means the CLI did not report it: the switch renders
 *  insensitive rather than lying */
export interface TailscalePrefs {
    shieldsUp: boolean | null
    acceptDns: boolean | null
    acceptRoutes: boolean | null
    runSSH: boolean | null
}

export function parsePrefs(out: string): TailscalePrefs | null {
    let d: Record<string, unknown>
    try {
        d = JSON.parse(out)
    } catch {
        return null
    }
    if (!d || typeof d !== "object") return null
    const bool = (key: string) => (typeof d[key] === "boolean" ? (d[key] as boolean) : null)
    return {
        shieldsUp: bool("shields-up"),
        acceptDns: bool("accept-dns"),
        acceptRoutes: bool("accept-routes"),
        runSSH: bool("ssh"),
    }
}

/** device name and node-key expiry. KeyExpiry is absent unless key
 *  expiry is enabled on the tailnet, so a missing date is the common
 *  case, not an error */
export function parseAccount(out: string): VpnAccount | null {
    const d = parseJson(out)
    const self = d?.Self
    if (!self?.HostName) return null
    let expiryMs: number | null = null
    if (self.KeyExpiry) {
        const ms = Date.parse(self.KeyExpiry)
        if (!Number.isNaN(ms)) expiryMs = ms
    }
    return { deviceName: self.HostName, expiryMs }
}

/** the connection-details card. Only meaningful while Running — the
 *  pane hides the card when this is null, which keeps "WireGuard" with
 *  empty In/Out lines from showing over a stopped tunnel */
export function parseDetails(out: string): VpnDetails | null {
    const d = parseJson(out)
    if (!d || d.BackendState !== "Running") return null
    const exit = activeExitNode(d)
    return {
        server: exit?.HostName ?? "",
        endpoint: exit?.CurAddr ?? "",
        protocol: "WireGuard",
        ip: ipv4(d.Self?.TailscaleIPs),
        location: d.CurrentTailnet?.Name ?? "",
    }
}
