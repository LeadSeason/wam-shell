import { test, eq } from "./framework"
import {
    isVpnType,
    mapState,
    parseActive,
    parseDevices,
    parseProfiles,
    resolveStatus,
    splitTerse,
    // the backend's parse module, NOT the backend itself: that one spawns
    // `nmcli monitor` at module scope, so importing it here started a real
    // monitor against the developer's NetworkManager on every `pnpm test`
} from "../src/lib/vpn/networkmanager/parse"

// formats captured from nmcli 1.58 (terse mode), names replaced

test("vpn-nm splitTerse: unescaped colons split, escaped ones do not", () => {
    eq(splitTerse("a:b:c"), ["a", "b", "c"])
    eq(splitTerse("vpn\\: work:uuid-1:wireguard"), ["vpn: work", "uuid-1", "wireguard"])
    // a literal backslash is escaped as "\\" — and the ":" inside the
    // name is escaped too, or it would split (that is the point)
    eq(splitTerse("C\\:\\\\vpn:uuid-2:vpn"), ["C:\\vpn", "uuid-2", "vpn"])
    // an empty trailing field survives (active conn with no device yet)
    eq(splitTerse("name:uuid:vpn:"), ["name", "uuid", "vpn", ""])
})

const PROFILES = [
    "MyWiFi:11111111-1111-1111-1111-111111111111:802-11-wireless",
    "lo:22222222-2222-2222-2222-222222222222:loopback",
    "Work VPN:aaaaaaaa-0000-0000-0000-000000000001:vpn",
    "Home WG:bbbbbbbb-0000-0000-0000-000000000002:wireguard",
    // terse escaping: a literal ":" inside a name arrives as "\:"
    "vpn\\: work:cccccccc-0000-0000-0000-000000000003:wireguard",
    "wg0-mullvad:dddddddd-0000-0000-0000-000000000004:tun",
].join("\n")

test("vpn-nm parseProfiles: only vpn and wireguard survive", () => {
    eq(parseProfiles(PROFILES), [
        { name: "Work VPN", uuid: "aaaaaaaa-0000-0000-0000-000000000001" },
        { name: "Home WG", uuid: "bbbbbbbb-0000-0000-0000-000000000002" },
        { name: "vpn: work", uuid: "cccccccc-0000-0000-0000-000000000003" },
    ])
})

test("vpn-nm parseProfiles: tun excluded — that is vendor-owned tunnels", () => {
    // an externally-managed tunnel (mullvad's wg0-mullvad, proton's
    // proton0) shows up as an auto-generated tun profile; listing it
    // would double-expose a tunnel the vendor backend owns
    eq(isVpnType("tun"), false)
    eq(parseProfiles("wg0-mullvad:dddddddd-0000-0000-0000-000000000004:tun"), [])
})

test("vpn-nm parseActive: only up VPNs survive, device kept", () => {
    // the plain listing (no --active): an inactive profile has an EMPTY
    // device field, which is what drops it here
    const out = `MyWiFi:11111111-1111-1111-1111-111111111111:802-11-wireless:wlan0
Home WG:bbbbbbbb-0000-0000-0000-000000000002:wireguard:wg0
Work VPN:aaaaaaaa-0000-0000-0000-000000000001:vpn:
`
    eq(parseActive(out), [{ uuid: "bbbbbbbb-0000-0000-0000-000000000002", device: "wg0" }])
})

const DEVICES = `wlan0:wifi:connected:MyWiFi
wg0:wireguard:connected:Home WG
wg0-mullvad:tun:connected (externally):wg0-mullvad
p2p-dev-wlan0:wifi-p2p:disconnected:
`

test("vpn-nm parseDevices: state words and association kept verbatim", () => {
    eq(parseDevices(DEVICES), [
        { device: "wlan0", state: "connected", connection: "MyWiFi" },
        { device: "wg0", state: "connected", connection: "Home WG" },
        { device: "wg0-mullvad", state: "connected (externally)", connection: "wg0-mullvad" },
        { device: "p2p-dev-wlan0", state: "disconnected", connection: "" },
    ])
})

test("vpn-nm mapState: nm's device words onto the shared enum", () => {
    eq(mapState("connected"), "connected")
    eq(mapState("connected (externally)"), "connected")
    eq(mapState("connecting (prepare)"), "connecting")
    eq(mapState("connecting (configuring)"), "connecting")
    eq(mapState("connecting (getting IP configuration)"), "connecting")
    eq(mapState("deactivating"), "disconnecting")
    eq(mapState("disconnected"), "disconnected")
    eq(mapState("unavailable"), "disconnected")
    // an unreadable state is not a safely-off one (same rule as
    // mullvad's mapper), and "failed" is exactly that state
    eq(mapState("failed"), "blocked")
    eq(mapState("Wat"), "blocked")
})

const profiles = parseProfiles(PROFILES)
const wg = "bbbbbbbb-0000-0000-0000-000000000002"

test("vpn-nm resolveStatus: active conn + connected device", () => {
    const r = resolveStatus(profiles, [{ uuid: wg, device: "wg0" }], parseDevices(DEVICES))!
    eq(r, { uuid: wg, server: "Home WG", state: "connected" })
})

test("vpn-nm resolveStatus: active conn, device still configuring", () => {
    const r = resolveStatus(
        profiles,
        [{ uuid: wg, device: "wg0" }],
        [{ device: "wg0", state: "connecting (configuring)", connection: "Home WG" }],
    )!
    eq(r.state, "connecting")
    eq(r.server, "Home WG")
})

test("vpn-nm resolveStatus: active conn with no device yet = early activation", () => {
    const r = resolveStatus(profiles, [{ uuid: wg, device: "" }], [])!
    eq(r.state, "connecting")
})

test("vpn-nm resolveStatus: nothing active, device mid-activation names a profile", () => {
    // an activation started OUTSIDE the shell appears in --active only
    // late; the device list is what catches it in between
    const r = resolveStatus(
        profiles,
        [],
        [{ device: "tun0", state: "connecting (prepare)", connection: "Work VPN" }],
    )!
    eq(r, { uuid: "aaaaaaaa-0000-0000-0000-000000000001", server: "Work VPN", state: "connecting" })
})

test("vpn-nm resolveStatus: nothing tracked active → null", () => {
    // wifi/loopback/p2p devices and an unassociated disconnected device
    eq(
        resolveStatus(
            profiles,
            [],
            [
                { device: "wlan0", state: "connected", connection: "MyWiFi" },
                { device: "wg0", state: "disconnected", connection: "" },
                { device: "p2p-dev-wlan0", state: "disconnected", connection: "" },
            ],
        ),
        null,
    )
    // and the vendor-owned external tunnel alone is not a status
    eq(
        resolveStatus(
            profiles,
            [],
            [{ device: "wg0-mullvad", state: "connected (externally)", connection: "wg0-mullvad" }],
        ),
        null,
    )
})

test("vpn-nm resolveStatus: deactivating device still counts, failed does not", () => {
    const r = resolveStatus(
        profiles,
        [],
        [{ device: "wg0", state: "deactivating", connection: "Home WG" }],
    )!
    eq(r.state, "disconnecting")
    // a failed device is a corpse, not a status — the up command's own
    // error is what reports the failure
    eq(
        resolveStatus(profiles, [], [{ device: "wg0", state: "failed", connection: "Home WG" }]),
        null,
    )
})
