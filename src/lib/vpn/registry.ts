import { Accessor, createComputed } from "gnim"
import { isConnected, type VpnBackend } from "./types"

// The backend registry. Backends register at module scope from their own
// modules (lib/vpn/mullvad, …); lib/vpn/index is the barrel that imports
// them so the registration has happened by the time a widget builds.
//
// Plain array, like lib/notificationProviders: registry presence must
// not depend on a backend having finished detecting anything.

export const backends: VpnBackend[] = []

export function registerBackend(b: VpnBackend) {
    if (!backends.some(x => x.id === b.id)) backends.push(b)
}

export function backendById(id: string): VpnBackend | undefined {
    return backends.find(b => b.id === id)
}

/** where a bare `qsPane vpn` lands, so keybinds written against the old
 *  single-pane name keep working. "" when nothing is detected */
export function firstActiveId(): string {
    return backends.find(b => b.active.get())?.id ?? ""
}

/** the quick settings pane name for a backend id. An empty id (nothing
 *  detected) falls back to main, so a stale keybind opens the popup
 *  rather than asking the stack for a child that does not exist —
 *  Gtk.Stack warns and keeps the previous child in that case */
export function vpnPaneName(id: string): string {
    return id ? `vpn:${id}` : "main"
}

// Built LAZILY and memoised. At module scope this would read an empty
// array: this module is imported BY the backends (that is how they reach
// registerBackend), so its top level runs before any has registered.
let connectedCache: Accessor<VpnBackend | null> | null = null

/** the first backend with a tunnel up, for the panel indicator — which
 *  needs both "is anything connected" and WHICH, for the tooltip.
 *  The tracking form, not the deps-array form: `find` short-circuits, so
 *  the dependency set genuinely varies per run and only that form
 *  re-tracks it (gnim's createComputedProducer rebuilds deps each pass) */
export function connectedBackend(): Accessor<VpnBackend | null> {
    if (!connectedCache) {
        connectedCache = createComputed(
            track => backends.find(b => track(b.active) && isConnected(track(b.status))) ?? null,
        )
    }
    return connectedCache
}
