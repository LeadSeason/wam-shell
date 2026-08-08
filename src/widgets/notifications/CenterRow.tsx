import { Gtk, Gdk } from "ags/gtk4"
import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import Graphene from "gi://Graphene?version=1.0"
import Pango from "gi://Pango?version=1.0"
import { createState, onCleanup } from "gnim"
import { rtlAlign, safeMarkup } from "../../lib/utils"
import { relTime, nowSec } from "../../lib/relTime"
import { paintPress } from "../pressable"
import type { RowData } from "./rowData"

// The center's row — a browsing surface, where the banner is a glancing
// one. It can afford what a banner cannot: real artwork, a body worth
// reading, and an age that keeps counting up while you look at it.
//
// What it deliberately does NOT do is draw itself as a card. Every item
// having its own filled rectangle turned the list into banding — twelve
// slabs of identical weight where nothing led and nothing receded. The
// row paints only on hover; separation comes from the hairline between
// rows and from the type, which is what lets a long list stay readable.

/** the wide art slot (youtube thumbnails), in logical pixels */
const ART_W = 168
const ART_H = 94

// Gtk.Picture asks for its texture's natural size wherever the container
// has room — width/height-request raise the minimum and never cap — so
// the texture itself has to be exactly the slot: cover-scale, then
// centre-crop, so a 4:3 thumbnail fills a 16:9 box instead of
// letterboxing inside it
function loadArt(path: string): Gdk.Texture | null {
    try {
        const [, srcW, srcH] = GdkPixbuf.Pixbuf.get_file_info(path)
        if (!srcW || !srcH) return null
        const scale = Math.max(ART_W / srcW, ART_H / srcH)
        const scaled = GdkPixbuf.Pixbuf.new_from_file_at_scale(
            path,
            Math.ceil(srcW * scale),
            Math.ceil(srcH * scale),
            true,
        )
        const w = Math.min(ART_W, scaled.get_width())
        const h = Math.min(ART_H, scaled.get_height())
        const x = Math.max(0, Math.floor((scaled.get_width() - w) / 2))
        const y = Math.max(0, Math.floor((scaled.get_height() - h) / 2))
        return Gdk.Texture.new_for_pixbuf(scaled.new_subpixbuf(x, y, w, h))
    } catch {
        return null
    }
}

/**
 * One row in the notification center.
 *
 * @param dismissLabel what the hover button does — "Dismiss" for a
 *        desktop notification, "Mark done" for a provider item, which
 *        are genuinely different promises
 * @param onSecondary right-click: dismissal for a desktop notification,
 *        a session-scoped hide for a provider item
 */
