import { test, eq } from "./framework"
import {
    decodeWords,
    parseSearchIds,
    parseFetchEnvelopes,
    envelopeData,
    newArrivals,
    idleEventKind,
    isBridgeDown,
} from "../src/lib/protonmail"

test("protonmail decodeWords: base64 and quoted-printable", () => {
    // "=?UTF-8?B?...?=" for "Hallå" (Hallå in base64)
    eq(decodeWords("=?UTF-8?B?SGFsbMOl?="), "Hallå")
    // Q-encoding: _ is space, =XX hex
    eq(decodeWords("=?UTF-8?Q?p=C3=A5minnelse_om_m=C3=B6te?="), "påminnelse om möte")
    // plain text passes through; broken input stays raw
    eq(decodeWords("plain subject"), "plain subject")
    eq(decodeWords("=?UTF-8?B?!!!?="), "=?UTF-8?B?!!!?=")
})

test("protonmail parseSearchIds: uid list or empty", () => {
    eq(parseSearchIds("* SEARCH 3 12 47\r\na2 OK Search completed\r\n"), [3, 12, 47])
    eq(parseSearchIds("* SEARCH\r\na2 OK Search completed\r\n"), [])
    eq(parseSearchIds("a2 BAD nope\r\n"), [])
})

// real bridge wire format: the UID pair comes AFTER the envelope
const FETCH_REPLY =
    '* 1 FETCH (ENVELOPE ("Mon, 3 Aug 2026 10:15:00 +0200" "Invoice #123" (("Acme AB" NIL "billing" "acme.se" NIL)) (("Acme AB" NIL "billing" "acme.se" NIL)) ((NIL NIL "billing" "acme.se" NIL)) ((NIL NIL "me" "pm.me" NIL)) NIL NIL NIL "<id1@acme.se>") UID 42)\r\n' +
    // RFC-style: UID before the envelope — both orders must parse
    '* 2 FETCH (UID 43 ENVELOPE ("Tue, 4 Aug 2026 08:00:00 +0200" =?UTF-8?Q?p=C3=A5minnelse?= (("Kalle" NIL "k" "ex.se" NIL)) (("Kalle" NIL "k" "ex.se" NIL)) ((NIL NIL "k" "ex.se" NIL)) ((NIL NIL "me" "pm.me" NIL)) NIL NIL NIL "<id2@ex.se>"))\r\n' +
    "a3 OK Fetch completed\r\n"

test("protonmail parseFetchEnvelopes: multiple mails, encoded subjects", () => {
    const envs = parseFetchEnvelopes(FETCH_REPLY)
    eq(envs.length, 2)
    eq(envs[0].uid, 42)
    eq(envs[0].subject, "Invoice #123")
    eq(envs[0].from, "Acme AB")
    eq(envs[0].dateMs, Date.parse("Mon, 3 Aug 2026 10:15:00 +0200"))
    eq(envs[1].uid, 43)
    eq(envs[1].subject, "påminnelse")
    eq(envs[1].from, "Kalle")
})

test("protonmail parseFetchEnvelopes: nil name falls back to address, empty subject", () => {
    const reply =
        '* 1 FETCH (UID 7 ENVELOPE ("Mon, 3 Aug 2026 10:15:00 +0200" "" ((NIL NIL "noreply" "x.se" NIL)) ((NIL NIL "noreply" "x.se" NIL)) ((NIL NIL "noreply" "x.se" NIL)) ((NIL NIL "me" "pm.me" NIL)) NIL NIL NIL "<i@x.se>"))\r\n'
    const envs = parseFetchEnvelopes(reply)
    eq(envs.length, 1)
    eq(envs[0].from, "noreply@x.se")
    eq(envs[0].subject, "(no subject)")
})

test("protonmail envelopeData: provider item shape", () => {
    const env = {
        uid: 9,
        dateMs: Date.parse("Mon, 3 Aug 2026 10:15:00 +0200"),
        subject: "Hej",
        from: "Ada",
    }
    eq(envelopeData(env), {
        id: "protonmail:9",
        provider: "protonmail",
        time: env.dateMs / 1000,
        appName: "ProtonMail",
        summary: "Hej",
        body: "Ada",
        iconName: "protonmail-symbolic",
        url: "https://mail.proton.me/u/0/inbox",
    })
})

test("protonmail newArrivals: only brand-new uids", () => {
    eq(newArrivals([{ id: "protonmail:1" }], [{ id: "protonmail:1" }, { id: "protonmail:2" }]), [
        "protonmail:2",
    ])
})

test("protonmail idleEventKind: events, bye, chatter", () => {
    eq(idleEventKind("* 3 EXISTS"), "event")
    eq(idleEventKind("* 1 RECENT"), "event")
    eq(idleEventKind("* 2 EXPUNGE"), "event")
    eq(idleEventKind("* 1 FETCH (FLAGS (\\Seen))"), "event")
    eq(idleEventKind("* BYE Server logging out"), "bye")
    eq(idleEventKind("* OK Still alive"), null)
    eq(idleEventKind("+ idling"), null)
})

test("protonmail isBridgeDown: refused connections only", () => {
    // gio wording, whether it arrives as a GLib.Error or wrapped
    eq(isBridgeDown({ message: "Could not connect to 127.0.0.1: Connection refused" }), true)
    eq(isBridgeDown({ message: "Network is unreachable" }), true)
    // a real fault must stay loud
    eq(isBridgeDown({ message: "IMAP parse error" }), false)
    eq(isBridgeDown({ auth: true }), false)
    eq(isBridgeDown(null), false)
})
