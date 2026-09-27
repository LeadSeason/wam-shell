// Parsers for `tailscale status --json` output, pinned against the
// real CLI's document shape (tailscale v1.102). Reach the parsers only
// — the backend next door polls at module scope, which made importing
// it from a test start polling the developer's live daemon (same rule
// as tests/vpn.test.ts). All fixture names are placeholders.

import { test, eq } from "./framework"
import {
    parseAccount,
    parseDetails,
    parseErrorText,
    parseExitNodes,
    parsePeers,
    parsePrefs,
    parseStatusJson,
    parseLoggedOut,
    parseHealth,
    parseNetcheck,
    derpCity,
    isAccessDenied,
    parseFeatureCaps,
} from "../src/lib/vpn/tailscale/parse"

// Running, no exit node selected: the server word is the tailnet name.
// Self carries the v6 alongside the v4 — the parsers must pick the v4
const RUNNING = JSON.stringify({
    BackendState: "Running",
    CurrentTailnet: { Name: "mytailnet.ts.net", MagicDNSSuffix: "mytailnet.ts.net" },
    Self: {
        HostName: "my-laptop",
        TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0:ab12:4843:cd96:6255:2d4b"],
        KeyExpiry: "2027-01-01T00:00:00Z",
    },
    Peer: {
        "nodekey:0a": {
            HostName: "exit-node-1",
            TailscaleIPs: ["100.100.100.100"],
            ExitNodeOption: true,
            CurAddr: "203.0.113.10:41641",
        },
        "nodekey:0b": {
            HostName: "workstation",
            TailscaleIPs: ["100.100.100.101"],
            ExitNodeOption: true,
        },
        "nodekey:0c": { HostName: "phone", TailscaleIPs: ["100.100.100.102"] },
    },
})

const EXIT_NODE_ACTIVE = JSON.stringify({
    BackendState: "Running",
    CurrentTailnet: { Name: "mytailnet.ts.net" },
    Self: { HostName: "my-laptop", TailscaleIPs: ["100.101.102.103"] },
    Peer: {
        "nodekey:0a": {
            HostName: "exit-node-1",
            TailscaleIPs: ["100.100.100.100"],
            ExitNodeOption: true,
            ExitNode: true,
            CurAddr: "203.0.113.10:41641",
        },
    },
})

test("tailscale: running maps connected, tailnet as the server word", () => {
    eq(parseStatusJson(RUNNING), {
        state: "connected",
        stateLabel: "Connected",
        server: "mytailnet.ts.net",
    })
})

test("tailscale: running with an exit node names it as the server word", () => {
    eq(parseStatusJson(EXIT_NODE_ACTIVE), {
        state: "connected",
        stateLabel: "Connected",
        server: "exit-node-1",
    })
})

test("tailscale: stopped, starting and logged-out states", () => {
    const doc = (state: string) => JSON.stringify({ BackendState: state })
    eq(parseStatusJson(doc("Stopped")), {
        state: "disconnected",
        stateLabel: "Stopped",
        server: "",
    })
    eq(parseStatusJson(doc("Starting")), {
        state: "connecting",
        stateLabel: "Connecting",
        server: "",
    })
    for (const s of ["NeedsLogin", "NeedsMachineAuth", "NoState"]) {
        eq(parseStatusJson(doc(s)), { state: "disconnected", stateLabel: "Logged out", server: "" })
    }
})

test("tailscale: unknown state and non-JSON claim nothing", () => {
    eq(parseStatusJson(JSON.stringify({ BackendState: "InUseOtherUser" })), null)
    eq(parseStatusJson("not json at all"), null)
    eq(parseStatusJson(JSON.stringify({})), null)
})

test("tailscale: stderr words for daemon-down and logged-out", () => {
    eq(parseErrorText("failed to connect to local tailscaled; is it running?"), {
        state: "disconnected",
        stateLabel: "Stopped",
        server: "",
    })
    eq(parseErrorText("Tailscale is stopped."), {
        state: "disconnected",
        stateLabel: "Stopped",
        server: "",
    })
    eq(parseErrorText("Logged out."), {
        state: "disconnected",
        stateLabel: "Logged out",
        server: "",
    })
    eq(parseErrorText("not logged in"), {
        state: "disconnected",
        stateLabel: "Logged out",
        server: "",
    })
    eq(parseErrorText("permission denied"), null)
})

test("tailscale: logged-out word gates the streamed connect path", () => {
    const doc = (state: string) => JSON.stringify({ BackendState: state })
    // the three states parseStatusJson also labels "Logged out"
    for (const s of ["NeedsLogin", "NeedsMachineAuth", "NoState"]) eq(parseLoggedOut(doc(s)), true)
    eq(parseLoggedOut(doc("Running")), false)
    eq(parseLoggedOut(doc("Stopped")), false)
    eq(parseLoggedOut(doc("Starting")), false)
    eq(parseLoggedOut("not json at all"), false)
})

