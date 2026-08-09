import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { createState } from "gnim"
import Config from "../config"
import { loadCredentials as loadEnvCredentials } from "./credentials"
import { configHome } from "./paths"
import { timeoutAddSeconds, sourceRemove } from "./metrics"
import { Provider, ProviderItem, registerProvider } from "./notificationProviders"
import { addProviderPopup } from "./notifd"
import { createRefreshGate, newArrivals, openUrl } from "./providerCore"
import { registerDispose } from "./lifecycle"

// re-exported so the unit suite can pin it against ProtonMail's own
// shapes; the implementation is shared (lib/providerCore)
export { newArrivals }

// ProtonMail provider for the notification center, via ProtonMail
// Bridge's local IMAP (default 127.0.0.1:1143): unread INBOX mail
// merges into the center's list with sender and subject. Click opens
// webmail, dismiss marks the mail seen on the bridge. Read-only plus
// UID STORE; nothing here deletes or sends.
//
// Updates are push where possible: a persistent connection issues IMAP
// IDLE (RFC 2177) and refreshes on EXISTS/RECENT/EXPUNGE/FETCH events,
// re-issuing IDLE every 25 min (servers time it out at ~30). Any
// failure tears the session down and falls back to the original
// short-connection poll (LOGIN → UID SEARCH UNSEEN → UID FETCH
// ENVELOPE → LOGOUT per poll) for one poll interval, then retries
// IDLE; a server that refuses IDLE polls permanently. Both paths share
// the same login/search/fetch/parse code (ImapSession).
//
// WHY THIS IS HAND-ROLLED, so nobody spends an afternoon finding out:
// there is no IMAP library to use here. imapflow, node-imap and every
// other JS client is built on `node:net`, which GJS does not have and
// esbuild cannot shim into a Gio socket — the whole transport is the
// part that would have to be replaced, which is the part a library is
// for. The parsing helpers below are pure and tested; the transport is
// Gio streams because that is the only option, not because a library
// was overlooked.

const WEBMAIL = "https://mail.proton.me/u/0/inbox"
const MAX_ITEMS = 20

// ---------------------------------------------------------- credentials

const envPath = `${configHome}/protonmail.env`

function loadCredentials(): { user: string; password: string } | null {
    const env = loadEnvCredentials(
        "ProtonMail",
        ["PROTONMAIL_IMAP_USER", "PROTONMAIL_IMAP_PASSWORD"],
        envPath,
    )
    return env ? { user: env.PROTONMAIL_IMAP_USER, password: env.PROTONMAIL_IMAP_PASSWORD } : null
}

const creds = Config.protonmail.enabled ? loadCredentials() : null

// IMAP LOGIN puts the bridge password on the wire in the clear, and
// `host` is a free-form config string. On loopback that is a hop between
// two processes of the same user and is exactly how the bridge is meant
// to be used. Off it, it is a password crossing a network — so a remote
// host without `tls` is refused rather than silently transmitted, which
// is the only version of this the user cannot get wrong by not reading
// the docs.
const transportOk =
    isLoopbackHost(Config.protonmail.host) || Config.protonmail.tls || !Config.protonmail.enabled

// the center gates on the registry; this gates the registry
export const active = Config.protonmail.enabled && creds !== null && transportOk

