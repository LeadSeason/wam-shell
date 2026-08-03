import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { createState } from "gnim"
import Config from "../config"
import { isFile } from "./utils"
import { timeoutAddSeconds, sourceRemove } from "./metrics"
import { Provider, ProviderItem, registerProvider } from "./notificationProviders"
import { addProviderPopup } from "./notifd"

// ProtonMail provider for the notification center, via ProtonMail
// Bridge's local IMAP (default 127.0.0.1:1143): unread INBOX mail
// merges into the center's list with sender and subject. Click opens
// webmail, dismiss marks the mail seen on the bridge. Read-only plus
// UID STORE; nothing here deletes or sends.
//
// Each poll is a short connection (loopback, cheap): LOGIN → UID
// SEARCH UNSEEN → UID FETCH ENVELOPE for the newest few → LOGOUT.

const WEBMAIL = "https://mail.proton.me/u/0/inbox"
const MAX_ITEMS = 20

// ---------------------------------------------------------- credentials

const configHome = `${GLib.getenv("XDG_CONFIG_HOME") || `${GLib.getenv("HOME")}/.config`}/wam-shell`
const envPath = `${configHome}/protonmail.env`

function loadCredentials(): { user: string; password: string } | null {
    const envUser = GLib.getenv("PROTONMAIL_IMAP_USER")
    const envPass = GLib.getenv("PROTONMAIL_IMAP_PASSWORD")
    if (envUser && envPass) return { user: envUser, password: envPass }

    if (!isFile(envPath)) return null

    // documented chmod 600 is advice; warn when group/other can read it
    try {
        const info = Gio.File.new_for_path(envPath).query_info(
            "unix::mode",
            Gio.FileQueryInfoFlags.NONE,
            null,
        )
        const mode = info.get_attribute_uint32("unix::mode") & 0o777
        if (mode & 0o077) {
            console.warn(
                `ProtonMail: ${envPath} is readable by group/other (mode ${mode.toString(8)}); consider chmod 600`,
            )
        }
    } catch (e) {
        console.warn("ProtonMail: could not stat credentials file:", e)
    }

    let user = ""
    let password = ""
    try {
        const contents = GLib.file_get_contents(envPath)[1]
        const text = new TextDecoder().decode(contents)
        for (const line of text.split("\n")) {
            const u = line.match(/^\s*(?:export\s+)?PROTONMAIL_IMAP_USER\s*=\s*(.+?)\s*$/)
            if (u) user = u[1].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "")
            const p = line.match(/^\s*(?:export\s+)?PROTONMAIL_IMAP_PASSWORD\s*=\s*(.+?)\s*$/)
            if (p) password = p[1].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "")
        }
    } catch (e) {
        console.warn("ProtonMail: failed reading credentials file:", e)
    }
    return user && password ? { user, password } : null
}

const creds = Config.protonmail.enabled ? loadCredentials() : null
// the center gates on the registry; this gates the registry
export const active = Config.protonmail.enabled && creds !== null
if (Config.protonmail.enabled && !creds) {
    console.log(
        "ProtonMail: enabled but no credentials (env PROTONMAIL_IMAP_USER/PASSWORD or ~/.config/wam-shell/protonmail.env); provider disabled",
    )
}

// ------------------------------------------------- pure parsing (tests)

// RFC 2047 encoded words: =?UTF-8?B?...?= (base64) and =?UTF-8?Q?...?=
// (quoted-printable, _ = space). Raw on any decode failure
export function decodeWords(s: string): string {
    return s.replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g, (whole, enc, text) => {
        try {
            let bytes: Uint8Array
            if (enc.toUpperCase() === "B") {
                // GLib.base64_decode is lenient (decodes what it can,
                // never throws): reject non-base64 input explicitly
                if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return whole
                bytes = GLib.base64_decode(text)
            } else {
                const out: number[] = []
                for (let i = 0; i < text.length; i++) {
                    const c = text[i]
                    if (c === "_") out.push(32)
                    else if (c === "=") {
                        out.push(parseInt(text.slice(i + 1, i + 3), 16))
                        i += 2
                    } else out.push(c.charCodeAt(0))
                }
                bytes = new Uint8Array(out)
            }
            return new TextDecoder("utf-8").decode(bytes)
        } catch {
            return whole
        }
    })
}

