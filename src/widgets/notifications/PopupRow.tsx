import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Graphene from "gi://Graphene?version=1.0"
import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import Pango from "gi://Pango?version=1.0"
import { createState, onCleanup } from "gnim"
import Config from "../../config"
import { anyPopupHovered, removePopup, setPopupHovered } from "../../lib/notifd"
import { isRtl, rtlAlign, safeMarkup } from "../../lib/utils"
import { timeoutAdd, sourceRemove } from "../../lib/metrics"

function isPath(image: string | null): image is string {
    return !!image && (image.startsWith("/") || image.startsWith("file://"))
}

function urgencyClass(n: AstalNotifd.Notification): string[] {
    switch (n.urgency) {
        case AstalNotifd.Urgency.CRITICAL:
            return ["critical"]
        case AstalNotifd.Urgency.LOW:
            return ["low"]
        default:
            return []
    }
}

// the inline pill is plain text, so strip markup the body may carry
function stripMarkup(s: string): string {
    return s
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
}

// Gtk.Picture can never be shrunk below its texture's natural size by
// width/height-request, so scale the image data itself (2x for hidpi)
function loadTexture(path: string, w: number, h: number): Gdk.Texture | null {
    try {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, w, h, true)
        return Gdk.Texture.new_for_pixbuf(pixbuf)
    } catch {
        return null
    }
}

// 200ms (5fps) is visually identical to 50ms for the countdown ring but
// a quarter of the queue_draw wakeups per banner
const TICK_MS = 200
const RING_SIZE = 40

