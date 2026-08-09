import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import Config from "../config"
import { registerDispose } from "./lifecycle"

// Posting a notification FROM the shell, as a client.
//
// Not to be confused with `lib/notifd`, which is the shell acting as the
// notification daemon. This is the other direction: the shell has
// something to say (a screenshot landed, a recording stopped) and says
// it the same way any other application would — over
// org.freedesktop.Notifications, so it works whether the daemon is ours
// or somebody else's.
//
// `lib/harvest/notify.ts` predates this and keeps its own copy, because
// it does something extra: it remembers the ids of banners that must be
// dismissed later and closes them when they go stale. That is harvest's
// policy, not a general one, so it stays where it is rather than being
// hoisted into a helper that would have to carry it for everyone.

export interface NotifyAction {
    /** action key sent back over the bus; "default" is the whole-banner click */
    id: string
    label: string
    run: () => void
}

export interface NotifyOptions {
    summary: string
    body?: string
    icon?: string
    /** 0 low, 1 normal, 2 critical */
    urgency?: 0 | 1 | 2
    /** attention only — keep it out of the centre's history */
    transient?: boolean
    /** milliseconds; 0 waits for a dismissal, -1 lets the daemon decide */
    expire?: number
    actions?: NotifyAction[]
}

// handlers for the banners we have posted that carry actions, keyed by
// the id the daemon filed them under
const pending = new Map<number, NotifyAction[]>()
let subscription = 0
let closedSubscription = 0

function ensureSubscribed() {
    if (subscription !== 0) return
    // Subscribed on first use, not at import: a shell that never posts
    // an actionable notification never listens for one either.
    subscription = Gio.DBus.session.signal_subscribe(
        null,
        "org.freedesktop.Notifications",
        "ActionInvoked",
        "/org/freedesktop/Notifications",
        null,
        Gio.DBusSignalFlags.NONE,
        (_c, _s, _o, _i, _sig, params) => {
            const [id, actionId] = params.deepUnpack<[number, string]>()
            const action = pending.get(id)?.find(a => a.id === actionId)
            if (!action) return
            try {
                action.run()
            } catch (e) {
                console.warn("notify: action handler failed:", e)
            }
            pending.delete(id)
        },
    )
    // A banner that is dismissed or expires will never invoke anything,
    // and its handlers would otherwise sit in the map for the rest of
    // the session — one entry per screenshot taken.
    closedSubscription = Gio.DBus.session.signal_subscribe(
        null,
        "org.freedesktop.Notifications",
        "NotificationClosed",
        "/org/freedesktop/Notifications",
        null,
        Gio.DBusSignalFlags.NONE,
        (_c, _s, _o, _i, _sig, params) => {
            const [id] = params.deepUnpack<[number, number]>()
            pending.delete(id)
        },
    )
}

/** Post a notification. Fire and forget unless it carries actions. */
export function notify(opts: NotifyOptions): void {
    const hints: Record<string, GLib.Variant> = {
        urgency: new GLib.Variant("y", opts.urgency ?? 1),
    }
    if (opts.transient) hints.transient = new GLib.Variant("b", true)

    const actions = opts.actions ?? []
    if (actions.length > 0) ensureSubscribed()

    Gio.DBus.session.call(
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
        "Notify",
        new GLib.Variant("(susssasa{sv}i)", [
            Config.instanceName,
            0,
            opts.icon ?? "",
            opts.summary,
            opts.body ?? "",
            // the wire format is a flat [id, label, id, label, …] list
            actions.flatMap(a => [a.id, a.label]),
            hints,
            opts.expire ?? -1,
        ]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_conn, res) => {
            try {
                const reply = Gio.DBus.session.call_finish(res)
                const id = reply.deepUnpack<[number]>()[0]
                if (id && actions.length > 0) pending.set(id, actions)
            } catch (e) {
                console.warn("notify: Notify failed:", e)
            }
        },
    )
}

function dispose() {
    if (subscription !== 0) {
        Gio.DBus.session.signal_unsubscribe(subscription)
        subscription = 0
    }
    if (closedSubscription !== 0) {
        Gio.DBus.session.signal_unsubscribe(closedSubscription)
        closedSubscription = 0
    }
    pending.clear()
}

registerDispose("notify", dispose)
