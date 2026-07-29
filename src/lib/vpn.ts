import GLib from "gi://GLib?version=2.0"
import { exec, execAsync } from "ags/process"
import { createState } from "ags"

// Shared Mullvad VPN state, polled (the mullvad CLI is not reactive).
// Used by the bar indicator and the quick settings toggle.

export interface VpnStatus {
    connected: boolean
    relay: string
}

const [status, setStatus] = createState<VpnStatus>({ connected: false, relay: "" })

// skip ticks while a previous refresh is still pending: a wedged
// mullvad daemon would otherwise accumulate one blocked process per tick
let refreshing = false
export async function refreshVpn() {
    if (refreshing) return
    refreshing = true
    try {
        const out = await execAsync(["mullvad", "status"])
        const connected = out.trimStart().startsWith("Connected")
        const relay = out.match(/Relay:\s*(\S+)/)?.[1] ?? ""
        setStatus({ connected, relay })
    } catch {
        // daemon down, leave state as is
    } finally {
        refreshing = false
    }
}

// probe once: no point polling every 5s when mullvad isn't installed
export const hasMullvad = (() => {
    try { exec("which mullvad"); return true } catch { return false }
})()

if (hasMullvad) {
    refreshVpn()
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
        refreshVpn()
        return GLib.SOURCE_CONTINUE
    })
}

export default status
