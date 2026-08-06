import { Gtk, Gdk } from "ags/gtk4"
import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import Graphene from "gi://Graphene?version=1.0"
import Pango from "gi://Pango?version=1.0"
import { Accessor, onCleanup } from "gnim"
import { rtlAlign, safeMarkup } from "../../lib/utils"
import { relTime, nowSec } from "../../lib/relTime"
import type { RowData } from "./rowData"

// The banner card — deliberately NOT the card the notification center
// uses. The two surfaces answer different questions: a banner is read in
// the half-second it takes to decide whether to care, a center row is
// browsed. Sharing one component made the banner as tall and as detailed
// as a list row, so four of them became a wall down the side of the
// screen.
//
// So this one is horizontal-first: identity and headline on ONE line,
// body only when it says something the headline did not, and a countdown
// along the bottom edge. Several banners from one app arrive here as a
// single card with a count, and open into the rest on hover.

/** the artwork's bounding box, in logical pixels. The image is fitted
 *  INSIDE it rather than cropped to it: a square slot turned every 16:9
 *  thumbnail into a centre crop with its sides cut off, so album art
 *  came out square (72×72) and a video still came out letterboxed to
 *  nothing. Fitting means both arrive whole — 72×72 for a square source,
 *  96×54 for a widescreen one */
const ART_MAX_W = 96
const ART_MAX_H = 72
const ICON = 16
/** the countdown's thickness along the bottom edge */
const BAR = 3

function loadThumb(path: string): Gdk.Texture | null {
    try {
        const [, srcW, srcH] = GdkPixbuf.Pixbuf.get_file_info(path)
        if (!srcW || !srcH) return null
        // fit inside the box, never crop, never enlarge. Gtk.Picture asks
        // for its texture's natural size wherever the container has room,
        // so the texture has to BE the final size — sizing the widget
        // instead only raises a minimum and lets a 640px thumbnail set
        // the whole banner's width
        const scale = Math.min(ART_MAX_W / srcW, ART_MAX_H / srcH, 1)
        return Gdk.Texture.new_for_pixbuf(
            GdkPixbuf.Pixbuf.new_from_file_at_scale(
                path,
                Math.max(1, Math.round(srcW * scale)),
                Math.max(1, Math.round(srcH * scale)),
                true,
            ),
        )
    } catch {
        return null
    }
}

/**
 * The countdown, drawn along the banner's bottom edge.
 *
 * Rectangles, not an arc. A ring around the app icon was tried and
 * reverted: a collapsing revealer squashes its child toward zero height
 * a frame at a time, and `cairo_arc` with the negative radius that
 * produces segfaults gjs outright. A filled rectangle is well-defined at
 * every size the animation passes through, which is why this shape
 * survived years of use before it.
 *
 * @param countdown 1 -> 0 as the banner drains
 */
function TimeoutBar({ countdown, rtl }: { countdown: Accessor<number>; rtl: boolean }) {
    let area: Gtk.DrawingArea | null = null

    function draw(self: Gtk.DrawingArea, cr: any, w: number, h: number) {
        const c = self.get_color()
        const frac = Math.max(0, Math.min(1, countdown.get()))
        // the track, so the bar still reads as an edge once it is spent
        cr.setSourceRGBA(c.red, c.green, c.blue, 0.18)
        cr.rectangle(0, 0, w, h)
        cr.fill()
        if (frac <= 0.005) return
        // time runs out towards the end of the line, whichever end that
        // is: on a mirrored card a bar draining to the left would be
        // running backwards
        const width = w * frac
        cr.setSourceRGBA(c.red, c.green, c.blue, 0.95)
        cr.rectangle(rtl ? w - width : 0, 0, width, h)
        cr.fill()
    }

    const unsub = countdown.subscribe(() => area?.queue_draw())
    onCleanup(() => {
        unsub()
        area = null
    })

    return (
        <Gtk.DrawingArea
            $={self => {
                area = self
                // heightRequest does not reach a DrawingArea's draw
                // function (it arrives with h=0) — set content size
                self.set_content_height(BAR)
                self.set_draw_func(draw)
            }}
            cssClasses={["timeoutBar"]}
            hexpand
        />
    )
}

/**
 * One banner.
 *
 * @param countdown drives the bottom-edge bar, 1 -> 0
 * @param onAction invoked with an action id from the button row
 */