// * SEARCH 3 12 47 → [3, 12, 47] (UID SEARCH answers in the same shape)
export function parseSearchIds(text: string): number[] {
    const m = text.match(/^\*\s+SEARCH\b(.*)$/im)
    if (!m) return []
    return m[1]
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter(n => !Number.isNaN(n))
}

type ImapValue = string | null | ImapValue[]

// one IMAP datum starting at s[i]: quoted string, literal {n} (already
// flattened into the text by the transport), NIL, atom, or (list)
function readValue(s: string, i: number): [ImapValue, number] {
    while (s[i] === " ") i++
    if (s[i] === "(") return readList(s, i)
    if (s[i] === '"') {
        let out = ""
        i++
        while (i < s.length && s[i] !== '"') {
            if (s[i] === "\\") i++
            out += s[i] ?? ""
            i++
        }
        return [out, i + 1]
    }
    if (s.slice(i, i + 3).toUpperCase() === "NIL") return [null, i + 3]
    const m = /^[^\s()"]+/.exec(s.slice(i))
    return [m ? m[0] : null, m ? i + m[0].length : i]
}

function readList(s: string, i: number): [ImapValue[], number] {
    const out: ImapValue[] = []
    i++ // "("
    for (;;) {
        while (s[i] === " ") i++
        if (i >= s.length || s[i] === ")") return [out, i + 1]
        const [v, next] = readValue(s, i)
        out.push(v)
        i = next
    }
}

export interface Envelope {
    uid: number
    dateMs: number
    subject: string
    from: string
}

// ENVELOPE = (date subject from sender reply-to to cc bcc in-reply-to
// message-id); an address = (name adl mailbox host). Display name, else
// mailbox@host
function addrDisplay(list: ImapValue): string {
    const first = Array.isArray(list) ? list[0] : null
    if (!Array.isArray(first)) return ""
    const [name, , mailbox, host] = first
    if (typeof name === "string" && name) return decodeWords(name)
    if (typeof mailbox === "string" && typeof host === "string") return `${mailbox}@${host}`
    return ""
}

// every "* <seq> FETCH (... ENVELOPE (...) ... UID <uid>)" block in the
// reply. The UID pair may sit anywhere in the top-level list: the
// bridge appends it after the envelope ("... UID 42"), RFC samples
// show it before — key off the keyword, not the position
export function parseFetchEnvelopes(text: string): Envelope[] {
    const out: Envelope[] = []
    let i = 0
    while ((i = text.indexOf(" FETCH (", i)) !== -1) {
        const [fields, next] = readList(text, i + " FETCH ".length)
        i = next
        if (!Array.isArray(fields)) continue
        const envIdx = fields.findIndex(f => f === "ENVELOPE")
        if (envIdx === -1) continue
        const env = fields[envIdx + 1]
        if (!Array.isArray(env)) continue
        const uidIdx = fields.findIndex(f => f === "UID")
        const uid = uidIdx >= 0 ? Number(fields[uidIdx + 1]) : Number.NaN
        if (Number.isNaN(uid)) continue
        const dateMs = typeof env[0] === "string" ? Date.parse(env[0]) : Number.NaN
        const subject = typeof env[1] === "string" ? decodeWords(env[1]) : ""
        out.push({
            uid,
            dateMs: Number.isNaN(dateMs) ? Date.now() : dateMs,
            subject: subject || "(no subject)",
            from: addrDisplay(env[2]),
        })
    }
    return out
}

// the data half of a ProviderItem; actions are attached by the module
export function envelopeData(env: Envelope): Omit<ProviderItem, "dismiss" | "activate"> {
    return {
        id: `protonmail:${env.uid}`,
        provider: "protonmail",
        time: env.dateMs / 1000,
        appName: "ProtonMail",
        summary: env.subject,
        body: env.from,
        iconName: "protonmail-symbolic",
        url: WEBMAIL,
    }
}

// ids in next but not in prev
export function newArrivals(prev: { id: string }[], next: { id: string }[]): string[] {
    const prevIds = new Set(prev.map(i => i.id))
    return next.filter(i => !prevIds.has(i.id)).map(i => i.id)
}

// ---------------------------------------------------------------- imap

function socketConnect(host: string, port: number): Promise<Gio.SocketConnection> {
    return new Promise((resolve, reject) => {
        const client = new Gio.SocketClient({ timeout: 10 })
        client.connect_to_host_async(host, port, null, (_c, res) => {
            try {
                resolve(client.connect_to_host_finish(res))
            } catch (e) {
                reject(e)
            }
        })
    })
}

// a hung bridge (accepts the TCP connection, never answers) must not
// wedge the provider: without a read timeout the fetch promise never
// settles and pollInFlight stays true forever. One cancellable per
// session, cancelled by a watchdog.
const IO_TIMEOUT_SEC = 30

function ioWatchdog() {
    const cancellable = new Gio.Cancellable()
    const src = timeoutAddSeconds("protonmail:io", GLib.PRIORITY_DEFAULT, IO_TIMEOUT_SEC, () => {
        cancellable.cancel()
        return GLib.SOURCE_REMOVE
    })
    return { cancellable, done: () => sourceRemove(src) }
}

function readLineRaw(input: Gio.DataInputStream, cancellable: Gio.Cancellable): Promise<string> {
    return new Promise((resolve, reject) => {
        input.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (_s, res) => {
            try {
                const [bytes] = input.read_line_finish(res)
                if (!bytes) {
                    reject(new Error("connection closed"))
                    return
                }
                resolve(new TextDecoder().decode(bytes))
            } catch (e) {
                reject(e)
            }
        })
    })
}