export default function CenterRow({
    data,
    onActivate,
    onDismiss,
    onSecondary,
    onAction,
    dismissLabel = "Dismiss",
}: {
    data: RowData
    onActivate: () => void
    onDismiss: () => void
    onSecondary?: () => void
    onAction: (id: string) => void
    dismissLabel?: string
}) {
    const { rtl } = data
    const bodyMarkup = rtl ? rtlAlign(safeMarkup(data.body)) : safeMarkup(data.body)
    const art = data.imagePath ? loadArt(data.imagePath) : null

    // every box that packs horizontally has to be told: gtk does not
    // push an explicitly set direction down to children that never had
    // one, so setting it on the row alone leaves the icon and the age
    // stranded on the left (see the same note in Toast)
    const mirror = (self: Gtk.Widget) => {
        if (rtl) self.set_direction(Gtk.TextDirection.RTL)
    }

    let row: Gtk.Box | null = null
    const buttons: Gtk.Widget[] = []
    let pressOnButton = false
    onCleanup(() => {
        row = null
    })

    // the dismiss button appears on hover. Driven by a motion controller
    // rather than CSS :hover — layer-shell surfaces don't get reliable
    // :hover state
    const [hovered, setHovered] = createState(false)

    return (
        <box
            $={self => {
                row = self
                mirror(self)
            }}
            cssClasses={["centerRow", data.urgency, ...(rtl ? ["rtl"] : [])]}
        >
            <Gtk.EventControllerMotion
                onEnter={() => setHovered(true)}
                onLeave={() => setHovered(false)}
            />
            <Gtk.GestureClick
                button={1}
                onPressed={(g, _n, x, y) => {
                    pressOnButton = buttons.some(w => {
                        if (!row) return false
                        const [, rect] = w.compute_bounds(row)
                        return rect.contains_point(new Graphene.Point({ x, y }))
                    })
                    // the row is a box, so GTK paints no press for it
                    // (see pressable) — and it acts on RELEASE, which
                    // left the whole click unanswered until whatever
                    // the notification opens got around to appearing.
                    // Not on the row's own buttons: those are real
                    // buttons, and GTK already propagates their :active
                    // up into the row (measured), so the row lights
                    // either way — a second flag would only be one this
                    // handler then has to remember to clear
                    if (!pressOnButton) paintPress(g, true)
                }}
                onReleased={g => {
                    paintPress(g, false)
                    if (!pressOnButton) onActivate()
                }}
                onCancel={g => paintPress(g, false)}
                onEnd={g => paintPress(g, false)}
            />
            <Gtk.GestureClick button={3} onReleased={() => (onSecondary ?? onDismiss)()} />
            <Gtk.GestureClick button={2} onReleased={onDismiss} />

            {/* the urgency mark, inset rather than a border on the row —
            as a border it forced the row's corners square and made the
            one urgent item the only differently shaped thing in the
            list. Same reasoning as the banner's spine */}
            {data.urgency === "critical" && <box cssClasses={["spine"]} />}
            <box orientation={Gtk.Orientation.VERTICAL} spacing={4} hexpand>
                <box spacing={8} $={mirror}>
                    <image
                        cssClasses={["appIcon"]}
                        iconName={data.iconName}
                        pixelSize={16}
                        valign={Gtk.Align.START}
                    />
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={1} hexpand>
                        <box spacing={6} $={mirror}>
                            <label
                                cssClasses={["appName"]}
                                label={data.appName || "unknown"}
                                xalign={0}
                                maxWidthChars={20}
                                ellipsize={Pango.EllipsizeMode.END}
                            />
                            <label hexpand />
                            {/* the age and the dismiss button share one slot,
                        so hovering a row cannot shift the list under the
                        pointer */}
                            <label
                                cssClasses={["time"]}
                                label={nowSec.as(n => relTime(data.time, n))}
                                visible={hovered.as(h => !h)}
                            />
                            <button
                                $={self => {
                                    buttons.push(self)
                                }}
                                cssClasses={["dismiss"]}
                                visible={hovered}
                                tooltipText={dismissLabel}
                                onClicked={onDismiss}
                            >
                                <image iconName="window-close-symbolic" />
                            </button>
                        </box>
                        {data.summary !== "" && (
                            <label
                                cssClasses={["summary"]}
                                label={data.summary}
                                xalign={rtl ? 1 : 0}
                                hexpand
                                maxWidthChars={38}
                                wrap
                                lines={2}
                                ellipsize={Pango.EllipsizeMode.END}
                            />
                        )}
                        {data.body !== "" && (
                            <label
                                cssClasses={["body"]}
                                label={bodyMarkup}
                                useMarkup
                                xalign={rtl ? 1 : 0}
                                hexpand
                                maxWidthChars={44}
                                wrap
                                lines={3}
                                ellipsize={Pango.EllipsizeMode.END}
                            />
                        )}
                    </box>
                </box>

                {/* artwork sits under the text, indented to the text column:
            beside it, a 16:9 thumbnail would either squeeze the words
            into a gutter or set the row's height all by itself */}
                {art && (
                    <box
                        cssClasses={["art"]}
                        halign={Gtk.Align.START}
                        marginStart={24}
                        overflow={Gtk.Overflow.HIDDEN}
                    >
                        <Gtk.Picture
                            paintable={art}
                            contentFit={Gtk.ContentFit.COVER}
                            canShrink
                            widthRequest={ART_W}
                            heightRequest={ART_H}
                        />
                    </box>
                )}

                {data.actions.length > 0 && (
                    <box
                        cssClasses={["actions"]}
                        spacing={6}
                        marginStart={24}
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
        </box>
    )
}
