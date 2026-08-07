import { Gtk, Gdk } from "ags/gtk4"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import { createIconResolver } from "../../lib/appIcon"
import { isRtl } from "../../lib/utils"
import type { ProviderItem } from "../../lib/notificationProviders"

// One shape for both kinds of notification.
//
// A desktop notification from the daemon and a provider item (GitHub,
// Todoist, YouTube) carry the same information under different names,
// and every widget that drew one used to re-derive the same handful of
// fields — which is how the two cards drifted apart: ProviderCard
// learned to skip a summary that only repeated the app name, and
// NotificationCard never did, so an app that sends no summary at all
// printed its name twice ("monux / monux"). Deriving it once, here,
// means the banner and the center cannot disagree about it again.

export type Urgency = "low" | "normal" | "critical"

export interface RowAction {
    id: string
    label: string
}

export interface RowData {
    appName: string
    /** the headline — "" when it would only repeat the app name */
    summary: string
    /** the secondary line — "" when empty or a restatement of summary */
    body: string
    iconName: string
    /** local file for the thumbnail slot; null = no art */
    imagePath: string | null
    /** unix seconds */
    time: number
    urgency: Urgency
    actions: RowAction[]
    /** the row's base direction, taken from whichever text leads it */
    rtl: boolean
}

function isPath(image: string | null): image is string {
    return !!image && (image.startsWith("/") || image.startsWith("file://"))
}

/**
 * The icon for an app, from its own hint or by looking its name up in
 * the desktop-entry database.
 *
 * Exported because the center builds group headers from the row list
 * rather than from a RowData, and was reading `appIcon` raw — so a
 * folded run of notifications showed the generic fallback even where a
 * single row from the same app resolved its icon perfectly. One
 * function, one answer.
 *
 * The resolver is memoised per icon theme, so calling this inside a
 * computed costs a map lookup rather than an app-database rebuild.
 */
export function appIconFor(appIcon: string | null, appName: string): string {
    const resolve = createIconResolver(Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!))
    return appIcon || resolve(appName) || "application-x-executable-symbolic"
}

function urgencyOf(n: AstalNotifd.Notification): Urgency {
    switch (n.urgency) {
        case AstalNotifd.Urgency.CRITICAL:
            return "critical"
        case AstalNotifd.Urgency.LOW:
            return "low"
        default:
            return "normal"
    }
}

// the app name already leads the row, so a summary or body that merely
// repeats it is a line of height spent saying nothing
function distinct(text: string, ...against: string[]): string {
    const t = (text ?? "").trim()
    return t !== "" && !against.some(a => a.trim() === t) ? text : ""
}

export function fromDesktop(n: AstalNotifd.Notification): RowData {
    const image = n.get_image()
    const appName = n.get_app_name() || "unknown"
    const appIcon = appIconFor(n.get_app_icon(), n.get_app_name() ?? "")
    const summary = distinct(n.get_summary(), appName)
    return {
        appName,
        summary,
        body: distinct(n.get_body(), appName, summary),
        // get_image() is either a file path (a thumbnail) or an icon
        // name; only the latter belongs in the icon slot
        iconName: isPath(image) ? appIcon : image || appIcon,
        imagePath: isPath(image) ? image.replace(/^file:\/\//, "") : null,
        time: n.get_time(),
        urgency: urgencyOf(n),
        // "default" is the whole-row click, not a button
        actions: n
            .get_actions()
            .filter(a => a.get_id() !== "default")
            .map(a => ({ id: a.get_id(), label: a.get_label() })),
        rtl: isRtl(n.get_summary() || appName),
    }
}

export function fromItem(item: ProviderItem): RowData {
    const summary = distinct(item.summary, item.appName)
    return {
        appName: item.appName,
        summary,
        body: distinct(item.body, item.appName, summary),
        iconName: item.iconName,
        imagePath: item.imagePath ?? null,
        time: item.time,
        urgency: "normal",
        actions: (item.actions ?? []).map(a => ({ id: a.id, label: a.label })),
        rtl: isRtl(item.summary || item.appName),
    }
}