function readBytes(
    input: Gio.DataInputStream,
    n: number,
    cancellable: Gio.Cancellable,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: string[] = []
        let left = n
        const step = () => {
            input.read_bytes_async(left, GLib.PRIORITY_DEFAULT, cancellable, (_s, res) => {
                try {
                    const bytes = input.read_bytes_finish(res)
                    const size = bytes?.get_size() ?? 0
                    if (!bytes || size === 0) {
                        reject(new Error("connection closed mid-literal"))
                        return
                    }
                    chunks.push(new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()))
                    left -= size
                    if (left > 0) step()
                    else resolve(chunks.join(""))
                } catch (e) {
                    reject(e)
                }
            })
        }
        step()
    })
}

// responses for one command: lines until the tagged reply, flattening
// {n} literals inline so the parser sees one continuous text.
// tag "" = server greeting: a single line
async function readChunk(
    input: Gio.DataInputStream,
    tag: string,
    cancellable: Gio.Cancellable,
): Promise<string> {
    let buf = ""
    for (;;) {
        const line = await readLineRaw(input, cancellable)
        buf += line + "\r\n"
        if (tag === "") return buf
        if (line.startsWith(tag + " ")) return buf
        const m = line.match(/\{(\d+)\}$/)
        if (m) buf += await readBytes(input, Number(m[1]), cancellable)
    }
}

function writeAll(
    output: Gio.OutputStream,
    text: string,
    cancellable: Gio.Cancellable,
): Promise<void> {
    return new Promise((resolve, reject) => {
        output.write_all_async(
            new TextEncoder().encode(text),
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (_s, res) => {
                try {
                    output.write_all_finish(res)
                    resolve()
                } catch (e) {
                    reject(e)
                }
            },
        )
    })
}

