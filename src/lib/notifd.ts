import AstalNotifd from "gi://AstalNotifd?version=0.1"
import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import { Accessor, createBinding, createState } from "gnim"
import { createPoll } from "ags/time"
import Config from "../config"

// Shared notification daemon state. The first instantiation becomes
// the daemon (so swaync must not run alongside).

const notifd = AstalNotifd.get_default()

// Whose daemon handles notifications (notifications.daemon):
// "wam-shell" always ours, "system" never, "auto" ours only when no
// other daemon owns org.freedesktop.Notifications at startup. When the
// name is already taken astal backs off (it does not steal it), so the
// owner being someone else means a system daemon was there first.
function detectSystemDaemon(): boolean {
    try {
        const reply = Gio.DBus.session.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "GetNameOwner",
            new GLib.Variant("(s)", ["org.freedesktop.Notifications"]),
            new GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, 500, null)
        const owner = reply.get_child_value(0).get_string()[0]
        return owner !== Gio.DBus.session.get_unique_name()
    } catch {
        return false // name has no owner
    }
}

const mode = Config.notifications.daemon
export const useOurs = mode === "wam-shell" ? true
    : mode === "system" ? false
    : !detectSystemDaemon()
if (!useOurs) console.log("Notifications: using the system daemon")

const notifications = createBinding(notifd, "notifications")
export const count = notifications.as(n => n.length)
export const dnd = createBinding(notifd, "dontDisturb")

export function toggleDnd() {
    notifd.dontDisturb = !notifd.dontDisturb
}

export interface NotificationGroup {
    app: string
    items: AstalNotifd.Notification[]
}

// notifications bucketed by app, newest first within and across groups
export const grouped: Accessor<NotificationGroup[]> =
    notifications.as((list) => {
        const buckets = new Map<string, AstalNotifd.Notification[]>()
        for (const n of list) {
            const app = n.appName || "unknown"
            const bucket = buckets.get(app)
            if (bucket) bucket.push(n)
            else buckets.set(app, [n])
        }
        return [...buckets.entries()]
            .map(([app, items]): NotificationGroup => ({
                app,
                // id breaks timestamp ties: notifications sent within the
                // same second still order by arrival
                items: items.sort((a, b) => b.time - a.time || b.id - a.id),
            }))
            .sort((a, b) =>
                b.items[0].time - a.items[0].time || b.items[0].id - a.items[0].id)
    })

// ticks once a minute while subscribed, so relative timestamps stay fresh
export const timeTick = createPoll(0, 60_000, () => Date.now())

// --- transient popups -------------------------------------------------

// notifications currently shown as popup banners. Expiry is handled by
// the row widget (it owns the countdown); hiding a popup never dismisses
// the notification from the center.
const MAX_POPUPS = 4

const [popupsState, setPopups] = createState<AstalNotifd.Notification[]>([])
export const popups: Accessor<AstalNotifd.Notification[]> = popupsState

export function removePopup(id: number) {
    setPopups(popupsState.get().filter((n) => n.id !== id))
}

notifd.connect("notified", (_s, id) => {
    if (!useOurs) return
    const n = notifd.get_notification(id)
    if (!n) return
    // DND silences popups; critical notifications still break through
    if (notifd.dontDisturb && n.urgency !== AstalNotifd.Urgency.CRITICAL) return

    const current = popupsState.get()
    if (current.some((p) => p.id === id)) return
    setPopups([...current, n].slice(-MAX_POPUPS))
})

// dismissed/expired elsewhere (center, app) -> drop the banner too
notifd.connect("resolved", (_s, id) => removePopup(id))

// hovering ANY banner freezes every countdown: if a banner above the
// hovered one expired mid-interaction, the stack would shift and yank
// the hovered banner out from under the pointer
let hoverCount = 0
export function setPopupHovered(hovered: boolean) {
    hoverCount = Math.max(0, hoverCount + (hovered ? 1 : -1))
}
export function anyPopupHovered(): boolean {
    return hoverCount > 0
}

export function relTime(unixSeconds: number, nowMs: number): string {
    const diff = Math.max(0, Math.floor(nowMs / 1000 - unixSeconds))
    if (diff < 60) return "now"
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return `${Math.floor(diff / 86400)}d ago`
}

export default notifd
