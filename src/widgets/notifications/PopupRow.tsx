import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import { onCleanup } from "gnim"
import { idleAdd } from "../../lib/metrics"
import Config from "../../config"
import {
    POPUP_SLIDE_IN_MS,
    PopupEntry,
    popupTimer,
    popupTimerVersion,
    removePopup,
    setPopupHovered,
} from "../../lib/notifd"
import NotificationCard from "./NotificationCard"
import ProviderCard from "./ProviderCard"

// Pure view over the popup controller in lib/notifd: the countdown,
// expiry and hover-freeze live there, so rows like this one can be
// destroyed and rebuilt on monitor focus switches without consequence.
// Renders either card kind: desktop notifications (daemon) and provider
// items (GitHub & co.) share the same countdown/revealer machinery
export default function PopupRow({ entry }: { entry: PopupEntry }) {
    function drawBar(self: Gtk.DrawingArea, cr: any, w: number, h: number) {
        const c = self.get_color()
        const t = popupTimer(entry.key)
        const frac = !t || t.duration === 0 ? 1 : Math.max(0, t.remaining / t.duration)
        // track
        cr.setSourceRGBA(c.red, c.green, c.blue, 0.18)
        cr.rectangle(0, 0, w, h)
        cr.fill()
        // remaining
        if (frac > 0.005) {
            cr.setSourceRGBA(c.red, c.green, c.blue, 0.95)
            cr.rectangle(0, 0, w * frac, h)
            cr.fill()
        }
    }

    // hovering ANY banner freezes every countdown: if a banner above the
    // hovered one expired mid-interaction, the stack would shift and yank
    // the hovered banner out from under the pointer
    let hovered = false
    function hover(h: boolean) {
        if (h === hovered) return
        hovered = h
        setPopupHovered(h)
    }
    // row destroyed while hovered (dismissed from center, replaced by a
    // burst, ...) must not leak the freeze count
    onCleanup(() => {
        if (hovered) setPopupHovered(false)
    })
    onCleanup(() => {
        rev = null
    })

    let rev: Gtk.Revealer | null = null
    let area: Gtk.DrawingArea | null = null

    // the banner slides in only when it is new — a row rebuilt on a
    // monitor switch appears instantly (0ms transition)
    const t = popupTimer(entry.key)
    const young = t !== null && GLib.get_monotonic_time() / 1000 - t.addedAt < POPUP_SLIDE_IN_MS

    // controller state changes: redraw the bar, collapse when expiring
    const unsub = popupTimerVersion.subscribe(() => {
        const timer = popupTimer(entry.key)
        if (timer?.expiring && rev) rev.revealChild = false
        area?.queue_draw()
    })
    onCleanup(unsub)

    return (
        <revealer
            $={self => {
                rev = self
                // slide in after the widget is realized; the row may be
                // destroyed before the idle runs (instant resolve, burst
                // past MAX_POPUPS) — guard like the card refs do
                idleAdd("popupRow:reveal", GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (rev) rev.revealChild = true
                    return GLib.SOURCE_REMOVE
                })
            }}
            transitionDuration={young ? 200 : 0}
            transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
        >
            <box
                cssClasses={["popup"]}
                orientation={Gtk.Orientation.VERTICAL}
                // fixed width: content-driven sizing made the whole stack
                // resize on every arrival/expiry
                widthRequest={Config.notifications.popupWidth}
            >
                <Gtk.EventControllerMotion
                    onEnter={() => hover(true)}
                    onLeave={() => hover(false)}
                />
                {entry.desktop ? (
                    <NotificationCard
                        n={entry.desktop}
                        onDismiss={() => {
                            removePopup(entry.key)
                            entry.desktop!.dismiss()
                        }}
                        onActivate={() => removePopup(entry.key)}
                    />
                ) : (
                    <ProviderCard
                        item={entry.item!}
                        onDismiss={() => {
                            removePopup(entry.key)
                            entry.item!.dismiss()
                        }}
                        onActivate={() => {
                            removePopup(entry.key)
                            entry.item!.activate()
                        }}
                        onHide={() => removePopup(entry.key)}
                    />
                )}
                <Gtk.DrawingArea
                    $={self => {
                        area = self
                        // heightRequest doesn't reach DrawingArea here
                        // (h=0 in the draw func) — set content size
                        self.set_content_height(3)
                        self.set_draw_func(drawBar)
                    }}
                    cssClasses={["timeoutBar"]}
                    hexpand
                />
            </box>
        </revealer>
    )
}