async function cmd(
    input: Gio.DataInputStream,
    conn: Gio.SocketConnection,
    tag: string,
    text: string,
    cancellable: Gio.Cancellable,
): Promise<string> {
    await writeAll(conn.get_output_stream(), `${tag} ${text}\r\n`, cancellable)
    return readChunk(input, tag, cancellable)
}

// IMAP strings are quoted with \ escapes
const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

// one full poll on a fresh connection; throws on any failure
async function fetchUnread(): Promise<Envelope[]> {
    const conn = await socketConnect(Config.protonmail.host, Config.protonmail.port)
    const wd = ioWatchdog()
    try {
        const input = Gio.DataInputStream.new(conn.get_input_stream())
        await readChunk(input, "", wd.cancellable) // server greeting
        const login = await cmd(
            input,
            conn,
            "a1",
            `LOGIN "${quote(creds!.user)}" "${quote(creds!.password)}"`,
            wd.cancellable,
        )
        if (!/^a1 OK/im.test(login)) throw Object.assign(new Error("auth"), { auth: true })
        // SEARCH needs a selected mailbox: EXAMINE (read-only select)
        await cmd(input, conn, "a2", "EXAMINE INBOX", wd.cancellable)
        const search = await cmd(input, conn, "a3", "UID SEARCH UNSEEN", wd.cancellable)
        const ids = parseSearchIds(search).slice(-MAX_ITEMS)
        let envs: Envelope[] = []
        if (ids.length > 0) {
            const fetch = await cmd(
                input,
                conn,
                "a4",
                `UID FETCH ${ids.join(",")} (ENVELOPE)`,
                wd.cancellable,
            )
            envs = parseFetchEnvelopes(fetch)
        }
        await cmd(input, conn, "a5", "LOGOUT", wd.cancellable).catch(() => {})
        return envs
    } finally {
        wd.done()
        conn.close(null)
    }
}

// mark one mail seen; best-effort, errors are the caller's log
async function storeSeen(uid: number) {
    const conn = await socketConnect(Config.protonmail.host, Config.protonmail.port)
    const wd = ioWatchdog()
    try {
        const input = Gio.DataInputStream.new(conn.get_input_stream())
        await readChunk(input, "", wd.cancellable)
        await cmd(
            input,
            conn,
            "a1",
            `LOGIN "${quote(creds!.user)}" "${quote(creds!.password)}"`,
            wd.cancellable,
        )
        // read-write select: STORE changes flags
        await cmd(input, conn, "a2", "SELECT INBOX", wd.cancellable)
        const r = await cmd(input, conn, "a3", `UID STORE ${uid} +FLAGS (\\Seen)`, wd.cancellable)
        await cmd(input, conn, "a4", "LOGOUT", wd.cancellable).catch(() => {})
        return /^a3 OK/im.test(r)
    } finally {
        wd.done()
        conn.close(null)
    }
}

// ---------------------------------------------------------------- state

const [items, setItems] = createState<ProviderItem[]>([])
export { items }

let pollInFlight = false
let lastPollAttempt = 0
let authFailed = false
let pollTimer = 0
// stays false until the first successful fetch lands: that fetch is the
// baseline and never banners
let baselineDone = false

// locally hidden mails (right-click "dismiss"): session-only, no
// service call — filtered out of every poll so they don't reappear
// before the shell restarts
const hiddenIds = new Set<string>()

