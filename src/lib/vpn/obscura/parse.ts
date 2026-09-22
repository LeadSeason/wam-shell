// The `obscura` CLI's human-readable status output, parsed.
//
// Its own module, with no import-time side effects, so the unit suite
// can pin these against real CLI output. The backend next door spawns
// `obscura status --follow` at module scope; importing it from a test
// would start a real listener against the developer's live service.
// Same split as lib/vpn/mullvad/parse.
//
// `obscura status` prints a two-line summary, and `--follow` keeps
// streaming the same lines as the service publishes new states:
//
//     Account is active and subscribed.
//     VPN is connected to mullvad-se-sto-wg-208 in Stockholm (SE).
//
// Only the "VPN is …" line maps onto the shared VpnStatus; the account
// line carries no surface the pane renders (no expiry date, no device
// name — VpnAccount has no honest mapping for it), so it parses to null.
//
// These are total functions over a string: null means "the CLI did not
// say", which is different from "it said no".

import type { VpnStatus } from "../types"

/** one summary/follow line onto the shared shape. The server word for a
 *  connected tunnel is the human location ("Stockholm (SE)"): the exit
 *  identifier ("mullvad-se-sto-wg-208") carries a provider prefix that
 *  reads like a bug on an Obscura pill, and there is no location picker
 *  the id could serve */
export function parseStatusLine(line: string): VpnStatus | null {
    const l = line.trim()
    const connected = l.match(/^VPN is connected to (\S+?)(?: in (.+?) \(([A-Za-z]{2})\))?[\s.]*$/)
    if (connected)
        return {
            state: "connected",
            stateLabel: "Connected",
            server: connected[3] ? `${connected[2]} (${connected[3]})` : connected[1],
        }
    if (/^VPN is connecting\b/.test(l))
        return { state: "connecting", stateLabel: "Connecting", server: "" }
    if (/^VPN is disconnecting\b/.test(l))
        return { state: "disconnecting", stateLabel: "Disconnecting", server: "" }
    if (/^VPN is disconnected\b/.test(l))
        return { state: "disconnected", stateLabel: "Disconnected", server: "" }
    // printed in place of a summary when no account is logged in
    if (/^Not logged in\b/.test(l))
        return { state: "disconnected", stateLabel: "Not logged in", server: "" }
    return null
}
