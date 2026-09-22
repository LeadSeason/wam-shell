// Parsers for the `obscura` CLI's status output, pinned against real
// output (obscura-cli v1.180). Reach the parsers only — the backend
// next door spawns `obscura status --follow` at module scope, which
// made importing it from a test start a real listener against the
// developer's live service (same rule as tests/vpn.test.ts).

import { test, eq } from "./framework"
import { parseStatusLine } from "../src/lib/vpn/obscura/parse"

// real `--follow` output across a disconnect/connect cycle: the initial
// summary, then each republished state (the service prints the line
// twice across a transition — dedupe is the backend's job, not ours)
const CONNECTED = "VPN is connected to mullvad-se-sto-wg-208 in Stockholm (SE)."
const CONNECTING = "VPN is connecting."
const DISCONNECTED = "VPN is disconnected."
const ACCOUNT = "Account is active and subscribed."

test("obscura: connected line maps location onto server", () => {
    eq(parseStatusLine(CONNECTED), {
        state: "connected",
        stateLabel: "Connected",
        server: "Stockholm (SE)",
    })
})

test("obscura: a connected line without a location still parses", () => {
    eq(parseStatusLine("VPN is connected to mullvad-se-sto-wg-208."), {
        state: "connected",
        stateLabel: "Connected",
        server: "mullvad-se-sto-wg-208",
    })
})

test("obscura: connecting and disconnecting lines", () => {
    eq(parseStatusLine(CONNECTING), { state: "connecting", stateLabel: "Connecting", server: "" })
    eq(parseStatusLine("VPN is disconnecting."), {
        state: "disconnecting",
        stateLabel: "Disconnecting",
        server: "",
    })
})

test("obscura: disconnected line", () => {
    eq(parseStatusLine(DISCONNECTED), {
        state: "disconnected",
        stateLabel: "Disconnected",
        server: "",
    })
})

test("obscura: account line claims no surface", () => {
    eq(parseStatusLine(ACCOUNT), null)
})

test("obscura: logged-out summary maps to a labelled down state", () => {
    eq(parseStatusLine("Not logged in."), {
        state: "disconnected",
        stateLabel: "Not logged in",
        server: "",
    })
})

test("obscura: a two-line summary reduces to the VPN line", () => {
    const parsed = `${ACCOUNT}\n${CONNECTED}\n`
        .split("\n")
        .map(l => parseStatusLine(l))
        .filter(s => s !== null)
    eq(parsed, [{ state: "connected", stateLabel: "Connected", server: "Stockholm (SE)" }])
})

test("obscura: surrounding whitespace and unknown lines", () => {
    eq(parseStatusLine(`  ${DISCONNECTED}  `), {
        state: "disconnected",
        stateLabel: "Disconnected",
        server: "",
    })
    eq(parseStatusLine("The Obscura VPN service is not running."), null)
    eq(parseStatusLine(""), null)
})
