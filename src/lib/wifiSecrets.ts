import { execAsync } from "./metrics"

// Reading a Wi-Fi profile's stored secrets + the fields needed to share
// it (key-mgmt, hidden). One nmcli call fetches all three; nmcli -s shows
// secrets because they are the user's own, and for system-wide profiles
// polkit prompts through the session's agent like any other secret read.
//
// PRIVACY: nothing on this path may log the profile's secret material or
// the raw error — execAsync failures echo the argv, and the parsed output
// carries the PSK. Catches log a fixed string only.

export interface WifiSecrets {
    /** NM 802-11-wireless-security.key-mgmt; "" when the profile has no
     *  security setting (open network) */
    keyMgmt: string
    /** stored PSK, null when empty/unset (agent-owned secrets never
     *  appear in `connection show`) */
    psk: string | null
    hidden: boolean
}

export function parseSecretsFields(output: string): WifiSecrets {
    let keyMgmt = ""
    let psk: string | null = null
    let hidden = false
    for (const line of output.split("\n")) {
        const sep = line.indexOf(":")
        if (sep < 0) continue
        const value = line.slice(sep + 1)
        switch (line.slice(0, sep)) {
            case "802-11-wireless-security.key-mgmt":
                keyMgmt = value
                break
            case "802-11-wireless-security.psk":
                // nmcli prints "--" for unset in some table modes; -t
                // gives an empty string — treat both as "not stored here"
                psk = value !== "" && value !== "--" ? value : null
                break
            case "802-11-wireless.hidden":
                hidden = value === "yes"
                break
        }
    }
    return { keyMgmt, psk, hidden }
}

export function loadSecrets(profile: string): Promise<WifiSecrets> {
    return execAsync([
        "nmcli",
        "-s",
        "-t",
        "-f",
        "802-11-wireless-security.key-mgmt,802-11-wireless-security.psk,802-11-wireless.hidden",
        "connection",
        "show",
        profile,
    ]).then(parseSecretsFields)
}
