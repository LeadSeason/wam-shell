import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import Pango from "gi://Pango?version=1.0"
import { createState, onCleanup } from "gnim"
import Config from "../../config"
import { anyPopupHovered, removePopup, setPopupHovered } from "../../lib/notifd"
import { safeMarkup } from "../../lib/utils"

function isPath(image: string | null): image is string {
    return !!image && (image.startsWith("/") || image.startsWith("file://"))
}

function urgencyClass(n: AstalNotifd.Notification): string[] {
    switch (n.urgency) {
        case AstalNotifd.Urgency.CRITICAL: return ["critical"]
        case AstalNotifd.Urgency.LOW: return ["low"]
        default: return []
    }
}

// the inline pill is plain text, so strip markup the body may carry
function stripMarkup(s: string): string {
    return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
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

const TICK_MS = 50
const RING_SIZE = 40

export default function PopupRow({ n }: { n: AstalNotifd.Notification }) {
    const image = n.get_image()
    const icon = isPath(image)
        ? (n.get_app_icon() || "application-x-executable-symbolic")
        : (image || n.get_app_icon() || "application-x-executable-symbolic")
    const imageTexture = isPath(image)
        ? loadTexture(image.replace(/^file:\/\//, ""), 600, 220)
        : null

    const actions = n.get_actions().filter((a) => a.get_id() !== "default")
    const hasDefault = n.get_actions().some((a) => a.get_id() === "default")
    const critical = n.urgency === AstalNotifd.Urgency.CRITICAL

    const summary = n.get_summary() || n.get_app_name()
    const body = n.get_body()

    const [hovered, setHovered] = createState(false)

    function hover(h: boolean) {
        setHovered(h)
        setPopupHovered(h)
    }
    // row destroyed while hovered (dismissed from center, replaced by a
    // burst, ...) must not leak the freeze count
    onCleanup(() => { if (hovered.get()) setPopupHovered(false) })
    onCleanup(() => { pillBox = null; hoverBox = null })

    // --- countdown: critical banners stick until dismissed -------------
    const total = Config.notifications.popupTimeout
    // low urgency drains faster; critical never drains
    const duration = n.urgency === AstalNotifd.Urgency.LOW ? total / 2 : total
    let remaining = duration
    let last = GLib.get_monotonic_time() / 1000 // us -> ms
    let expired = false
    let area: Gtk.DrawingArea | null = null

    function expire() {
        if (expired) return
        expired = true
        if (rev) rev.revealChild = false
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
            removePopup(n.id)
            return GLib.SOURCE_REMOVE
        })
    }

    // low urgency drains faster; critical never drains
    if (!critical) {
        let tick: number | null = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
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
        })
        onCleanup(() => { if (tick !== null) GLib.source_remove(tick) })
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
    let pillBox: Gtk.Box | null = null
    let hoverBox: Gtk.Box | null = null

    // the window is right-anchored, so if the unfolded state is narrower
    // than the pill, hovering visibly shifts the banner right. Pin the
    // hover state's min width to the pill's natural width: hover may
    // grow left, never shrink right.
    function syncWidth() {
        if (!pillBox || !hoverBox) return
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!pillBox || !hoverBox) return GLib.SOURCE_REMOVE
            const [, nat] = pillBox.measure(Gtk.Orientation.HORIZONTAL, -1)
            hoverBox.widthRequest = nat
            return GLib.SOURCE_REMOVE
        })
    }

    const inlineText = body !== ""
        ? `${summary}  ·  ${stripMarkup(body)}`
        : summary

    return <revealer
        $={(self) => {
            rev = self
            // slide in after the widget is realized
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                self.revealChild = true
                return GLib.SOURCE_REMOVE
            })
        }}
        transitionDuration={200}
        transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
    >
        <box
            cssClasses={hovered.as((h) => [
                "popup", ...urgencyClass(n), ...(h ? ["open"] : []),
            ])}
            spacing={8}
        >
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
                $={(self) => {
                    // gnim only keeps the first JSX child of an overlay;
                    // extra overlays are added imperatively (same pattern
                    // as SliderSection / swayNC)
                    self.add_overlay(new Gtk.Image({
                        iconName: icon,
                        pixelSize: 18,
                        halign: Gtk.Align.CENTER,
                        valign: Gtk.Align.CENTER,
                    }))
                }}
            >
                <Gtk.DrawingArea
                    $={(self) => {
                        area = self
                        self.set_draw_func(drawRing)
                    }}
                    cssClasses={["ring"]}
                    widthRequest={RING_SIZE}
                    heightRequest={RING_SIZE}
                />
            </overlay>
            {/* pill state: single truncated line */}
            <box
                $={(self) => { pillBox = self; syncWidth() }}
                valign={Gtk.Align.CENTER}
                visible={hovered.as((h) => !h)}
            >
                {hasDefault &&
                    <Gtk.GestureClick button={1} onReleased={() => n.invoke("default")} />
                }
                <label
                    cssClasses={["inline"]}
                    label={inlineText}
                    xalign={0}
                    maxWidthChars={56}
                    ellipsize={Pango.EllipsizeMode.END}
                />
            </box>
            {/* hover state: unfolds, timer frozen */}
            <box
                $={(self) => { hoverBox = self; syncWidth() }}
                orientation={Gtk.Orientation.VERTICAL}
                spacing={2}
                valign={Gtk.Align.CENTER}
                visible={hovered}
            >
                <box spacing={6}>
                    <label
                        cssClasses={["appName"]}
                        label={n.get_app_name() || "unknown"}
                        xalign={0}
                        hexpand
                    />
                    <button
                        cssClasses={["dismiss"]}
                        onClicked={() => {
                            removePopup(n.id)
                            n.dismiss()
                        }}
                    >
                        <image iconName="window-close-symbolic" />
                    </button>
                </box>
                {/* default-action click covers only the text, not the
                    header buttons or action pills */}
                <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                    {hasDefault &&
                        <Gtk.GestureClick button={1} onReleased={() => n.invoke("default")} />
                    }
                    <label
                        cssClasses={["summary"]}
                        label={summary}
                        xalign={0}
                        maxWidthChars={48}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                    {body !== "" &&
                        <label
                            cssClasses={["body"]}
                            label={safeMarkup(body)}
                            useMarkup
                            xalign={0}
                            wrap
                            maxWidthChars={60}
                        />
                    }
                </box>
                {imageTexture &&
                    <Gtk.Picture
                        cssClasses={["image"]}
                        paintable={imageTexture}
                        contentFit={Gtk.ContentFit.COVER}
                        canShrink={true}
                    />
                }
                {actions.length > 0 &&
                    <box cssClasses={["actions"]} spacing={6}>
                        {actions.map((a) =>
                            <button onClicked={() => n.invoke(a.get_id())}>
                                <label label={a.get_label()} />
                            </button>
                        )}
                    </box>
                }
            </box>
        </box>
    </revealer>
}
