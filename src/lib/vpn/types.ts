import type { Accessor } from "gnim"

// The shape a VPN backend presents to the quick settings pill and pane.
// One module per backend (mullvad, protonvpn, networkmanager), each
// registering itself — the widgets carry no per-backend code, the same
// split as lib/notificationProviders.
//
// No import-time side effects here: backends spawn processes and open
// D-Bus clients at module scope, so tests reach their parsers directly
// and never this file's importers (see AGENTS.md).

/** normalised tunnel state. Every backend maps its own vocabulary onto
 *  this; `stateLabel` carries the wording the user should see. */
export type VpnState =
    | "disconnected"
    | "connecting"
    | "connected"
    | "disconnecting"
    // traffic blocked with no tunnel up — mullvad's lockdown mode, and
    // the shape a failed NM activation leaves behind
    | "blocked"

export interface VpnStatus {
    state: VpnState
    // what the pane's big word and the pill's subtitle print. Mullvad's
    // "Blocked" and a plugin's own error wording both survive here,
    // where `state` alone would flatten them
    stateLabel: string
    // current server/relay/profile name, "" when not connected
    server: string
}

/** connected is the only derived bit every call site wanted, so it is
 *  derived ONCE here rather than in each widget */
export const isConnected = (s: VpnStatus) => s.state === "connected"

/** display wording for a state, for backends with no vendor wording of
 *  their own (mullvad prints the CLI's words; the NM-backed ones have
 *  no words to print). "blocked" reads "Failed" because that is the
 *  only way they reach it: an activation that did not take */
export function stateLabel(s: VpnState): string {
    switch (s) {
        case "connected":
            return "Connected"
        case "connecting":
            return "Connecting"
        case "disconnecting":
            return "Disconnecting"
        case "disconnected":
            return "Disconnected"
        case "blocked":
            return "Failed"
    }
}

export interface VpnLocation {
    // stable identity for "is this the current one" — a relay id prefix
    // for mullvad, a profile uuid for NM
    id: string
    label: string // "Stockholm, Sweden"
    // opaque payload the backend hands back to itself in set()
    select(): void
}

export interface VpnFeature {
    key: string // stable, for the widget's list identity
    label: string
    tooltip?: string
    /** a one-line explanation under the label — what the switch
     *  actually does, visible without a hover. An accessor when the
     *  wording depends on state (e.g. why the feature is locked) */
    description?: string | Accessor<string>
    /** false = the tailnet/plan does not offer this feature to this
     *  node: the switch renders insensitive. Absent = always available */
    available?: Accessor<boolean>
    /** true = the feature works but is ineffective until the user
     *  acts somewhere else (e.g. no policy rule targets this machine):
     *  the label takes the warning color. Ignored when unavailable */
    attention?: Accessor<boolean>
    // null = "the backend did not say", which is not "off": the switch
    // renders insensitive rather than lying about a state it never read
    value: Accessor<boolean | null>
    set(on: boolean): void
}

export interface VpnAccount {
    expiryMs: number | null
    deviceName: string
}

/** the connection-details card: protocol, endpoint, exit ip, location */
export interface VpnDetails {
    server: string
    endpoint: string
    protocol: string
    ip: string
    location: string
}

/** one row of the pane's device list (a backend's peer catalogue —
 * Tailscale's tailnet). `meta` is a composed subline the backend
 * builds ("Linux · 100.100.100.100 · direct", "last seen 3h"); ""
 * when there is nothing to say */
export interface VpnDevice {
    id: string // stable list identity
    label: string
    online: boolean
    /** this row is the machine the shell runs on — the pane renders
     *  it leading the list, named and badged */
    self: boolean
    /** what clicking the row copies — the magic-DNS name (resolves in
     *  a browser on the tailnet), falling back to the tailscale IP.
     *  "" when the daemon reported neither (row renders insensitive) */
    copy: string
    meta: string
}

/** the pane's problem line: what to show and what to copy (see
 *  VpnBackend.notice) */
export interface VpnNotice {
    text: string
    command?: string
    /** a one-click remedy for the problem the line names (e.g. pkexec
     *  for the operator-rights fix). The backend runs it and clears the
     *  notice on success; absent where the platform cannot offer one —
     *  the copy button remains the fallback */
    fix?: { label: string; run(): void }
}

export interface VpnBackend {
    id: string // registry key and pane name suffix ("mullvad")
    name: string // pill label and pane title ("Mullvad")
    iconName: string
    /** icon for the DOWN state when the brand glyph has one (Mullvad's
     *  open shackle); absent backends just dim iconName */
    iconNameDown?: string

    // detected AND not claimed by another backend. An Accessor, not a
    // boolean: NM profiles appear at runtime (Proton creates its own on
    // the first connect), so the pill set has to be able to change
    // without a restart
    active: Accessor<boolean>
    status: Accessor<VpnStatus>

    connect(): void
    // must also abort an in-flight attempt: it is the only way out of
    // "connecting"
    disconnect(): void
    reconnect(): void
    /** a login the shell can start for the user (Tailscale's auth-URL
     *  flow). The pane renders a Login action for disconnected states
     *  when a backend provides one */
    login?(): void

    /** a human-readable problem line for the pane (e.g. an action that
     *  failed for a fixable reason). `command` is the fix to offer as a
     *  clipboard copy — it differs from the sentence the user reads (no
     *  curly quotes, nothing but what a terminal accepts). null = nothing
     *  to say */
    notice?: Accessor<VpnNotice | null>

    /** the daemon has no tailnet identity (Tailscale's logged-out
     *  states): the pane offers Login alone — reconnect and location
     *  picking mean nothing — and leaves the surfaces below the
     *  actions row visible but insensitive, as last known state.
     *  Absent = the concept does not apply (an NM profile) */
    loggedOut?: Accessor<boolean>

    /** informational warnings about the connection's health (daemon
     *  health lines, blocked-UDP facts): the pane shows them in yellow
     *  under the status. Empty/absent = nothing to warn about */
    warnings?: Accessor<string[]>

    // ---- optional surfaces. An absent field means the pane does not
    // render that section at all — this is what keeps a backend with no
    // feature toggles from showing an empty Features card, and what
    // keeps Mullvad's pane whole instead of cut down to an intersection

    /** searchable location picker */
    locations?: {
        list: Accessor<VpnLocation[]>
        /** fetch lazily on pane open; must be idempotent */
        ensure(): void
        /** the currently selected location's id, "" when unknown */
        current: Accessor<string>
    }
    /** peer/device catalogue (a tailnet's machines). The pane renders
     * online rows bright and offline rows dim */
    devices?: Accessor<VpnDevice[]>
    features?: Accessor<VpnFeature[]>
    account?: Accessor<VpnAccount | null>
    details?: Accessor<VpnDetails | null>

    /** called on pane open. Nothing here polls */
    refreshPane?(): void
    /** a command is in flight: the pane's switches go insensitive */
    busy?: Accessor<boolean>

    /** NetworkManager profiles this backend OWNS, by name — the
     *  generic NM backend filters these out of its own list so a vendor
     *  tunnel is not double-exposed (proton's app creates a
     *  "ProtonVPN <server>" profile on every connect). Only the NM
     *  backend reads this; a backend whose tunnels never touch NM does
     *  not implement it */
    claimsProfile?(profileName: string): boolean

    // NB no `dispose`. Teardown goes through lib/lifecycle's registry,
    // which each backend calls from its own module scope
    // (`registerDispose("vpn:mullvad", …)`) and app.tsx runs on
    // shutdown. notificationProviders records why the interface must
    // not carry one: it becomes a function with no caller, free to rot.
}
