import AstalWp from "gi://AstalWp?version=0.1"
import GLib from "gi://GLib"
import { createBinding } from "gnim"
import { sourceRemove, timeoutAddSeconds } from "./metrics"

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
// cb fires on every change of the resolved default (initially null until
// one registers); the returned disposer tears everything down. Consumers:
// the OSD (lib/osd.ts) and the bar's audio indicators
// (widgets/bar/barModules/QSettingsLabel.tsx).
//
// Losing the default is reported on a GRACE delay, not immediately. During
// device re-enumeration (BT connect, A2DP<->HFP profile flip, card profile
// switch) the defaults plugin re-points BEFORE the replacement node
// registers, so for a window NO endpoint carries isDefault — while pipewire
// keeps playing throughout. Reporting null in that window made every
// consumer blank out mid-playback: the slider entry hid, the bar indicator
// vanished, and the OSD unhooked itself and stopped appearing. The grace
// keeps the last default reported until a new one registers. Trade-off: a
// genuinely unplugged device lingers up to DROP_GRACE_SECONDS, and volume
// writes during a gap can land on a dead node.
const DROP_GRACE_SECONDS = 5

export function watchDefaultEndpoint(
    audio: AstalWp.Audio,
    prop: "speakers" | "microphones",
    cb: (endpoint: AstalWp.Endpoint | null) => void,
): () => void {
    let current: AstalWp.Endpoint | null = null
    let nodeDisposers: (() => void)[] = []
    let dropTimer = 0
    const cancelDrop = () => {
        if (dropTimer) {
            sourceRemove(dropTimer)
            dropTimer = 0
        }
    }
    const rescan = () => {
        for (const d of nodeDisposers) d()
        const list = audio[prop] ?? []
        nodeDisposers = list.map(e => createBinding(e, "isDefault").subscribe(rescan))
        const next = list.find(e => e.isDefault) ?? null
        // identity, not value: a new endpoint object for the same
        // physical device (re-enumeration) IS a change — the old object
        // is the dead one
        if (next !== null) {
            cancelDrop()
            if (next !== current) {
                current = next
                cb(next)
            }
        } else if (current !== null && !dropTimer) {
            // no default right now: keep the last one through the
            // re-enumeration window, drop it only if none registers
            dropTimer = timeoutAddSeconds(
                "defaultEndpoint.drop",
                GLib.PRIORITY_DEFAULT,
                DROP_GRACE_SECONDS,
                () => {
                    dropTimer = 0
                    current = null
                    cb(null)
                    return GLib.SOURCE_REMOVE
                },
            )
        }
    }
    const listDisposer = createBinding(audio, prop).subscribe(rescan)
    rescan()
    return () => {
        cancelDrop()
        listDisposer()
        for (const d of nodeDisposers) d()
    }
}
