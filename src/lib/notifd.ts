import AstalNotifd from "gi://AstalNotifd?version=0.1"
import { Accessor, createBinding } from "gnim"
import { createPoll } from "ags/time"

// Shared notification daemon state. The first instantiation becomes
// the daemon (so swaync must not run alongside).

const notifd = AstalNotifd.get_default()

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

export function relTime(unixSeconds: number, nowMs: number): string {
    const diff = Math.max(0, Math.floor(nowMs / 1000 - unixSeconds))
    if (diff < 60) return "now"
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return `${Math.floor(diff / 86400)}d ago`
}

export default notifd