test("tailscale: daemon health warnings, typed and tolerant", () => {
    eq(parseHealth(JSON.stringify({ BackendState: "Running", Health: [] })), [])
    eq(parseHealth(JSON.stringify({ Health: ["relay 12 unreachable", "cert expired"] })), [
        "relay 12 unreachable",
        "cert expired",
    ])
    // wrong shapes claim nothing rather than throwing
    eq(parseHealth(JSON.stringify({ Health: "broken" })), [])
    eq(parseHealth(JSON.stringify({ Health: [1, "ok"] })), ["ok"])
    eq(parseHealth("not json at all"), [])
})

test("tailscale: netcheck blocking facts", () => {
    const report = ["Report:", "\t* UDP: false", "\t* CaptivePortal: true", ""].join("\n")
    eq(parseNetcheck(report), { udpBlocked: true, captivePortal: true })
    eq(parseNetcheck("\t* UDP: true\n\t* CaptivePortal: false"), {
        udpBlocked: false,
        captivePortal: false,
    })
    // probes failing to report is not a blocking verdict
    eq(parseNetcheck("Report:\n\t* Nearest DERP: unknown"), {
        udpBlocked: false,
        captivePortal: false,
    })
})

test("tailscale: exit-node catalogue, v4 identity, current by ExitNode flag", () => {
    eq(parseExitNodes(RUNNING), {
        list: [
            { id: "100.100.100.100", label: "exit-node-1" },
            { id: "100.100.100.101", label: "workstation" },
        ],
        current: "",
    })
    eq(parseExitNodes(EXIT_NODE_ACTIVE), {
        list: [{ id: "100.100.100.100", label: "exit-node-1" }],
        current: "100.100.100.100",
    })
})

test("tailscale: exit-node parsing rejects non-JSON and empty documents", () => {
    eq(parseExitNodes("Logged out."), null)
    eq(parseExitNodes(JSON.stringify({ BackendState: "Running", Peer: {} })), {
        list: [],
        current: "",
    })
})

test("tailscale: account device name and key expiry", () => {
    eq(parseAccount(RUNNING), {
        deviceName: "my-laptop",
        expiryMs: Date.parse("2027-01-01T00:00:00Z"),
    })
    eq(parseAccount(JSON.stringify({ BackendState: "Running", Self: { HostName: "my-laptop" } })), {
        deviceName: "my-laptop",
        expiryMs: null,
    })
    eq(parseAccount(JSON.stringify({ BackendState: "Running" })), null)
})

test("tailscale: connection details only while running", () => {
    eq(parseDetails(EXIT_NODE_ACTIVE), {
        server: "exit-node-1",
        endpoint: "203.0.113.10:41641",
        protocol: "WireGuard",
        ip: "100.101.102.103",
        location: "mytailnet.ts.net",
    })
    eq(
        parseDetails(
            JSON.stringify({
                BackendState: "Stopped",
                Self: { HostName: "my-laptop", TailscaleIPs: ["100.101.102.103"] },
            }),
        ),
        null,
    )
    eq(parseDetails("garbage"), null)
})

// the device catalogue: online peers first (alpha before mu by name),
// the offline one last with its LastSeen carried as ms. alpha is
// direct (CurAddr), mu is relayed, zeta says neither
const PEERS = JSON.stringify({
    BackendState: "Running",
    Peer: {
        "nodekey:zz": {
            HostName: "zeta",
            Online: false,
            OS: "windows",
            TailscaleIPs: ["100.100.100.120"],
            LastSeen: "2026-09-26T15:00:00.000Z",
        },
        "nodekey:aa": {
            HostName: "alpha",
            DNSName: "alpha.mytailnet.ts.net.",
            Online: true,
            OS: "linux",
            TailscaleIPs: ["100.100.100.110", "fd7a:115c:a1e0:ab12:4843:cd96:6255:2d4b"],
            CurAddr: "203.0.113.10:41641",
            ExitNodeOption: true,
        },
        "nodekey:mm": {
            HostName: "mu",
            Online: true,
            OS: "ios",
            TailscaleIPs: ["100.100.100.115"],
            Relay: "fra",
        },
    },
})

test("tailscale: peers sort online first, then by hostname", () => {
    const peers = parsePeers(PEERS)
    eq(
        peers?.map(p => p.label),
        ["alpha", "mu", "zeta"],
    )
    eq(
        peers?.map(p => p.online),
        [true, true, false],
    )
})