export default function Toast({
    data,
    countdown,
    timed,
    count = 1,
    onActivate,
    onDismiss,
    onAction,
}: {
    data: RowData
    countdown: Accessor<number>
    /** whether this banner expires at all. A critical one does not, and
     *  drawing its countdown anyway produced a bar pinned at full that
     *  never moved — which reads as a progress indicator that has hung,
     *  not as "this one is staying". The urgency spine already says it */
    timed: boolean
    /** how many banners from this app this one stands for; >1 draws the
     *  badge. The card shows the NEWEST of them */
    count?: number
    onActivate: () => void
    onDismiss: () => void
    onAction: (id: string) => void
}) {
    // the row aligns by the headline's base direction; the body needs an
    // explicit RLM so short LTR runs inside it follow suit
    const { rtl, summary: headline, body } = data
    const bodyMarkup = rtl ? rtlAlign(safeMarkup(body)) : safeMarkup(body)

    // Mirror the card for RTL. Applied to every box that packs
    // horizontally, not just the root: gtk does NOT push an explicitly
    // set direction down to children that never had one of their own, so
    // setting it on the outer (vertical) card alone changed nothing —
    // the icon, the artwork and the age all stayed on the left with the
    // Arabic shoved over to meet them
    const mirror = (self: Gtk.Widget) => {
        if (rtl) self.set_direction(Gtk.TextDirection.RTL)
    }
    const thumb = data.imagePath ? loadThumb(data.imagePath) : null

    let card: Gtk.Box | null = null
    // buttons must not also fire the whole-card click
    const buttons: Gtk.Widget[] = []
    let pressOnButton = false
    onCleanup(() => {
        card = null
    })

    return (
        <box
            $={self => {
                card = self
                mirror(self)
            }}
            cssClasses={[
                "toast",
                data.urgency,
                ...(rtl ? ["rtl"] : []),
                // no bar to sit above, so the body owes the bottom edge
                // the padding the bar was providing
                ...(timed ? [] : ["untimed"]),
            ]}
            // deliberately NOT overflow:HIDDEN. Clipping was the obvious
            // way to keep the full-bleed countdown inside the card's
            // rounded corners, but gtk clips to the square allocation:
            // the bar squared off the bottom corners and the drop shadow
            // came out as a rectangular halo around a rounded card. The
            // bar is inset in css instead, so it never reaches a corner
        >
            <Gtk.GestureClick
                button={1}
                onPressed={(_g, _n, x, y) => {
                    pressOnButton = buttons.some(w => {
                        if (!card) return false
                        const [, rect] = w.compute_bounds(card)
                        return rect.contains_point(new Graphene.Point({ x, y }))
                    })
                }}
                onReleased={() => {
                    if (!pressOnButton) onActivate()
                }}
            />
            {/* right or middle click anywhere dismisses */}
            <Gtk.GestureClick button={3} onReleased={onDismiss} />
            <Gtk.GestureClick button={2} onReleased={onDismiss} />

            {/* The urgency spine, as an inset pill rather than a border
            on the card. As a border it had to square that side off — a
            3px edge run around a 12px radius curls into both corners and
            reads as a parenthesis — which left the one card you most
            want to look ordinary-but-marked as the only differently
            shaped thing on screen. Inset, every card keeps the same
            silhouette and the mark is just a mark */}
            {data.urgency === "critical" && <box cssClasses={["spine"]} />}
            <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                <box cssClasses={["toastBody"]} spacing={10} $={mirror}>
                    <image
                        cssClasses={["appIcon"]}
                        iconName={data.iconName}
                        pixelSize={ICON}
                        valign={Gtk.Align.START}
                    />

                    <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
                        {/* identity and headline share one line: the app name is
                a label for the thing beside it, not a heading over it */}
                        <box spacing={6} $={mirror}>
                            <label
                                cssClasses={["appName"]}
                                label={data.appName || "unknown"}
                                xalign={0}
                                maxWidthChars={18}
                                ellipsize={Pango.EllipsizeMode.END}
                            />
                            {/* one card standing in for several from this app:
                    the badge is the only thing saying the others exist */}
                            {count > 1 && <label cssClasses={["count"]} label={String(count)} />}
                            {headline !== "" && (
                                <label
                                    cssClasses={["summary"]}
                                    label={headline}
                                    xalign={rtl ? 1 : 0}
                                    hexpand
                                    maxWidthChars={28}
                                    ellipsize={Pango.EllipsizeMode.END}
                                />
                            )}
                            {/* an empty headline still needs the time pushed to
                    the far edge */}
                            {headline === "" && <label hexpand />}
                            <label
                                cssClasses={["time"]}
                                label={nowSec.as(n => relTime(data.time, n))}
                                valign={Gtk.Align.START}
                            />
                        </box>
                        {body !== "" && (
                            <label
                                cssClasses={["body"]}
                                label={bodyMarkup}
                                useMarkup
                                xalign={rtl ? 1 : 0}
                                hexpand
                                maxWidthChars={44}
                                wrap
                                lines={2}
                                ellipsize={Pango.EllipsizeMode.END}
                            />
                        )}
                        {data.actions.length > 0 && (
                            <box
                                cssClasses={["actions"]}
                                spacing={6}
                                halign={Gtk.Align.START}
                                $={mirror}
                            >
                                {data.actions.map(a => (
                                    <button
                                        $={self => {
                                            buttons.push(self)
                                        }}
                                        onClicked={() => onAction(a.id)}
                                    >
                                        <label label={a.label} />
                                    </button>
                                ))}
                            </box>
                        )}
                    </box>

                    {thumb && (
                        <box
                            cssClasses={["thumb"]}
                            valign={Gtk.Align.CENTER}
                            // clipping is safe here: this box carries no shadow,
                            // so rounding its corners costs nothing (the CARD is
                            // the one that must not be clipped)
                            overflow={Gtk.Overflow.HIDDEN}
                        >
                            <Gtk.Picture paintable={thumb} contentFit={Gtk.ContentFit.CONTAIN} />
                        </box>
                    )}
                </box>

                {timed && <TimeoutBar countdown={countdown} rtl={rtl} />}
            </box>
        </box>
    )
}
