import { test, eq } from "./framework"
import {
    parseStatusVerbose,
    parseRelayList,
    parseAccountInfo,
    parseTunnelOptions,
    parseDnsBlocking,
    parseLan,
    parseLockdown,
    parseAutoConnect,
} from "../src/lib/vpn"

const STATUS_V = `Connected
    Relay:                  se-sto-wg-205 (170.62.100.10:11965/UDP)
    Features:               DAITA, Dns Content Blocker, LAN Sharing, Quantum Resistance
    Tunnel interface:       wg0-mullvad
    Visible location:       Sweden, Stockholm. IPv4: 170.62.100.18
`

test("vpn parseStatusVerbose: relay, endpoint, protocol, location, ip, features", () => {
    const v = parseStatusVerbose(STATUS_V)!
    eq(v.relay, "se-sto-wg-205")
    eq(v.endpoint, "170.62.100.10:11965/UDP")
    eq(v.protocol, "WireGuard")
    eq(v.location, "Sweden, Stockholm")
    eq(v.ip, "170.62.100.18")
    eq(v.features, ["DAITA", "Dns Content Blocker", "LAN Sharing", "Quantum Resistance"])
})

test("vpn parseStatusVerbose: disconnected output yields null", () => {
    eq(parseStatusVerbose("Disconnected"), null)
})

const RELAY_LIST = `Albania (al)
\tTirana (tia) @ 41.32795°N, 19.81902°W
\t\tal-tia-wg-001 (103.124.165.2) - hosted by iRegister (rented)
\t\tal-tia-wg-003 (103.124.165.130) - hosted by iRegister (rented)
Sweden (se)
\tGothenburg (got) @ 57.7°N, 11.9°E
\t\tse-got-wg-001 (1.2.3.4) - hosted by x
\tStockholm (sto) @ 59.3°N, 18.0°E
\t\tse-sto-wg-205 (5.6.7.8) - hosted by y
`

test("vpn parseRelayList: countries nest cities, relay lines skipped", () => {
    const locs = parseRelayList(RELAY_LIST)
    eq(locs, [
        { country: "Albania", countryCode: "al", city: "Tirana", cityCode: "tia" },
        { country: "Sweden", countryCode: "se", city: "Gothenburg", cityCode: "got" },
        { country: "Sweden", countryCode: "se", city: "Stockholm", cityCode: "sto" },
    ])
})

test("vpn parseAccountInfo: expiry and device name", () => {
    const info = parseAccountInfo(
        "Mullvad account:    8776923543705567\nExpires at:         2027-03-18 09:15:40 +01:00\nDevice name:        Stable Mole\n",
    )
    eq(info.expiryMs, Date.parse("2027-03-18T09:15:40+01:00"))
    eq(info.deviceName, "Stable Mole")
    eq(parseAccountInfo("no account here"), { expiryMs: null, deviceName: "" })
})

const TUNNEL_GET = `WireGuard options
    MTU:                    unset
    Quantum resistance:     on
    DAITA:                  true
    Public key:             R4KkgtFbCSypTkKv5Ejh+ug+Cki1Cz9NpAbCZ4NM7RE=
`

test("vpn parseTunnelOptions: quantum and daita states", () => {
    eq(parseTunnelOptions(TUNNEL_GET), { quantum: true, daita: true })
    eq(
        parseTunnelOptions(TUNNEL_GET.replace("on\n", "off\n").replace("true", "false")),
        { quantum: false, daita: false },
    )
})

const DNS_GET = `Custom DNS: no
Block ads: true
Block trackers: true
Block malware: true
Block adult content: true
`

test("vpn parseDnsBlocking: any block flag means on", () => {
    eq(parseDnsBlocking(DNS_GET), true)
    eq(parseDnsBlocking(DNS_GET.replaceAll("true", "false")), false)
    eq(parseDnsBlocking("Custom DNS: no"), null)
})

test("vpn parseLan: allow/block", () => {
    eq(parseLan("Local network sharing setting: allow"), true)
    eq(parseLan("Local network sharing setting: block"), false)
    eq(parseLan("nothing"), null)
})

test("vpn parseLockdown: on/off", () => {
    eq(parseLockdown("Block traffic when the VPN is disconnected: on"), true)
    eq(parseLockdown("Block traffic when the VPN is disconnected: off"), false)
    eq(parseLockdown("nothing"), null)
})

test("vpn parseAutoConnect: on/off", () => {
    eq(parseAutoConnect("Autoconnect: on"), true)
    eq(parseAutoConnect("Autoconnect: off"), false)
    eq(parseAutoConnect("nothing"), null)
})
