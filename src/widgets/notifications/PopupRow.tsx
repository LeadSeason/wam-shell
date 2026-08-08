import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import { createState, onCleanup } from "gnim"
import { idleAdd } from "../../lib/metrics"
import Config from "../../config"
import {
    POPUP_SLIDE_IN_MS,
    PopupEntry,
    popupArrivals,
    popupTimer,
    popupTimerVersion,
    removePopupDeferred,
    setPopupHovered,
} from "../../lib/notifd"
import Toast from "./Toast"
import { fromDesktop, fromItem } from "./rowData"

// Pure view over the popup controller in lib/notifd: the countdown,
// expiry and hover-freeze live there, so rows like this one can be
// destroyed and rebuilt on monitor focus switches without consequence.
// What is left here is the wiring — which gesture means what for each
// kind of notification — while the banner itself takes one normalised
// shape and never branches on where it came from.

/**
 * One banner.
 *
 * @param group every live banner this card stands for, newest first.
 *        Usually one; more when several arrived from the same app and
 *        were folded together. The card shows group[0] and the whole
 *        group shares its fate — dismissing the card dismisses all of
 *        them, because dismissing "Syncthing ×3" and getting Syncthing
 *        ×2 back would be a card that refuses to go away
 */
export default function PopupRow({ group }: { group: PopupEntry[] }) {
    const entry = group[0]
    // hovering ANY banner freezes every countdown: if a banner above the
    // hovered one expired mid-interaction, the stack would shift and yank
    // the hovered banner out from under the pointer
    let hovered = false
    function hover(h: boolean) {
        if (h === hovered) return
        hovered = h
        setPopupHovered(h)
        setOpen(h)
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

    // the banner slides in only when it is new — a row rebuilt on a
    // monitor switch appears instantly (0ms transition)
    const t = popupTimer(entry.key)
    const young = t !== null && GLib.get_monotonic_time() / 1000 - t.addedAt < POPUP_SLIDE_IN_MS

    // 1 -> 0 as the banner drains. A banner that never expires (critical)
    // holds at 1, which the bar draws as a full edge
    const countdownFor = (key: string) =>
        popupTimerVersion.as(() => {
            const timer = popupTimer(key)
            return !timer || timer.duration === 0
                ? 1
                : Math.max(0, timer.remaining / timer.duration)
        })
    const countdown = countdownFor(entry.key)

    // a folded group opens on hover. The badge alone said how many were
    // behind the card without offering any way to read them, which is
    // the one thing a count is no substitute for. Hovering already
    // freezes every countdown, so the drawer cannot drain while it is
    // open
    const [open, setOpen] = createState(false)

    // collapse when the controller says this one is expiring
    const unsub = popupTimerVersion.subscribe(() => {
        if (popupTimer(entry.key)?.expiring && rev) rev.revealChild = false
    })
    onCleanup(unsub)

    // Every card answers for itself, the header card included.
    //
    // The header used to dismiss the whole group, on the theory that
    // dismissing "Syncthing ×3" and being handed Syncthing ×2 is a card
    // that refuses to leave. That reasoning does not survive the drawer:
    // reaching the header means hovering it, hovering opens the drawer,
    // so by the time anything can be clicked the header is not standing
    // in for the others any more — they are right there underneath it,
    // and taking them with it destroys notifications nobody acted on.
    //
    // Removing a banner is not dismissing its notification either: it
    // only ends its time on screen, and it stays in the center.
    // Every one of these runs inside a click, on the widget the click is
    // being delivered to, and removing the banner destroys that widget —
    // the shape behind GNOME/gtk#3090. removePopupDeferred pushes the
    // teardown one idle turn out, past GTK's crossing-event synthesis;
    // see the note on it in lib/notifd. The action itself still fires
    // immediately, which is what the user actually asked for.
    const handlers = (p: PopupEntry) => ({
        onActivate: () => {
            removePopupDeferred(p.key)
            if (p.desktop) {
                if (p.desktop.get_actions().some(a => a.get_id() === "default"))
                    p.desktop.invoke("default")
            } else {
                p.item!.activate()
            }
        },
        onDismiss: () => {
            removePopupDeferred(p.key)
            if (p.desktop) p.desktop.dismiss()
            else p.item!.dismiss()
        },
        onAction: (id: string) => {
            removePopupDeferred(p.key)
            if (p.desktop) {
                p.desktop.invoke(id)
                return
            }
            // every action closes the banner; "dismiss" is consumed here
            // so the item survives in the center rather than being
            // marked done
            if (id === "dismiss") return
            p.item!.actions?.find(a => a.id === id)?.run()
        },
    })

    const data = entry.desktop ? fromDesktop(entry.desktop) : fromItem(entry.item!)
    // a banner with no timer draws no countdown: a bar pinned at full
    // that never moves reads as a stalled progress indicator
    const timedFor = (key: string) => (popupTimer(key)?.duration ?? 0) !== 0

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
                spacing={6}
                // fixed width: content-driven sizing made the whole stack
                // resize on every arrival and expiry
                widthRequest={Config.notifications.popupWidth}
            >
                <Gtk.EventControllerMotion
                    onEnter={() => hover(true)}
                    onLeave={() => hover(false)}
                />
                <Toast
                    data={data}
                    countdown={countdown}
                    timed={timedFor(entry.key)}
                    // what the app has RAISED this burst, not what
                    // survived the cap: ten arrivals read "10", where
                    // group.length silently topped out at MAX_POPUPS
                    count={popupArrivals(entry)}
                    {...handlers(entry)}
                />
                {/* the rest of the group, dealt out on hover. Indented
                so the card above still reads as the one that stands for
                them */}
                {group.length > 1 && (
                    <revealer
                        revealChild={open}
                        transitionDuration={150}
                        transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                    >
                        <box
                            $={self => {
                                // the direction has to be set on THIS
                                // box, not an ancestor: marginStart is
                                // resolved against the widget's own
                                // direction, and gtk does not push an
                                // explicitly set direction down to
                                // children that never had one
                                if (data.rtl) self.set_direction(Gtk.TextDirection.RTL)
                            }}
                            cssClasses={["drawer"]}
                            orientation={Gtk.Orientation.VERTICAL}
                            spacing={6}
                            // marginStart, not a css margin-left: this
                            // follows the text direction, so a mirrored
                            // drawer indents from the right like its
                            // header does
                            marginStart={16}
                        >
                            {group.slice(1).map(p => (
                                <Toast
                                    data={p.desktop ? fromDesktop(p.desktop) : fromItem(p.item!)}
                                    countdown={countdownFor(p.key)}
                                    timed={timedFor(p.key)}
                                    {...handlers(p)}
                                />
                            ))}
                        </box>
                    </revealer>
                )}
            </box>
        </revealer>
    )
}