if (Config.protonmail.enabled && !creds) {
    console.log(
        "ProtonMail: enabled but no credentials (env PROTONMAIL_IMAP_USER/PASSWORD or ~/.config/wam-shell/protonmail.env); provider disabled",
    )
} else if (Config.protonmail.enabled && !transportOk) {
    console.error(
        `ProtonMail: host "${Config.protonmail.host}" is not loopback and [protonmail] tls is false — ` +
            "IMAP LOGIN would send your bridge password in the clear. Provider disabled; " +
            "set tls = true (plus tls_insecure = true for the bridge's self-signed certificate) or use 127.0.0.1",
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
export function envelopeData(env: Envelope): Omit<ProviderItem, "dismiss" | "activate" | "hide"> {
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

// an untagged line seen while idling: "event" = the mailbox changed
// (new mail, expunge, flag change made from another client), "bye" =
// the server is closing the session, null = ignorable chatter ("* OK
// still alive"). Only called on IDLE-round lines, where an untagged
// FETCH is always an unsolicited flag update
export function idleEventKind(line: string): "event" | "bye" | null {
    if (/^\*\s+\d+\s+(EXISTS|RECENT|EXPUNGE|FETCH)\b/i.test(line)) return "event"
    if (/^\*\s+BYE\b/i.test(line)) return "bye"
    return null
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
// session, cancelled by a watchdog (ImapSession.watchdog).
const IO_TIMEOUT_SEC = 30

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
    io: Gio.IOStream,
    tag: string,
    text: string,
    cancellable: Gio.Cancellable,
): Promise<string> {
    await writeAll(io.get_output_stream(), `${tag} ${text}\r\n`, cancellable)
    return readChunk(input, tag, cancellable)
}

/**
 * Is this host reachable only from this machine?
 *
 * Decides whether a cleartext LOGIN is acceptable. Covers the whole
 * 127.0.0.0/8 block, not just 127.0.0.1 — the bridge can be told to
 * listen on any of it — plus IPv6 loopback in both spellings and the
 * "localhost" name. Anything else, including a LAN address that happens
 * to be this machine, counts as remote: the packet leaves the loopback
 * interface and that is what matters here.
 *
 * Exported for the unit tests.
 */
export function isLoopbackHost(host: string): boolean {
    const h = host
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
    if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
    if (!v4) return false
    const octets = v4.slice(1).map(Number)
    if (octets.some(n => n > 255)) return false
    return octets[0] === 127
}

/**
 * Wrap a live connection in TLS after a successful STARTTLS.
 *
 * `tlsInsecure` accepts the certificate whatever it says, because the
 * bridge signs its own — that keeps the password off the wire but does
 * not authenticate the peer, which is why it is a separate opt-in.
 */
function startTls(base: Gio.IOStream, host: string, insecure: boolean): Promise<Gio.IOStream> {
    return new Promise((resolve, reject) => {
        let tls: Gio.TlsClientConnection
        try {
            tls = Gio.TlsClientConnection.new(
                base,
                Gio.NetworkAddress.new(host, 0),
            ) as Gio.TlsClientConnection
        } catch (e) {
            reject(e)
            return
        }
        if (insecure) {
            // returning true from accept-certificate is what overrides the
            // handshake's own verdict; without it a self-signed cert fails
            tls.connect("accept-certificate", () => true)
        }
        tls.handshake_async(GLib.PRIORITY_DEFAULT, null, (_s, res) => {
            try {
                tls.handshake_finish(res)
                resolve(tls as unknown as Gio.IOStream)
            } catch (e) {
                reject(e)
            }
        })
    })
}

// IMAP strings are quoted with \ escapes
const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

function taggedOk(reply: string, tag: string): boolean {
    return new RegExp(`^${tag} OK`, "im").test(reply)
}

// RFC 2177 servers time an IDLE out at ~30 min; re-issue well before
const IDLE_REISSUE_SEC = 25 * 60

// a logged-in IMAP connection. The poll fallback opens one per poll;
// the IDLE session holds one open for push. Every command runs under a
// watchdog that cancels the session cancellable: a hung bridge kills
// the session (ending the IDLE loop, which falls back to polling), it
// never wedges the provider
class ImapSession {
    private input: Gio.DataInputStream
    private tagCounter = 0
    private readonly cancellable = new Gio.Cancellable()
    private closed = false
    // the stream commands run over: the raw socket, or the TLS stream
    // wrapping it after STARTTLS. `conn` stays around because closing the
    // TLS stream alone can leave the socket open
    private io: Gio.IOStream

    private constructor(private conn: Gio.SocketConnection) {
        this.io = conn
        this.input = Gio.DataInputStream.new(conn.get_input_stream())
    }

    // swap the transport for its TLS-wrapped self and re-point the reader
    private async upgrade(host: string, insecure: boolean): Promise<void> {
        this.io = await startTls(this.conn, host, insecure)
        this.input = Gio.DataInputStream.new(this.io.get_input_stream())
    }

    // connect + greeting + (STARTTLS) + LOGIN; auth rejection carries
    // e.auth (the marker poll() and startIdle() key on)
    static async open(): Promise<ImapSession> {
        const { host, port, tls, tlsInsecure } = Config.protonmail
        const conn = await socketConnect(host, port)
        // the SocketClient timeout (10s) also applies to ASYNC reads on
        // the socket (observed: G_IO_ERROR_TIMED_OUT 10s into a quiet
        // IDLE) — drop it; the session's own timers (command watchdogs,
        // the 25-min re-issue, the post-DONE reply watchdog) are the
        // real deadlines
        conn.get_socket()?.set_timeout(0)
        const s = new ImapSession(conn)
        const done = s.watchdog()
        try {
            await readChunk(s.input, "", s.cancellable) // server greeting
            // STARTTLS before anything that carries the password. A
            // refusal is fatal rather than a downgrade: falling back to
            // cleartext because the server said no is the exact thing
            // asking for TLS was meant to prevent
            if (tls) {
                const tag = s.nextTag()
                const reply = await cmd(s.input, s.io, tag, "STARTTLS", s.cancellable)
                if (!taggedOk(reply, tag)) {
                    throw new Error("server refused STARTTLS; refusing to send credentials")
                }
                await s.upgrade(host, tlsInsecure)
            }
            const tag = s.nextTag()
            const login = await cmd(
                s.input,
                s.io,
                tag,
                `LOGIN "${quote(creds!.user)}" "${quote(creds!.password)}"`,
                s.cancellable,
            )
            if (!taggedOk(login, tag)) throw Object.assign(new Error("auth"), { auth: true })
            return s
        } catch (e) {
            s.close()
            throw e
        } finally {
            done()
        }
    }

    private nextTag() {
        return `a${++this.tagCounter}`
    }

    // the source destroys itself when it fires: the disarm must not
    // remove it again (GLib-CRITICAL "Source ID was not found")
    private watchdog() {
        let fired = false
        const src = timeoutAddSeconds(
            "protonmail:io",
            GLib.PRIORITY_DEFAULT,
            IO_TIMEOUT_SEC,
            () => {
                fired = true
                this.cancellable.cancel()
                return GLib.SOURCE_REMOVE
            },
        )
        return () => !fired && sourceRemove(src)
    }

    // one tagged command with an OK check; throws on NO/BAD — a failed
    // command must never parse as "zero unread" (which would blank the
    // list and re-banner everything as new on the next healthy sync)
    private async command(text: string): Promise<string> {
        const tag = this.nextTag()
        const done = this.watchdog()
        try {
            const reply = await cmd(this.input, this.io, tag, text, this.cancellable)
            if (!taggedOk(reply, tag)) throw new Error(`IMAP command failed: ${text}`)
            return reply
        } finally {
            done()
        }
    }

    // SEARCH needs a selected mailbox: EXAMINE (read-only select)
    async examineInbox(): Promise<void> {
        await this.command("EXAMINE INBOX")
    }

    // read-WRITE select; STORE changes flags, which EXAMINE forbids
    async selectInbox(): Promise<void> {
        await this.command("SELECT INBOX")
    }

    // mark one mail seen. command() throws on NO/BAD, so a refused
    // STORE cannot be mistaken for a successful one
    async markSeen(uid: number): Promise<void> {
        await this.command(`UID STORE ${uid} +FLAGS (\\Seen)`)
    }

    // UID SEARCH UNSEEN + UID FETCH ENVELOPE for the newest few; shared
    // by the one-shot poll and the IDLE session
    async fetchUnread(): Promise<Envelope[]> {
        const search = await this.command("UID SEARCH UNSEEN")
        const ids = parseSearchIds(search).slice(-MAX_ITEMS)
        if (ids.length === 0) return []
        return parseFetchEnvelopes(await this.command(`UID FETCH ${ids.join(",")} (ENVELOPE)`))
    }

    // one IDLE round: enter IDLE, wait for a mail event or the re-issue
    // timer, DONE, await the tagged reply. Resolves "refresh" when an
    // event was seen (the caller re-fetches), "reissue" on a plain
    // timer cycle. Throws on BYE/close/NO/BAD/timeout — the caller
    // tears the session down. A tagged refusal of the IDLE command
    // itself carries e.unsupported (server without IDLE: poll forever)
    async idleRound(): Promise<"refresh" | "reissue"> {
        const tag = this.nextTag()
        const out = this.io.get_output_stream()

        return new Promise((resolve, reject) => {
            let settled = false
            let continuation = false
            let doneSent = false
            let sawEvent = false

            // every GLib source below is "gone" once it fired or was
            // disarmed; cleanup must never remove one twice
            let contGone = false
            let reissueGone = false
            let replyGone = false
            let replyTimer = 0

            const cleanup = () => {
                if (!contGone) sourceRemove(contTimer)
                if (!reissueGone) sourceRemove(reissueTimer)
                if (replyTimer && !replyGone) sourceRemove(replyTimer)
            }
            const settle = (fn: () => void) => {
                if (settled) return
                settled = true
                cleanup()
                fn()
            }

            const endIdle = () => {
                if (doneSent || settled) return
                doneSent = true
                writeAll(out, "DONE\r\n", this.cancellable)
                    .then(() => {
                        if (settled) return
                        // the tagged reply must come quickly now
                        replyTimer = timeoutAddSeconds(
                            "protonmail:io",
                            GLib.PRIORITY_DEFAULT,
                            IO_TIMEOUT_SEC,
                            () => {
                                replyGone = true
                                this.cancellable.cancel()
                                return GLib.SOURCE_REMOVE
                            },
                        )
                    })
                    .catch(e => settle(() => reject(e)))
            }

            // no answer to the IDLE command at all: dead session
            const contTimer = timeoutAddSeconds(
                "protonmail:io",
                GLib.PRIORITY_DEFAULT,
                IO_TIMEOUT_SEC,
                () => {
                    contGone = true
                    this.cancellable.cancel()
                    return GLib.SOURCE_REMOVE
                },
            )
            const reissueTimer = timeoutAddSeconds(
                "protonmail:idle",
                GLib.PRIORITY_DEFAULT,
                IDLE_REISSUE_SEC,
                () => {
                    reissueGone = true
                    endIdle()
                    return GLib.SOURCE_REMOVE
                },
            )

            const onLine = (line: string) => {
                if (settled) return
                if (line.startsWith(tag + " ")) {
                    if (!continuation) {
                        // tagged reply instead of "+ idling": IDLE refused
                        settle(() =>
                            reject(Object.assign(new Error("IDLE refused"), { unsupported: true })),
                        )
                        return
                    }
                    const ok = /^OK/i.test(line.slice(tag.length + 1))
                    settle(() =>
                        ok ? resolve(sawEvent ? "refresh" : "reissue") : reject(new Error(line)),
                    )
                    return
                }
                if (line.startsWith("+")) {
                    continuation = true
                    if (!contGone) {
                        sourceRemove(contTimer)
                        contGone = true
                    }
                    // an event queued between rounds refreshes at once
                    if (sawEvent) endIdle()
                } else {
                    const kind = idleEventKind(line)
                    if (kind === "bye") {
                        settle(() => reject(new Error("server closed the session (BYE)")))
                        return
                    }
                    if (kind === "event") {
                        sawEvent = true
                        if (continuation) endIdle()
                    }
                    // anything else ("* OK still alive") is ignored
                }
                readNext()
            }
            const readNext = () => {
                readLineRaw(this.input, this.cancellable).then(onLine, e => settle(() => reject(e)))
            }

            writeAll(out, `${tag} IDLE\r\n`, this.cancellable)
                .then(readNext)
                .catch(e => settle(() => reject(e)))
        })
    }

    async logout(): Promise<void> {
        if (this.closed) return
        await this.command("LOGOUT").catch(() => {})
    }

    // aborts pending reads/writes (cancel) and closes the socket;
    // idempotent, safe from dispose() while a round is in flight
    close(): void {
        if (this.closed) return
        this.closed = true
        this.cancellable.cancel()
        // close the TLS stream first when there is one, then the socket
        // underneath it: closing only the wrapper can leave the fd open
        try {
            if (this.io !== this.conn) this.io.close(null)
        } catch {}
        this.conn.close(null)
    }
}

// one full poll on a fresh connection; throws on any failure
async function fetchUnread(): Promise<Envelope[]> {
    const s = await ImapSession.open()
    try {
        await s.examineInbox()
        return await s.fetchUnread()
    } finally {
        await s.logout()
        s.close()
    }
}

// mark one mail seen on its own short connection; throws on any
// failure, and an auth rejection carries e.auth so the caller can trip
// the same kill-switch a failed poll does.
//
// Routed through ImapSession rather than hand-rolling a second login
// path: the old one issued LOGIN and never looked at the reply, so a
// rejected password went on to SELECT and STORE, came back false, and
// surfaced as a generic "mark-seen failed" — the one state the provider
// already knows how to explain, reported as the one it cannot.
async function storeSeen(uid: number): Promise<void> {
    const s = await ImapSession.open()
    try {
        await s.selectInbox()
        await s.markSeen(uid)
    } finally {
        await s.logout()
        s.close()
    }
}

// ---------------------------------------------------------------- state

const [items, setItems] = createState<ProviderItem[]>([])
export { items }

let pollInFlight = false
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
            .then(() => setItems(items.get().filter(i => i.id !== data.id)))
            .catch(e => {
                // the same rejection a poll would have seen: say so, and
                // stop the provider rather than failing quietly per click
                if (e?.auth) return onAuthFailure()
                console.warn("ProtonMail: mark-seen failed:", e)
            })
    }
    return {
        ...data,
        hide: () => {
            hiddenIds.add(data.id)
            setItems(items.get().filter(i => i.id !== data.id))
        },
        dismiss: markRead,
        activate: () => {
            openUrl(data.url, "ProtonMail")
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

/** is this the bridge simply not being up? Connection-refused (and an
 *  unreachable loopback) means the local Bridge app is not running —
 *  a normal state on a machine where mail is opened occasionally, not
 *  a fault worth a stack trace */
export function isBridgeDown(e: unknown): boolean {
    if (e instanceof GLib.Error) {
        return (
            e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CONNECTION_REFUSED) ||
            e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.HOST_UNREACHABLE) ||
            e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NETWORK_UNREACHABLE)
        )
    }
    // the imap layer rejects with plain objects too; the wrapped error
    // keeps gio's wording
    const message = String((e as { message?: string })?.message ?? e ?? "")
    return /connection refused|could not connect|unreachable/i.test(message)
}

// the bridge being off would otherwise print two stack traces per poll
// AND one per IDLE retry, for as long as it stays off. Note it once,
// then stay quiet until it answers again
let bridgeDownSince = 0

function noteBridgeDown() {
    setStatus("ProtonMail bridge isn't running")
    if (bridgeDownSince) return
    bridgeDownSince = Date.now()
    console.log("ProtonMail: bridge not reachable; retrying quietly until it is back")
}

// the poll loop and the IDLE session funnel every result through here
function deliver(envs: Envelope[]) {
    if (bridgeDownSince) {
        console.log("ProtonMail: bridge reachable again")
        bridgeDownSince = 0
    }
    setStatus(null)
    // an IDLE push is as good as a poll for the refresh gate: the
    // center opening straight after one must not open a second
    // connection to ask the bridge what it just told us
    gate.touch()
    applyEnvelopes(envs)
}

function onAuthFailure() {
    authFailed = true
    setStatus("ProtonMail login rejected — check ~/.config/wam-shell/protonmail.env")
    stopTimers()
    // ...and the live IDLE connection, which stopTimers does not touch.
    //
    // "Disabled until restart" has to mean it. Reached from a mark-seen
    // STORE (rather than from the poll), this left an authenticated IDLE
    // session up and pushing: the centre showed the provider's own
    // "login rejected" in its empty state while new mail kept arriving in
    // the list underneath it — a status line contradicting the rows it
    // sits above. Every other disabling path already lands here, so this
    // is the one place it belongs.
    idleSession?.close()
    idleSession = null
    console.warn("ProtonMail: login rejected; provider disabled until the shell restarts")
}

export function poll() {
    if (!active || authFailed || pollInFlight || disposed) return
    pollInFlight = true
    gate.touch()
    fetchUnread()
        .then(deliver)
        .catch(e => {
            if (e?.auth) {
                onAuthFailure()
            } else if (isBridgeDown(e)) {
                noteBridgeDown()
            } else {
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
const gate = createRefreshGate(60_000, poll)
export const refresh = gate.refresh

// ----------------------------------------------------- idle / fallback

// Push (IDLE) is the default; the short-connection poll loop is the
// fallback. Any IDLE failure tears the session down and polls for one
// poll-interval cooldown, then retries IDLE. A tagged IDLE refusal
// (server without IDLE) polls without retrying; an auth rejection
// disables the provider until restart — both paths share the markers
let idleSession: ImapSession | null = null
let idleStarting = false
let idleRetryTimer = 0
let idleUnsupported = false
let disposed = false

function stopTimers() {
    if (pollTimer) {
        sourceRemove(pollTimer)
        pollTimer = 0
    }
    if (idleRetryTimer) {
        sourceRemove(idleRetryTimer)
        idleRetryTimer = 0
    }
}

function startPolling() {
    if (pollTimer || authFailed || disposed) return
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

// one cooldown interval in poll mode, then another push attempt
function scheduleIdleRetry() {
    if (idleRetryTimer || authFailed || disposed) return
    idleRetryTimer = timeoutAddSeconds(
        "protonmail:idle-retry",
        GLib.PRIORITY_DEFAULT,
        Config.protonmail.pollMinutes * 60,
        () => {
            idleRetryTimer = 0
            startIdle()
            return GLib.SOURCE_REMOVE
        },
    )
}

function startIdle() {
    if (idleSession || idleStarting || idleUnsupported || authFailed || disposed) return
    idleStarting = true
    runIdle()
        .catch(e => {
            if (disposed) return
            if (e?.auth) {
                onAuthFailure()
            } else if (e?.unsupported) {
                console.warn("ProtonMail: server has no IDLE; using the poll loop")
                idleUnsupported = true
                startPolling()
            } else if (isBridgeDown(e)) {
                // same fallback, no noise: the poll loop keeps trying
                // and the IDLE retry picks the session back up when
                // the bridge returns
                noteBridgeDown()
                startPolling()
                scheduleIdleRetry()
            } else {
                console.warn("ProtonMail: IDLE failed, falling back to polling:", e)
                setStatus("Couldn't sync ProtonMail — is the bridge running?")
                startPolling()
                scheduleIdleRetry()
            }
        })
        .finally(() => {
            idleStarting = false
            idleSession?.close()
            idleSession = null
        })
}

// the push loop: one session, IDLE rounds until an error ends it (the
// .catch in startIdle owns the fallback)
async function runIdle() {
    const s = await ImapSession.open()
    if (disposed) {
        s.close()
        return
    }
    idleSession = s
    stopTimers() // push replaces polling
    await s.examineInbox()
    deliver(await s.fetchUnread()) // initial sync, today's startup poll
    while (!disposed) {
        if ((await s.idleRound()) === "refresh") deliver(await s.fetchUnread())
    }
}

export function dispose() {
    disposed = true
    stopTimers()
    // cancelling the session cancellable aborts any pending read, which
    // ends runIdle(); its .catch sees disposed and stays silent
    idleSession?.close()
    idleSession = null
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
        status,
        setupHint: active
            ? null
            : !transportOk
              ? `ProtonMail is set to host ${Config.protonmail.host}, which is not this machine, with TLS off — the bridge password would be sent in the clear, so the provider is disabled. Set [protonmail] tls = true, or point host back at 127.0.0.1.`
              : "Set up ProtonMail: install Proton Mail Bridge and sign in, then put its IMAP credentials in ~/.config/wam-shell/protonmail.env as PROTONMAIL_IMAP_USER=<user> and PROTONMAIL_IMAP_PASSWORD=<password>",
    } satisfies Provider)
}

export function init() {
    if (!active) return
    startIdle()
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("protonmail", dispose)
