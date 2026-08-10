import { test, eq } from "./framework"
import {
    FEATURE_DEFS,
    featureOn,
    isProtonProfile,
    parseConfigList,
    parseCountries,
    serverCountryGuess,
    serverFromProfile,
    // the backend's parse module, NOT the backend itself: that one imports
    // the shared NM watch, which spawns `nmcli monitor` at module scope —
    // importing it here started a real monitor on every `pnpm test`
} from "../src/lib/vpn/protonvpn/parse"

// Formats reconstructed from proton-vpn-cli 1.0.1's installed source
// (the CLI on the dev machine is not signed in, so the real outputs
// were not capturable; the table shapes are tabulate "simple", which
// the CLI's own code builds — see location_discovery.py)

test("vpn-proton profile claim: the prefix is the whole contract", () => {
    eq(isProtonProfile("ProtonVPN SE#215"), true)
    eq(isProtonProfile("ProtonVPN US-FREE#1"), true)
    eq(isProtonProfile("Home WG"), false)
    // close but not Proton's: no trailing space, lowercase
    eq(isProtonProfile("ProtonVPN"), false)
    eq(isProtonProfile("protonvpn SE#215"), false)
})

test("vpn-proton serverFromProfile: strips the claim prefix", () => {
    eq(serverFromProfile("ProtonVPN SE#215"), "SE#215")
    eq(serverFromProfile("ProtonVPN US-FREE#1"), "US-FREE#1")
})

const COUNTRIES = `Server list is outdated, updating... This may take a moment.
Country          Code
---------------  -----
Albania          AL
United States    US
Sweden           SE
`

test("vpn-proton parseCountries: tabulate simple table", () => {
    eq(parseCountries(COUNTRIES), [
        { name: "Albania", code: "AL" },
        { name: "United States", code: "US" },
        { name: "Sweden", code: "SE" },
    ])
    // header, dashes and the updater line all drop out on their own
    eq(parseCountries(""), [])
})

test("vpn-proton serverCountryGuess: prefix before - or #, uppercased", () => {
    eq(serverCountryGuess("SE#215"), "SE")
    eq(serverCountryGuess("US-FREE#1"), "US")
    eq(serverCountryGuess(""), "")
})

const CONFIG_LIST = `
Current configuration
Setting                  Value
-----------------------  ------------
netshield                malware-only
kill-switch              standard
port-forwarding          on
custom-dns               off
vpn-accelerator          on
moderate-nat             off
ipv6                     off
anonymous-crash-reports  on

Use 'protonvpn config set <setting> <value>' to change settings.
Use 'protonvpn config set <setting> --help' for available values.
`

test("vpn-proton parseConfigList: known settings only", () => {
    eq(parseConfigList(CONFIG_LIST), {
        netshield: "malware-only",
        "kill-switch": "standard",
        "port-forwarding": "on",
        "vpn-accelerator": "on",
        "moderate-nat": "off",
        ipv6: "off",
    })
})

test("vpn-proton feature defs: no custom-dns, no crash reports", () => {
    const keys = FEATURE_DEFS.map(f => f.key)
    // custom-dns takes a server address to enable — a bare toggle
    // cannot honestly turn it on; crash reports are not a tunnel
    // feature
    eq(keys.includes("custom-dns"), false)
    eq(keys.includes("anonymous-crash-reports"), false)
    eq(keys, [
        "kill-switch",
        "netshield",
        "port-forwarding",
        "vpn-accelerator",
        "moderate-nat",
        "ipv6",
    ])
})

test("vpn-proton featureOn: only 'off' is off, missing is null", () => {
    eq(featureOn("on"), true)
    eq(featureOn("standard"), true)
    eq(featureOn("malware-only"), true)
    eq(featureOn("off"), false)
    // "the CLI did not say" is not "off": the switch renders
    // insensitive rather than lying about a state it never read
    eq(featureOn(undefined), null)
})
