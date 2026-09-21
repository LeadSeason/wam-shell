import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"

// Tray item liveness and content heuristics.
//
// Two kinds of dead item accumulate in the tray otherwise:
//
// - Zombie registrations: an app dies without unregistering its
//   StatusNotifierItem. The astal watcher is SUPPOSED to drop these
//   when the bus name loses its owner (watcher.vala subscribes
//   NameOwnerChanged), yet they persist in practice — three items from
//   long-dead Electron processes were observed sitting in the watcher's
//   registry while their names had no owner.
// - Hollow registrations from LIVE apps: the item exists on the bus
//   but exports no icon, title or tooltip (Signal registers before its
//   window ever opens; an Electron app whose renderer died serves an
//   empty D-Bus object). Nothing can ever render.
//
// The tray widget hides both: names without an owner immediately, and
// contentless items once a grace period has passed (so a slow-starting
// app that fills its item in seconds later does not flicker).

// How long a contentless (hollow) registration keeps its placeholder
// before being hidden. Electron typically populates its item within
// seconds of registering; Signal takes until its window first opens.
export const HOLLOW_GRACE_MS = 30_000

// A tray item's id is "<bus name><object path>" — see docs/Tray.md.
// The name is everything before the first '/'; both well-known
// ("org.kde.StatusNotifierItem-4265-1") and unique (":1.22") names
// appear.
export function itemBusName(itemId: string): string | null {
    const slash = itemId.indexOf("/")
    if (slash <= 0) return null
    return itemId.slice(0, slash)
}

export interface ItemContent {
    gicon: unknown
    title: string | null
    tooltip_markup: string | null
}

// A hollow registration exports nothing renderable yet. Anything else
// renders — an item with a title but no icon gets the missing-image
// fallback glyph, so this stays deliberately conservative: only an
// item with NOTHING is treated as not-there.
export function hasRenderableContent(item: ItemContent): boolean {
    return item.gicon != null || !!item.title || !!item.tooltip_markup
}

function nameHasOwner(name: string): boolean {
    try {
        Gio.DBus.session.call_sync(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetNameOwner",
            new GLib.Variant("(s)", [name]),
            new GLib.VariantType("(s)"),
            Gio.DBusCallFlags.NONE,
            500,
            null,
        )
        return true
    } catch {
        return false // unowned, or the bus did not answer: treat as dead
    }
}

// Tracks the bus names behind tray items and reports when a watched
// name gains or loses an owner. Refcounted: several items can share one
// name (an app registering under both its well-known and its unique
// name happens), and the callback fires per name, not per item.
export class BusNameLiveness {
    private refs = new Map<string, number>()
    private readonly subscription: number

    constructor(private readonly onChange: (name: string, alive: boolean) => void) {
        this.subscription = Gio.DBus.session.signal_subscribe(
            null,
            "org.freedesktop.DBus",
            "NameOwnerChanged",
            "/org/freedesktop/DBus",
            null,
            Gio.DBusSignalFlags.NONE,
            (_c, _s, _o, _i, _sig, params) => {
                const [name, , newOwner] = params.deepUnpack<[string, string, string]>()
                if (!this.refs.has(name)) return
                this.onChange(name, newOwner !== "")
            },
        )
    }

    // The owner check runs once per name, at first watch: a zombie
    // backfilled from the registry is reported dead immediately.
    watch(name: string): void {
        const next = (this.refs.get(name) ?? 0) + 1
        this.refs.set(name, next)
        if (next === 1 && !nameHasOwner(name)) this.onChange(name, false)
    }

    unwatch(name: string): void {
        const next = (this.refs.get(name) ?? 0) - 1
        if (next <= 0) this.refs.delete(name)
        else this.refs.set(name, next)
    }

    dispose(): void {
        Gio.DBus.session.signal_unsubscribe(this.subscription)
        this.refs.clear()
    }
}