function attachActions(data: Omit<ProviderItem, "dismiss" | "activate" | "hide">): ProviderItem {
    // opening the mail (click) means it's read, same as "mark done":
    // flag it seen on the bridge and drop it from the list. Removal
    // waits for the STORE to land — a failed flag would re-add it as
    // UNSEEN on the next poll
    const markRead = () => {
        const uid = Number(data.id.slice("protonmail:".length))
        storeSeen(uid)
            .then(ok => {
                if (ok) setItems(items.get().filter(i => i.id !== data.id))
                else console.warn("ProtonMail: mark-seen failed")
            })
            .catch(e => console.warn("ProtonMail: mark-seen failed:", e))
    }
    return {
        ...data,
        hide: () => {
            hiddenIds.add(data.id)
            setItems(items.get().filter(i => i.id !== data.id))
        },
        dismiss: markRead,
        activate: () => {
            Gio.AppInfo.launch_default_for_uri_async(data.url, null, null, (_s, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res)
                } catch (e) {
                    console.warn("ProtonMail: could not open webmail:", e)
                }
            })
            markRead()
        },
    }
}

function applyEnvelopes(envs: Envelope[]) {
    const mapped: ProviderItem[] = []
    for (const env of envs) {
        const data = envelopeData(env)
        if (!hiddenIds.has(data.id)) mapped.push(attachActions(data))
    }
    // newest first, same as the center's desktop list
    mapped.sort((a, b) => b.time - a.time)
    const prev = items.get()
    setItems(mapped)
    if (!baselineDone) {
        // the first fetch after startup is the baseline: bannering the
        // whole unread backlog would spam the screen
        baselineDone = true
        return
    }
    if (!popupsEnabled()) return
    for (const id of newArrivals(prev, mapped)) {
        const item = mapped.find(i => i.id === id)
        if (item) addProviderPopup(item)
    }
}

// whether protonmail items may raise transient banners: the unified
// opt-in list in [notifications]
const popupsEnabled = () => Config.notifications.popupProviders.includes("protonmail")

// surfaced in the center's empty state while unhealthy
const [status, setStatus] = createState<string | null>(null)

export function poll() {
    if (!active || authFailed || pollInFlight) return
    pollInFlight = true
    lastPollAttempt = Date.now()
    fetchUnread()
        .then(envs => {
            setStatus(null)
            applyEnvelopes(envs)
        })
        .catch(e => {
            if (e?.auth) {
                authFailed = true
                setStatus("ProtonMail login rejected — check ~/.config/wam-shell/protonmail.env")
                if (pollTimer) {
                    sourceRemove(pollTimer)
                    pollTimer = 0
                }
                console.warn(
                    "ProtonMail: login rejected; provider disabled until the shell restarts",
                )
            } else {
                // bridge not running, network down, …
                setStatus("Couldn't sync ProtonMail — is the bridge running?")
                console.warn("ProtonMail: poll failed:", e)
            }
        })
        .finally(() => {
            pollInFlight = false
        })
}

// stale-while-revalidate when the center opens; age-gated so fidgety
// toggling doesn't hammer the bridge
export function refresh() {
    if (Date.now() - lastPollAttempt < 60_000) return
    poll()
}

export function dispose() {
    if (pollTimer) {
        sourceRemove(pollTimer)
        pollTimer = 0
    }
}

// -------------------------------------------------------------- startup

// registry presence must not depend on network: the provider registers
// at import (the center reads it whenever its lazy window is built),
// network only starts in init() from app.tsx
if (Config.protonmail.enabled) {
    registerProvider({
        name: "protonmail",
        iconName: "protonmail-symbolic",
        displayName: "ProtonMail",
        items,
        refresh,
        dispose,
        status,
        setupHint: active
            ? null
            : "Set up ProtonMail: install Proton Mail Bridge and sign in, then put its IMAP credentials in ~/.config/wam-shell/protonmail.env as PROTONMAIL_IMAP_USER=<user> and PROTONMAIL_IMAP_PASSWORD=<password>",
    } satisfies Provider)
}

export function init() {
    if (!active) return
    poll()
    pollTimer = timeoutAddSeconds(
        "protonmail:poll",
        GLib.PRIORITY_DEFAULT,
        Config.protonmail.pollMinutes * 60,
        () => {
            poll()
            return GLib.SOURCE_CONTINUE
        },
    )
}
