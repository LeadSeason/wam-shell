import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { execAsync, timeoutAdd, sourceRemove } from "../../lib/metrics"
import { createPoll } from "ags/time"
import { readFile } from "ags/file"
import AstalBattery from "gi://AstalBattery?version=0.1"
import { Accessor, createBinding, createComputed, createState, onCleanup } from "gnim"
import Config from "../../config"
import { isFile } from "../../lib/utils"
import { confirmDialog } from "../dialog"
import { qsVisible } from "./MediaSection"

// avatar sources, in order: configured absolute path, the login avatar
// from AccountsService, the OS icon (same as the panel's osIcon)
function resolveAvatar(): { file: string | null; icon: string } {
    const configured = Config.quicksettings.avatar
    if (configured && isFile(configured)) return { file: configured, icon: "" }
    try {
        const kf = new GLib.KeyFile()
        kf.load_from_file(
            `/var/lib/AccountsService/users/${GLib.get_user_name()}`,
            GLib.KeyFileFlags.NONE,
        )
        const icon = kf.get_string("User", "Icon")
        if (icon && isFile(icon)) return { file: icon, icon: "" }
    } catch {}
    return { file: null, icon: Config.osIcon }
}

// battery level as a static ring around the avatar
function Avatar() {
    const avatar = resolveAvatar()
    const bat = AstalBattery.get_default()
    const pct = createBinding(bat, "percentage")

    function drawRing(area: Gtk.DrawingArea, cr: any, w: number, h: number) {
        if (!bat.isPresent) return
        const c = area.get_color()
        const r = Math.min(w, h) / 2 - 2.5
        const cx = w / 2
        const cy = h / 2
        cr.setLineWidth(3)
        cr.arc(cx, cy, r, 0, Math.PI * 2)
        cr.setSourceRGBA(c.red, c.green, c.blue, 0.2)
        cr.stroke()
        // show relative to the configured charge cap (battery_full_at),
        // ceiled to 1% steps. At the charge limit itself the ring
        // closes completely, matching the "charge limit" text
        const cap = Config.quicksettings.batteryFullAt / 100
        // judge by percentage alone: UPower's charging state flickers
        // at the cap ("not charging" with a bogus time)
        const atLimit = pct.get() * 100 >= Config.quicksettings.batteryFullAt - 2
        const frac = atLimit ? 1 : Math.min(1, Math.ceil((pct.get() / cap) * 100) / 100)
        if (frac > 0.005) {
            cr.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2)
            cr.setSourceRGBA(c.red, c.green, c.blue, 0.95)
            cr.stroke()
        }
    }

    return (
        <overlay
            widthRequest={48}
            heightRequest={48}
            $={self => {
                // gnim overlays only reliably keep the first JSX child —
                // add the frame imperatively (same pattern as PopupRow)
                self.add_overlay(
                    (
                        <box
                            cssClasses={["avatarFrame"]}
                            halign={Gtk.Align.CENTER}
                            valign={Gtk.Align.CENTER}
                            widthRequest={36}
                            heightRequest={36}
                            overflow={Gtk.Overflow.HIDDEN}
                        >
                            {avatar.file ? (
                                <Gtk.Picture
                                    file={Gio.File.new_for_path(avatar.file)}
                                    contentFit={Gtk.ContentFit.COVER}
                                    canShrink
                                />
                            ) : (
                                <image iconName={avatar.icon} pixelSize={24} />
                            )}
                        </box>
                    ) as Gtk.Widget,
                )
            }}
        >
            <Gtk.DrawingArea
                cssClasses={["batteryRing"]}
                widthRequest={48}
                heightRequest={48}
                $={self => {
                    const unsub = pct.subscribe(() => self.queue_draw())
                    onCleanup(unsub)
                    self.set_draw_func(drawRing)
                }}
            />
        </overlay>
    )
}

function useBatteryLine(): { line: Accessor<string> } {
    const bat = AstalBattery.get_default()
    const batProc = createBinding(bat, "percentage")

    const batTimeConvert = (timeRemaining: number, charging: boolean): string => {
        // No meaningful estimate (at charge limit, or UPower has no data):
        // show nothing, the percentage is already visible anyway
        if (timeRemaining <= 0) return ""

        // Round to 5 minute steps so small estimate drifts don't retext
        // the label
        const totalMinutes = Math.round(timeRemaining / 60 / 5) * 5
        const hours = Math.floor(totalMinutes / 60)
        const minutes = totalMinutes % 60

        const time = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
        return charging ? `${time} to full` : `${time} left`
    }

    const currentBatTime = (): string =>
        batTimeConvert(bat.charging ? bat.timeToFull : bat.timeToEmpty, bat.charging)

    const [batTime, setBatTime] = createState(currentBatTime())

    // Debounce: UPower oscillates around the charge limit (charging state
    // and time estimates flip back and forth), only update the label once
    // the computed text has been stable for a few seconds.
    let pendingSource: number | null = null
    let pendingValue: string | null = null

    function updateBatTime() {
        const raw = currentBatTime()

        if (raw === batTime.get()) {
            // back to the displayed value, drop any pending change
            if (pendingSource !== null) {
                sourceRemove(pendingSource)
                pendingSource = null
                pendingValue = null
            }
            return
        }
        if (raw === pendingValue) return

        if (pendingSource !== null) sourceRemove(pendingSource)
        pendingValue = raw
        pendingSource = timeoutAdd("qsHeader:batTimeDebounce", GLib.PRIORITY_DEFAULT, 5000, () => {
            pendingSource = null
            pendingValue = null
            setBatTime(raw)
            return GLib.SOURCE_REMOVE
        })
    }

    createBinding(bat, "timeToEmpty").subscribe(updateBatTime)
    createBinding(bat, "timeToFull").subscribe(updateBatTime)
    createBinding(bat, "charging").subscribe(updateBatTime)

    return {
        line: createComputed([batProc, batTime], (p, t) => {
            const pct = `${(p * 100).toFixed(0)}%`
            // at the charge limit UPower still reports a bogus
            // timeToFull although nothing is charging (a known quirk)
            // judge by percentage alone: UPower's charging state also
            // flickers at the cap ("not charging" with a bogus time)
            if (p * 100 >= Config.quicksettings.batteryFullAt - 2) return `${pct} · charge limit`
            return t ? `${pct} · ${t}` : pct
        }),
    }
}

