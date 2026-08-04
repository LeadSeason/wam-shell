import AstalNetwork from "gi://AstalNetwork?version=0.1"
import NM from "gi://NM?version=1.0"
import { createState } from "gnim"
import { connect } from "../../../lib/metrics"

// NM.Client is also how we detect saved networks. ap.get_connections()
// (per-AP) CRASHES on stale/dropped access point objects (nm-access-point
// assertion + segfault) — never call methods on AP objects, read the
// client's connection list instead. Match by SSID, not profile name:
// they differ (NM appends a counter, e.g. "MyWiFi 1" for SSID "MyWiFi")
const nmClient = NM.Client.new(null)

const [savedNetworks, setSavedNetworks] = createState<Map<string, string>>(new Map())
export { savedNetworks }

function ssidOf(c: NM.RemoteConnection): string | null {
    const bytes = c.get_setting_wireless()?.get_ssid()
    if (!bytes) return null
    return new TextDecoder().decode(bytes.get_data() ?? new Uint8Array())
}

function refreshSaved() {
    const map = new Map<string, string>()
    for (const c of nmClient.get_connections()) {
        const ssid = ssidOf(c)
        if (ssid) map.set(ssid, c.get_id())
    }
    setSavedNetworks(map)
}
connect(nmClient, "connection-added", refreshSaved)
connect(nmClient, "connection-removed", refreshSaved)
refreshSaved()

export const known = (ap: AstalNetwork.AccessPoint) => savedNetworks.get().has(ap.ssid)
// nmcli needs the profile name, which may differ from the SSID
export const profileId = (ap: AstalNetwork.AccessPoint) =>
    savedNetworks.get().get(ap.ssid) ?? ap.ssid
