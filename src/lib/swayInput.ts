import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"

// Raw sway IPC input-event subscription (sway-ipc(7)): the i3ipc
// binding doesn't expose "input" events, so the layout source speaks
// the protocol itself. One unix connection subscribes to ["input"]
// and streams event frames; a GET_INPUTS request seeds the state.
//
// Frame: magic "i3-ipc" | u32 length | u32 type | JSON payload.

const MAGIC = new TextEncoder().encode("i3-ipc")
const TYPE_SUBSCRIBE = 2
const TYPE_GET_INPUTS = 100
const EVENT_INPUT = 0x80000015

const MAX_RETRIES = 5
let started = false
// bumped by unwatchSwayInputs: async callbacks scheduled before the
// teardown no-op afterwards
let generation = 0
let activeConn: Gio.SocketConnection | null = null
let retrySource = 0

interface Handlers {
    // reply to the seed request: the full GET_INPUTS array
    onInputs: (devices: any[]) => void
    // single input event (xkb_layout, xkb_keymap, added, removed, …)
    onInputEvent: (ev: { change: string; input: any }) => void
    // socket unavailable after retries: caller should fall back to polling
    onUnavailable: () => void
}

function frame(type: number, payload: string): GLib.Bytes {
    const p = new TextEncoder().encode(payload)
    const out = new Uint8Array(14 + p.length)
    out.set(MAGIC, 0)
    const dv = new DataView(out.buffer)
    dv.setUint32(6, p.length, true)
    dv.setUint32(10, type, true)
    out.set(p, 14)
    return new GLib.Bytes(out)
}

export function watchSwayInputs(handlers: Handlers) {
    if (started) return
    started = true
    const path = GLib.getenv("I3SOCK")
    if (!path) {
        handlers.onUnavailable()
        return
    }
    connect(path, handlers, 0)
}

// teardown half of watchSwayInputs (convention for lib modules with
// long-lived sources, see AGENTS.md): close the stream and stop any
// pending reconnect; in-flight callbacks no-op via the generation bump
export function unwatchSwayInputs() {
    if (!started) return
    started = false
    generation++
    if (retrySource) {
        GLib.source_remove(retrySource)
        retrySource = 0
    }
    activeConn?.close(null)
    activeConn = null
}

function connect(path: string, handlers: Handlers, attempt: number) {
    const gen = generation
    const client = new Gio.SocketClient()
    client.connect_async(Gio.UnixSocketAddress.new(path), null, (_c, res) => {
        if (gen !== generation) return
        let conn: Gio.SocketConnection
        try {
            conn = client.connect_finish(res)
        } catch {
            return retry(path, handlers, attempt)
        }
        activeConn = conn
        const out = conn.get_output_stream()
        const send = (type: number, payload: string, next: () => void) => {
            out.write_bytes_async(frame(type, payload), GLib.PRIORITY_DEFAULT, null, (_o, wres) => {
                try {
                    out.write_bytes_finish(wres)
                    next()
                } catch {
                    retry(path, handlers, attempt)
                }
            })
        }
        send(TYPE_SUBSCRIBE, '["input"]', () =>
            // seed the initial state once subscribed
            send(TYPE_GET_INPUTS, "", () => {}),
        )
        readLoop(conn, path, handlers)
    })
}

function retry(path: string, handlers: Handlers, attempt: number) {
    if (!started) return
    if (attempt + 1 >= MAX_RETRIES) {
        handlers.onUnavailable()
        return
    }
    retrySource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
        retrySource = 0
        connect(path, handlers, attempt + 1)
        return GLib.SOURCE_REMOVE
    })
}

function readLoop(conn: Gio.SocketConnection, path: string, handlers: Handlers) {
    const stream = new Gio.DataInputStream({ base_stream: conn.get_input_stream() })
    let leftover = new Uint8Array(0)

    // false when the stream desynced and a reconnect was started:
    // the caller must not schedule another read on the old connection
    const feed = (chunk: Uint8Array): boolean => {
        const buf = new Uint8Array(leftover.length + chunk.length)
        buf.set(leftover, 0)
        buf.set(chunk, leftover.length)
        leftover = buf
        while (leftover.length >= 14) {
            // out-of-sync magic means the stream is garbage: drop it
            if (MAGIC.some((b, i) => leftover[i] !== b)) {
                leftover = new Uint8Array(0)
                conn.close(null)
                retry(path, handlers, 0)
                return false
            }
            const dv = new DataView(leftover.buffer, leftover.byteOffset, 14)
            const len = dv.getUint32(6, true)
            if (leftover.length < 14 + len) break
            const type = dv.getUint32(10, true)
            const payload = leftover.slice(14, 14 + len)
            leftover = leftover.slice(14 + len)
            let json: any = null
            try {
                json = JSON.parse(new TextDecoder().decode(payload))
            } catch {
                continue
            }
            // a handler bug must not kill the read loop
            try {
                if (type === TYPE_GET_INPUTS && Array.isArray(json)) handlers.onInputs(json)
                else if (type === EVENT_INPUT) handlers.onInputEvent(json)
            } catch (e) {
                console.warn("swayInput: handler failed:", e)
            }
        }
        return true
    }

    const read = () => {
        stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null, (_s, res) => {
            let bytes: GLib.Bytes | null = null
            try {
                bytes = stream.read_bytes_finish(res)
            } catch {
                bytes = null
            }
            // EOF or error (sway restart): try to reconnect before the
            // caller drops to the poll fallback
            if (!bytes || bytes.get_size() === 0) {
                conn.close(null)
                return retry(path, handlers, 0)
            }
            if (feed(bytes.get_data()!)) read()
        })
    }
    read()
}