export default function PopupRow({ n }: { n: AstalNotifd.Notification }) {
    const image = n.get_image()
    const icon = isPath(image)
        ? n.get_app_icon() || "application-x-executable-symbolic"
        : image || n.get_app_icon() || "application-x-executable-symbolic"
    const imageTexture = isPath(image)
        ? loadTexture(image.replace(/^file:\/\//, ""), 600, 220)
        : null

    const actions = n.get_actions().filter(a => a.get_id() !== "default")
    const hasDefault = n.get_actions().some(a => a.get_id() === "default")
    const critical = n.urgency === AstalNotifd.Urgency.CRITICAL

    const summary = n.get_summary() || n.get_app_name()
    const body = n.get_body()
    // the whole card aligns by the summary's base direction; the body
    // needs an explicit RLM so small LTR lines follow it too
    const rtl = isRtl(summary)
    const bodyMarkup = rtl ? rtlAlign(safeMarkup(body)) : safeMarkup(body)
    const inlineBody = rtl ? rtlAlign(stripMarkup(body)) : stripMarkup(body)

    const [hovered, setHovered] = createState(false)

    // collapse on leave is debounced: expanding shifts the layout
    // (small appName row takes the top), which can momentarily push
    // the pointer out of the widget and back in — without a grace
    // period that reads as a flicker loop
    let leaveSource: number | null = null
    function hover(h: boolean) {
        if (h) {
            if (leaveSource !== null) {
                sourceRemove(leaveSource)
                leaveSource = null
            }
            setHovered(true)
            setPopupHovered(true)
        } else if (leaveSource === null) {
            leaveSource = timeoutAdd("notifPopup:leaveDebounce", GLib.PRIORITY_DEFAULT, 150, () => {
                leaveSource = null
                setHovered(false)
                setPopupHovered(false)
                return GLib.SOURCE_REMOVE
            })
        }
    }
    // row destroyed while hovered (dismissed from center, replaced by a
    // burst, ...) must not leak the freeze count
    onCleanup(() => {
        if (leaveSource !== null) sourceRemove(leaveSource)
        if (hovered.get()) setPopupHovered(false)
    })
    onCleanup(() => {
        rev = null
    })

    // --- countdown: critical banners stick until dismissed -------------
    const total = Config.notifications.popupTimeout
    // low urgency drains faster; critical never drains
    const duration = n.urgency === AstalNotifd.Urgency.LOW ? total / 2 : total
    let remaining = duration
    let last = GLib.get_monotonic_time() / 1000 // us -> ms
    let expired = false
    let area: Gtk.DrawingArea | null = null

    let expireSource: number | null = null
    function expire() {
        if (expired) return
        expired = true
        if (rev) rev.revealChild = false
        expireSource = timeoutAdd("notifPopup:expire", GLib.PRIORITY_DEFAULT, 220, () => {
            expireSource = null
            removePopup(n.id)
            return GLib.SOURCE_REMOVE
        })
    }
    // the delayed removePopup above must not fire after the row is
    // gone (every other source here is already onCleanup-tracked)
    onCleanup(() => {
        if (expireSource !== null) sourceRemove(expireSource)
    })

    // low urgency drains faster; critical never drains
    if (!critical) {
        let tick: number | null = timeoutAdd(
            "notifPopup:ticker",
            GLib.PRIORITY_DEFAULT,
            TICK_MS,
            () => {
                const now = GLib.get_monotonic_time() / 1000
                if (!anyPopupHovered()) {
                    remaining -= now - last
                    area?.queue_draw()
                    if (remaining <= 0) {
                        expire()
                        tick = null
                        return GLib.SOURCE_REMOVE
                    }
                }
                last = now
                return GLib.SOURCE_CONTINUE
            },
        )
        onCleanup(() => {
            if (tick !== null) sourceRemove(tick)
        })
    }

    function drawRing(self: Gtk.DrawingArea, cr: any, w: number, h: number) {
        const c = self.get_color()
        const r = Math.min(w, h) / 2 - 2
        const cx = w / 2
        const cy = h / 2
        cr.setLineWidth(2.5)
        // track
        cr.arc(cx, cy, r, 0, Math.PI * 2)
        cr.setSourceRGBA(c.red, c.green, c.blue, 0.18)
        cr.stroke()
        // remaining
        const frac = critical ? 1 : Math.max(0, remaining / duration)
        if (frac > 0.005) {
            cr.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2)
            cr.setSourceRGBA(c.red, c.green, c.blue, 0.95)
            cr.stroke()
        }
    }

    let rev: Gtk.Revealer | null = null
    let outerBox: Gtk.Box | null = null
    // buttons that must not trigger the whole-card click
    const interactiveButtons: Gtk.Widget[] = []
    let pressOnButton = false

    return (
        <revealer
            $={self => {
                rev = self
                // slide in after the widget is realized; the row may be
                // destroyed before the idle runs (instant resolve, burst
                // past MAX_POPUPS) — guard like the pill/hover boxes do
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (rev) rev.revealChild = true
                    return GLib.SOURCE_REMOVE
                })
            }}
            transitionDuration={200}
            transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
        >
            <box
                $={self => {
                    outerBox = self
                }}
                cssClasses={hovered.as(h => ["popup", ...urgencyClass(n), ...(h ? ["open"] : [])])}
                // fixed width: content-driven sizing made the whole stack
                // resize on every arrival/expiry
                widthRequest={Config.notifications.popupWidth}
                // clip children to the (rounded) outline: during the
                // pill->card morph the square image would otherwise stick
                // out of the still-rounded border
                overflow={Gtk.Overflow.HIDDEN}
                spacing={8}
            >
                {/* the whole banner is clickable: invoke the default action,
                or dismiss the banner when there is none — except presses
                that land on the action/dismiss buttons */}
                <Gtk.GestureClick
                    button={1}
                    onPressed={(_g, _n, x, y) => {
                        pressOnButton = interactiveButtons.some(w => {
                            if (!outerBox) return false
                            const [, rect] = w.compute_bounds(outerBox)
                            return rect.contains_point(new Graphene.Point({ x, y }))
                        })
                    }}
                    onReleased={() => {
                        if (pressOnButton) return
                        if (hasDefault) n.invoke("default")
                        else removePopup(n.id)
                    }}
                />
                <Gtk.EventControllerMotion
                    onEnter={() => hover(true)}
                    onLeave={() => hover(false)}
                />
                {/* middle click anywhere dismisses */}
                <Gtk.GestureClick
                    button={2}
                    onReleased={() => {
                        removePopup(n.id)
                        n.dismiss()
                    }}
                />
                <overlay
                    valign={Gtk.Align.START}
                    $={self => {
                        // gnim only keeps the first JSX child of an overlay;
                        // extra overlays are added imperatively (same pattern
                        // as SliderSection / swayNC)
                        self.add_overlay(
                            new Gtk.Image({
                                iconName: icon,
                                pixelSize: 18,
                                halign: Gtk.Align.CENTER,
                                valign: Gtk.Align.CENTER,
                            }),
                        )
                    }}
                >
                    <Gtk.DrawingArea
                        $={self => {
                            area = self
                            self.set_draw_func(drawRing)
                        }}
                        cssClasses={["ring"]}
                        widthRequest={RING_SIZE}
                        heightRequest={RING_SIZE}
                    />
                </overlay>
                {/* pill state: bold summary on line one, body (plain,
                markup stripped) on line two when present. Same top
                lines as the expanded card, so unfolding only ever
                ADDS rows below — no content jump */}
                <box
                    orientation={Gtk.Orientation.VERTICAL}
                    valign={Gtk.Align.START}
                    visible={hovered.as(h => !h)}
                >
                    <box spacing={6}>
                        <label
                            cssClasses={["summary"]}
                            label={summary}
                            xalign={rtl ? 1 : 0}
                            hexpand
                            maxWidthChars={42}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    </box>
                    {body !== "" && (
                        <label
                            cssClasses={["inline"]}
                            label={inlineBody}
                            xalign={rtl ? 1 : 0}
                            maxWidthChars={42}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    )}
                </box>
                {/* hover state: unfolds, timer frozen */}
                <box
                    hexpand
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={2}
                    valign={Gtk.Align.START}
                    visible={hovered}
                >
                    <box spacing={6}>
                        <label
                            cssClasses={["summary"]}
                            label={summary}
                            xalign={rtl ? 1 : 0}
                            hexpand
                            maxWidthChars={42}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                        <button
                            $={self => {
                                interactiveButtons.push(self)
                            }}
                            cssClasses={["dismiss"]}
                            onClicked={() => {
                                removePopup(n.id)
                                n.dismiss()
                            }}
                        >
                            <image iconName="window-close-symbolic" />
                        </button>
                    </box>
                    {body !== "" && (
                        <label
                            cssClasses={["body"]}
                            label={bodyMarkup}
                            useMarkup
                            xalign={rtl ? 1 : 0}
                            wrap
                            maxWidthChars={42}
                            lines={4}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    )}
                    {imageTexture && (
                        // hard bound the image: the texture is pre-scaled at
                        // 2x for hidpi, and Picture sizes itself to the
                        // texture — on scale-1 displays that renders double
                        // size. The box clamps the height; hexpand lets it
                        // span the full card width (COVER crops).
                        <box
                            cssClasses={["image"]}
                            heightRequest={110}
                            hexpand
                            overflow={Gtk.Overflow.HIDDEN}
                        >
                            <Gtk.Picture
                                paintable={imageTexture}
                                contentFit={Gtk.ContentFit.COVER}
                                canShrink={true}
                            />
                        </box>
                    )}
                    {actions.length > 0 && (
                        <box cssClasses={["actions"]} spacing={6}>
                            {actions.map(a => (
                                <button
                                    $={self => {
                                        interactiveButtons.push(self)
                                    }}
                                    onClicked={() => n.invoke(a.get_id())}
                                >
                                    <label label={a.get_label()} />
                                </button>
                            ))}
                        </box>
                    )}
                </box>
            </box>
        </revealer>
    )
}