test("tailscale: peer fields — v4 identity, OS, DNS name, route, exit-node flag, last seen", () => {
    const peers = parsePeers(PEERS)
    const [alpha, mu, zeta] = peers ?? []
    eq(alpha, {
        id: "nodekey:aa",
        label: "alpha",
        online: true,
        os: "linux",
        ip: "100.100.100.110",
        // the daemon's trailing dot is stripped
        dnsName: "alpha.mytailnet.ts.net",
        curAddr: "203.0.113.10:41641",
        relay: "",
        lastSeenMs: null,
        exitNodeOption: true,
        isSelf: false,
    })
    // the v6 in TailscaleIPs is skipped; no CurAddr → the DERP region
    // is the route word; no LastSeen key at all
    eq(mu, {
        id: "nodekey:mm",
        label: "mu",
        online: true,
        os: "ios",
        ip: "100.100.100.115",
        dnsName: "",
        curAddr: "",
        relay: "fra",
        lastSeenMs: null,
        exitNodeOption: false,
        isSelf: false,
    })
    eq(zeta?.lastSeenMs, Date.parse("2026-09-26T15:00:00.000Z"))
})

test("tailscale: Self leads the device list, marked as self", () => {
    const peers = parsePeers(
        JSON.stringify({
            BackendState: "Running",
            Self: {
                HostName: "my-laptop",
                DNSName: "my-laptop.mytailnet.ts.net.",
                Online: true,
                OS: "linux",
                TailscaleIPs: ["100.101.102.103"],
                Relay: "hel",
                ExitNodeOption: true,
            },
            Peer: {
                "nodekey:aa": {
                    HostName: "alpha",
                    Online: true,
                    OS: "linux",
                    TailscaleIPs: ["100.100.100.110"],
                },
            },
        }),
    )
    eq(peers?.length, 2)
    eq(peers?.[0], {
        id: "self",
        label: "my-laptop",
        online: true,
        os: "linux",
        ip: "100.101.102.103",
        dnsName: "my-laptop.mytailnet.ts.net",
        curAddr: "",
        relay: "hel",
        lastSeenMs: null,
        exitNodeOption: true,
        isSelf: true,
    })
    eq(peers?.[1]?.isSelf, false)
})

test("tailscale: peer parsing rejects non-JSON, accepts an empty tailnet", () => {
    eq(parsePeers("Logged out."), null)
    eq(parsePeers(JSON.stringify({ BackendState: "Running", Peer: {} })), [])
    // a peer the daemon has not named claims no row
    eq(parsePeers(JSON.stringify({ Peer: { "nodekey:x": { Online: true } } })), [])
})

test("tailscale: prefs parse — the four feature flags, null when absent", () => {
    eq(
        parsePrefs(
            JSON.stringify({
                "shields-up": false,
                "accept-dns": true,
                "accept-routes": false,
                ssh: true,
                "exit-node": "",
            }),
        ),
        { shieldsUp: false, acceptDns: true, acceptRoutes: false, runSSH: true },
    )
    // a key the CLI did not report is "unknown", not false
    eq(parsePrefs(JSON.stringify({ "shields-up": true })), {
        shieldsUp: true,
        acceptDns: null,
        acceptRoutes: null,
        runSSH: null,
    })
    eq(parsePrefs("not json"), null)
})

test("tailscale: DERP region codes resolve to cities, unknown codes pass through", () => {
    eq(derpCity("hel"), "Helsinki")
    eq(derpCity("fra"), "Frankfurt")
    // a self-hosted or newer region keeps the daemon's code — still
    // honest, just not expanded
    eq(derpCity("my-relay-1"), "my-relay-1")
})

test("tailscale: access-denied detection matches the CLI's wording loosely", () => {
    // the real stderr, captured from tailscale 1.102
    eq(isAccessDenied("Access denied: checkprefs access denied"), true)
    eq(isAccessDenied("access denied"), true)
    eq(isAccessDenied("failed to connect to local tailscaled; is it running?"), false)
    eq(isAccessDenied(""), false)
})

test("tailscale: cap/ssh grants the SSH feature; a missing CapMap is unknown", () => {
    // a present key is a grant even with a null payload — the real
    // daemon's shape
    eq(
        parseFeatureCaps(
            JSON.stringify({ Self: { CapMap: { "https://tailscale.com/cap/ssh": null } } }),
        ),
        { ssh: true, sshRuleIn: false },
    )
    // cap/ssh-rule-in is the policy reaching this node as a destination
    eq(
        parseFeatureCaps(
            JSON.stringify({
                Self: {
                    CapMap: {
                        "https://tailscale.com/cap/ssh": null,
                        "https://tailscale.com/cap/ssh-rule-in": null,
                    },
                },
            }),
        ),
        { ssh: true, sshRuleIn: true },
    )
    eq(
        parseFeatureCaps(
            JSON.stringify({ Self: { CapMap: { "https://tailscale.com/cap/is-owner": null } } }),
        ),
        { ssh: false, sshRuleIn: false },
    )
    eq(parseFeatureCaps(JSON.stringify({ Self: {} })), null)
    eq(parseFeatureCaps("not json"), null)
})