// uptime without the fork: /proc/uptime is "<seconds> <idle>" and
// /proc/loadavg is "<1m> <5m> <15m> …" — everything `uptime` printed
const uptimeConvert = (seconds: number): string => {
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)

    const parts: string[] = []

    if (days > 0) parts.push(`${days}d`)
    if (hours > 0) parts.push(`${hours}h`)
    // minutes only add noise past a day (same rule as the old parser)
    if (minutes > 0 && days === 0) parts.push(`${minutes}m`)

    return `Up ${parts.join(" ")}`
}

const loadConvert = (loadavg: string): string => {
    const [one, five, fifteen] = loadavg.split(" ")
    if (!one || !five || !fifteen) return ""
    return `Load ${one} ${five} ${fifteen}`
}

function useUptimeLine(): { line: Accessor<string> } {
    const [line, setLine] = createState("")
    const poll = createPoll("", 30_000, () => {
        try {
            const up = uptimeConvert(Number(readFile("/proc/uptime").split(" ")[0]))
            const load = loadConvert(readFile("/proc/loadavg"))
            return load ? `${up} · ${load}` : up
        } catch {
            return ""
        }
    })
    // createPoll is lazy: subscribing only while the popup is open stops
    // the 30s wakes entirely, and the open-time compute is fresher than
    // anything a background interval would have produced
    let stop: (() => void) | null = null
    qsVisible.subscribe(() => {
        if (qsVisible.get() && !stop) stop = poll.subscribe(() => setLine(poll.get()))
        if (!qsVisible.get() && stop) {
            stop()
            stop = null
        }
    })
    return { line }
}

export function HeaderSection() {
    const bat = AstalBattery.get_default()
    const { line } = bat.isPresent ? useBatteryLine() : useUptimeLine()

    // loginctl needs the session id; the compositor's locker handles the
    // actual Lock signal. Empty when not under systemd-logind.
    const sessionId = GLib.getenv("XDG_SESSION_ID") ?? ""
    const lock = () =>
        sessionId &&
        execAsync(["loginctl", "lock-session", sessionId]).catch(e =>
            console.warn("lock failed:", e),
        )

    return (
        <box cssClasses={["QSHeader", "paneCard"]}>
            {Config.quicksettings.showAvatar && <Avatar />}
            <box
                orientation={Gtk.Orientation.VERTICAL}
                valign={Gtk.Align.CENTER}
                hexpand
                marginStart={8}
            >
                <label
                    cssClasses={["whoName"]}
                    label={GLib.get_user_name() ?? ""}
                    xalign={0}
                    ellipsize={Pango.EllipsizeMode.END}
                />
                <label
                    cssClasses={["whoSub"]}
                    label={line}
                    xalign={0}
                    ellipsize={Pango.EllipsizeMode.END}
                />
            </box>
            <button
                halign={Gtk.Align.END}
                iconName={"system-lock-screen-symbolic"}
                tooltipText={"Lock session"}
                onClicked={lock}
            />
            <button
                iconName={"system-log-out-symbolic"}
                tooltipText={"Log out"}
                onClicked={async () => {
                    if (
                        await confirmDialog({
                            text: "Log out?",
                            subtext: "Ends the current session",
                            yesButton: "Log out",
                        })
                    )
                        sessionId &&
                            execAsync(["loginctl", "terminate-session", sessionId]).catch(e =>
                                console.warn("logout failed:", e),
                            )
                }}
            />
            <button
                iconName={"system-shutdown-symbolic"}
                tooltipText={"Shut down"}
                onClicked={async () => {
                    if (
                        await confirmDialog({
                            text: "Shut down?",
                            subtext: "Powers off the machine",
                            yesButton: "Shut down",
                        })
                    )
                        execAsync(["systemctl", "poweroff"]).catch(e =>
                            console.warn("poweroff failed:", e),
                        )
                }}
            />
        </box>
    )
}
