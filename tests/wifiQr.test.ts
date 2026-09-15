import { test, eq } from "./framework"
import { escapeWifiQr, qrMatrix, wifiQrPayload } from "../src/lib/wifiQr"
import { parseSecretsFields } from "../src/lib/wifiSecrets"

// the WIFI: wire format every phone scanner speaks (zxing's de-facto
// grammar, which Android's Wi-Fi join also parses). These cases pin the
// escaping and the key-mgmt mapping — the two places a typo would pass
// silently until someone's phone refuses to join.

test("qr: escape escapes every special char", () => {
    eq(escapeWifiQr(String.raw`a;b,c:d"e\f`), String.raw`a\;b\,c\:d\"e\\f`, "escape")
})

test("qr: wpa-psk builds the standard payload", () => {
    eq(
        wifiQrPayload({ ssid: "MyWiFi", keyMgmt: "wpa-psk", password: "hunter2" }),
        "WIFI:T:WPA;S:MyWiFi;P:hunter2;;",
        "wpa-psk",
    )
})

test("qr: sae shares as WPA (phones scan WPA3 fine)", () => {
    eq(
        wifiQrPayload({ ssid: "MyWiFi", keyMgmt: "sae", password: "hunter2" }),
        "WIFI:T:WPA;S:MyWiFi;P:hunter2;;",
        "sae",
    )
})

test("qr: wep shares as WEP", () => {
    eq(
        wifiQrPayload({ ssid: "MyWiFi", keyMgmt: "wep", password: "deadbeef01" }),
        "WIFI:T:WEP;S:MyWiFi;P:deadbeef01;;",
        "wep",
    )
})

test("qr: open network shares without a password field", () => {
    eq(wifiQrPayload({ ssid: "Cafe", keyMgmt: "none" }), "WIFI:T:nopass;S:Cafe;;", "none")
    // a profile with no security setting at all reads the same way
    eq(wifiQrPayload({ ssid: "Cafe", keyMgmt: "" }), "WIFI:T:nopass;S:Cafe;;", "empty keyMgmt")
})

test("qr: enterprise has nothing to share", () => {
    eq(wifiQrPayload({ ssid: "Corp", keyMgmt: "wpa-eap", password: "x" }), null, "wpa-eap")
    eq(wifiQrPayload({ ssid: "Corp", keyMgmt: "802-1x", password: "x" }), null, "802-1x")
})

test("qr: secured profile without a stored PSK shares nothing", () => {
    eq(wifiQrPayload({ ssid: "MyWiFi", keyMgmt: "wpa-psk", password: null }), null, "no psk")
    eq(wifiQrPayload({ ssid: "MyWiFi", keyMgmt: "wpa-psk", password: "" }), null, "empty psk")
})

test("qr: hidden profiles carry H:true", () => {
    eq(
        wifiQrPayload({ ssid: "Hidden", keyMgmt: "wpa-psk", password: "hunter2", hidden: true }),
        "WIFI:T:WPA;S:Hidden;P:hunter2;H:true;;",
        "hidden",
    )
})

test("qr: ssid and password special chars are escaped in the payload", () => {
    eq(
        wifiQrPayload({ ssid: 'Guest;Room "A"', keyMgmt: "wpa-psk", password: "pa:ss,wo\\rd" }),
        'WIFI:T:WPA;S:Guest\\;Room \\"A\\";P:pa\\:ss\\,wo\\\\rd;;',
        "escaped payload",
    )
})

test("qr: matrix is deterministic and the finder corners are dark", () => {
    const a = qrMatrix("WIFI:T:WPA;S:MyWiFi;P:hunter2;;")
    const b = qrMatrix("WIFI:T:WPA;S:MyWiFi;P:hunter2;;")
    eq(a.size, b.size, "same size for same payload")
    eq(a.size >= 21, true, "version 1 floor")
    // a finder pattern occupies each corner: its outer ring is dark, and
    // the ring just inside the border is light
    for (const m of [a, b]) {
        eq(m.dark(0, 0), true, "top-left")
        eq(m.dark(0, m.size - 1), true, "top-right")
        eq(m.dark(m.size - 1, 0), true, "bottom-left")
        eq(m.dark(1, 1), false, "finder inner ring light")
    }
    // determinism across calls — the draw func repaints from this
    let same = true
    for (let r = 0; r < a.size; r++)
        for (let c = 0; c < a.size; c++) if (a.dark(r, c) !== b.dark(r, c)) same = false
    eq(same, true, "identical modules")
})

test("secrets: parses a stored wpa-psk profile", () => {
    eq(
        parseSecretsFields(
            "802-11-wireless-security.key-mgmt:wpa-psk\n" +
                "802-11-wireless-security.psk:hunter2\n" +
                "802-11-wireless.hidden:no\n",
        ),
        { keyMgmt: "wpa-psk", psk: "hunter2", hidden: false },
        "wpa-psk",
    )
})

test("secrets: open profile has no key-mgmt and no psk", () => {
    eq(
        parseSecretsFields("802-11-wireless-security.key-mgmt:\n802-11-wireless.hidden:no\n"),
        { keyMgmt: "", psk: null, hidden: false },
        "open",
    )
})

test("secrets: unset psk variants read as null", () => {
    eq(
        parseSecretsFields(
            "802-11-wireless-security.key-mgmt:wpa-psk\n802-11-wireless-security.psk:--\n",
        ),
        { keyMgmt: "wpa-psk", psk: null, hidden: false },
        "-- psk",
    )
    eq(
        parseSecretsFields(
            "802-11-wireless-security.key-mgmt:wpa-psk\n802-11-wireless-security.psk:\n",
        ),
        { keyMgmt: "wpa-psk", psk: null, hidden: false },
        "empty psk",
    )
})

test("secrets: hidden yes/no maps to a boolean", () => {
    const parsed = parseSecretsFields("802-11-wireless.hidden:yes\n")
    eq(parsed.hidden, true, "hidden yes")
    eq(parseSecretsFields("").hidden, false, "missing field")
})
