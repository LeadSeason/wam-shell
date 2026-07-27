import AstalNotifd from "gi://AstalNotifd?version=0.1"
import { createBinding, createComputed } from "gnim"

// Shared notification daemon state. The first instantiation becomes
// the daemon (so swaync must not run alongside).

const notifd = AstalNotifd.get_default()

const notifications = createBinding(notifd, "notifications")
export const count = notifications.as(n => n.length)
export const dnd = createBinding(notifd, "dontDisturb")

export function toggleDnd() {
    notifd.dontDisturb = !notifd.dontDisturb
}

export default notifd
