// the `uqr` package: zero-dependency, ships its own types, resolves under
// esbuild's neutral platform (it has an `exports` map — unlike qrcode,
// whose dijkstrajs dep is main-field-only and fails the ags bundle)
import { encode } from "uqr"

// Wi-Fi join QR codes (the `WIFI:` URI every phone scanner understands)
// and the matrix behind them. Payload building is QR-lib free so tests
// can pin the wire format; qrMatrix is the only place the lib is touched.

// WIFI URIs escape `\ ; , : "` with a backslash (zxing's de-facto format,
// which Android's Wi-Fi QR join also speaks)
const ESCAPABLE = /([\\;,:"])/g

export function escapeWifiQr(s: string): string {
    return s.replace(ESCAPABLE, "\\$1")
}

export interface WifiQrOptions {
    ssid: string
    /** NM 802-11-wireless-security.key-mgmt ("wpa-psk", "sae",
     *  "wpa-eap", "wep", "none", or "" when the profile has no security
     *  setting at all) */
    keyMgmt: string
    /** stored PSK; null/"" when none is stored (open, or agent-owned) */
    password?: string | null
    hidden?: boolean
}

/** `WIFI:…;;` payload for scanners, or null when the network can't be
 *  expressed as one — 802.1X/Enterprise has no single-password form, so
 *  like GNOME there is nothing to share. */
export function wifiQrPayload({ ssid, keyMgmt, password, hidden }: WifiQrOptions): string | null {
    let auth: string
    switch (keyMgmt) {
        case "wpa-psk":
        case "sae":
            // WPA3-SAE scans fine as T:WPA on Android
            auth = "T:WPA"
            break
        case "wep":
            auth = "T:WEP"
            break
        case "wpa-eap":
        case "802-1x":
            return null
        default:
            auth = "T:nopass"
    }
    const parts = [auth, `S:${escapeWifiQr(ssid)}`]
    if (auth !== "T:nopass") {
        // a code with a missing password would only fail to join —
        // nothing worth sharing
        if (!password) return null
        parts.push(`P:${escapeWifiQr(password)}`)
    }
    if (hidden) parts.push("H:true")
    return `WIFI:${parts.join(";")};;`
}

export interface QrMatrix {
    size: number
    /** true when the module at (row, col) is dark */
    dark(row: number, col: number): boolean
}

/** module matrix for a payload, ready for a cairo draw func. Level M
 *  error correction: a scannable code even with a smudge on the glass;
 *  phones sit close, so no need for the bigger L/M tradeoff overhead. */
export function qrMatrix(payload: string): QrMatrix {
    const { size, data } = encode(payload, { ecc: "M", border: 0 })
    return {
        size,
        dark: (row, col) => data[row][col],
    }
}
