import AstalWp from "gi://AstalWp?version=0.1"
import { createBinding } from "gnim"

// The current default audio endpoint, resolved from the node list
// (audio.speakers / audio.microphones, the entry with isDefault) — NOT
// wp.defaultSpeaker / audio.defaultSpeaker. Those are a single
// permanent PROXY object created once at startup, which upstream
// (lib/wireplumber endpoint.c, default_changed_as_default) re-points at
// the real node only when the defaults plugin fires "changed" — and if
// the new node has not registered with the object manager at that
// moment (device re-enumeration is exactly when that races), the proxy
// silently keeps the dead node: volume writes land on a device that no
// longer exists, and nothing recovers short of a shell restart. The
// object identity never changes either, so notify::defaultSpeaker never
// fires and a binding on it never re-evaluates. Real endpoints follow
// enumeration because a re-enumerated device is a NEW endpoint object
// with isDefault set.
//
// cb fires immediately with the current default (possibly null) and on
// every change; the returned disposer tears everything down. Consumers:
// the OSD (lib/osd.ts) and the bar's audio indicators
// (widgets/bar/barModules/QSettingsLabel.tsx).
export function watchDefaultEndpoint(
    audio: AstalWp.Audio,
    prop: "speakers" | "microphones",
    cb: (endpoint: AstalWp.Endpoint | null) => void,
): () => void {
    let current: AstalWp.Endpoint | null = null
    let nodeDisposers: (() => void)[] = []
    const rescan = () => {
        for (const d of nodeDisposers) d()
        const list = audio[prop] ?? []
        nodeDisposers = list.map(e => createBinding(e, "isDefault").subscribe(rescan))
        const next = list.find(e => e.isDefault) ?? null
        // identity, not value: a new endpoint object for the same
        // physical device (re-enumeration) IS a change — the old object
        // is the dead one
        if (next !== current) {
            current = next
            cb(next)
        }
    }
    const listDisposer = createBinding(audio, prop).subscribe(rescan)
    rescan()
    return () => {
        listDisposer()
        for (const d of nodeDisposers) d()
    }
}
