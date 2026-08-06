import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import Config from "../../config"
import { Entry, formatElapsed, liveSeconds } from "./timeline"

// A banner whenever a timer starts or stops, wherever it happened —
// this shell, the harvest web app, the phone. The forgotten-timer case
// is the one that costs money, so the banner is posted with critical
// urgency and no expiry: it stays on screen until dismissed rather
// than sliding away while you are looking at something else.
// [harvest] notify = false turns it off.

// the first adoption is the startup sync reporting what was already
// running — that is state, not a change, and must not banner
let armed = false

// starting is an acknowledgement — it should slide past. Stopping is
// the one that costs money if missed, so it waits to be dismissed:
// critical is what makes it wait (the shell's own daemon never drains
// a critical banner) and expire 0 says the same to a foreign daemon.
// The start banner is also marked transient: attention-only, kept out
// of the center's history so acknowledgements don't pile up there
function post(summary: string, body: string, urgent: boolean) {
    const hints: Record<string, GLib.Variant> = {
        urgency: new GLib.Variant("y", urgent ? 2 : 0),
    }
    if (!urgent) hints.transient = new GLib.Variant("b", true)
    Gio.DBus.session.call(
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
        "Notify",
        new GLib.Variant("(susssasa{sv}i)", [
            "wam-shell",
            0,
            "alarm-symbolic",
            summary,
            body,
            [],
            hints,
            urgent ? 0 : -1,
        ]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_conn, res) => {
            try {
                Gio.DBus.session.call_finish(res)
            } catch (e) {
                console.warn("Harvest notify failed:", e)
            }
        },
    )
}

/** "Project · Task", falling back to whatever half exists */
function label(entry: Entry): string {
    return [entry.projectName, entry.taskName].filter(s => !!s).join(" · ")
}

/** what a transition should say, or null for "say nothing". `urgent`
 *  marks the banners that must wait to be dismissed */
export function timerBanner(
    prev: Entry | null,
    next: Entry | null,
    pausedEntry: Entry | null,
): { summary: string; body: string; urgent: boolean } | null {
    // nothing was running and nothing is: not a transition
    if (!prev && !next) return null
    if (next) {
        // a switch (A -> B) reads as starting B: the stop of A is
        // implied by it, and two banners for one action is noise
        return { summary: "Harvest timer started", body: label(next), urgent: false }
    }
    // prev is non-null here: something stopped — the case worth
    // interrupting for, since an unnoticed stop loses tracked time
    return {
        summary: pausedEntry ? "Harvest timer paused" : "Harvest timer stopped",
        body: `${label(prev!)} — ${formatElapsed(liveSeconds(prev!))}`,
        urgent: true,
    }
}

/**
 * Banner the transition between two running entries.
 * @param prev the entry that was running (null = nothing was)
 * @param next the entry running now (null = nothing is)
 * @param pausedEntry the paused entry, when the stop was a pause
 */
export function notifyTimerChange(
    prev: Entry | null,
    next: Entry | null,
    pausedEntry: Entry | null,
) {
    const banner = timerBanner(prev, next, pausedEntry)
    if (!banner) return
    if (!armed) {
        // the first real transition after startup is the sync
        // reporting what was already running
        armed = true
        return
    }
    if (!Config.harvest.notify) return
    post(banner.summary, banner.body, banner.urgent)
}
