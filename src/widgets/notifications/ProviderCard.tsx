import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Graphene from "gi://Graphene?version=1.0"
import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import Pango from "gi://Pango?version=1.0"
import { createState } from "gnim"
import { ProviderItem } from "../../lib/notificationProviders"
import { isRtl } from "../../lib/utils"

// the thumbnail slot, in logical pixels
const THUMB_W = 192
const THUMB_H = 108

// Gtk.Picture asks for its texture's NATURAL size wherever the
// container has room — width/height-request only raise the minimum,
// they never cap. A youtube thumb (640x480 from the feed) therefore
// made a ~500px card, and four banners ran off the screen. So the
// pixbuf itself is scaled to exactly the slot: cover-scale, then
// centre-crop to the slot's aspect so a 4:3 thumb fills the 16:9 box
// instead of letterboxing. No 2x variant — a texture carries no scale
// factor in gtk4, so a 2x one would simply ask for a 2x-tall row
function loadTexture(path: string, width: number, height: number): Gdk.Texture | null {
    try {
        const [, srcW, srcH] = GdkPixbuf.Pixbuf.get_file_info(path)
        if (!srcW || !srcH) return null
        const scale = Math.max(width / srcW, height / srcH)
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
            path,
            Math.ceil(srcW * scale),
            Math.ceil(srcH * scale),
            true,
        )
        const cropW = Math.min(width, pixbuf.get_width())
        const cropH = Math.min(height, pixbuf.get_height())
        const x = Math.max(0, Math.floor((pixbuf.get_width() - cropW) / 2))
        const y = Math.max(0, Math.floor((pixbuf.get_height() - cropH) / 2))
        return Gdk.Texture.new_for_pixbuf(pixbuf.new_subpixbuf(x, y, cropW, cropH))
    } catch {
        return null
    }
}

// Row for provider items (GitHub & co.): same structure and CSS classes
// as NotificationCard so the list style stays in sync, minus thumbnails
// and action buttons — gestures: left click = activate (open + mark
// read), RIGHT click = dismiss (session hide), middle click / hover
// button = mark done. Gesture overrides let a host (the popup banner)
// attach its own bookkeeping (removing the banner) to the same gestures
export default function ProviderCard({
    item,
    onDismiss,
    onActivate,
    onHide,
    onAction,
}: {
    item: ProviderItem
    onDismiss?: () => void
    onActivate?: () => void
    onHide?: () => void
    // host bookkeeping for action buttons (the banner closes itself on
    // any action); return true to consume the id and skip the item's run()
    onAction?: (id: string) => boolean
}) {
    const dismiss = onDismiss ?? (() => item.dismiss())
    const activate = onActivate ?? (() => item.activate())
    const hideItem = onHide ?? (() => item.hide())
    const time = GLib.DateTime.new_from_unix_local(item.time)?.format("%H:%M") ?? ""
    const thumb = item.imagePath ? loadTexture(item.imagePath, THUMB_W, THUMB_H) : null
    // the whole card aligns by the summary's base direction (RTL titles
    // read from the right, like NotificationCard's)
    const rtl = isRtl(item.summary || item.appName)

    let card: Gtk.Box | null = null
    // buttons that must not trigger the whole-card click
    const interactiveButtons: Gtk.Widget[] = []
    let pressOnButton = false

    // dismiss button hides until the card is hovered. Driven by a motion
    // controller, not CSS :hover: layer-shell surfaces don't get reliable
    // :hover state
    const [hovered, setHovered] = createState(false)

    return (
        <box
            $={self => {
                card = self
            }}
            cssClasses={["notification", ...(rtl ? ["rtl"] : [])]}
            orientation={Gtk.Orientation.VERTICAL}
            spacing={6}
        >
            <Gtk.EventControllerMotion
                onEnter={() => setHovered(true)}
                onLeave={() => setHovered(false)}
            />
            <Gtk.GestureClick
                button={1}
                onPressed={(_g, _n, x, y) => {
                    pressOnButton = interactiveButtons.some(w => {
                        if (!card) return false
                        const [, rect] = w.compute_bounds(card)
                        return rect.contains_point(new Graphene.Point({ x, y }))
                    })
                }}
                onReleased={() => {
                    if (pressOnButton) return
                    activate()
                }}
            />
            {/* right click dismisses (session hide), middle marks done */}
            <Gtk.GestureClick button={3} onReleased={() => hideItem()} />
            <Gtk.GestureClick button={2} onReleased={dismiss} />
            <box spacing={6}>
                <image iconName={item.iconName} pixelSize={16} valign={Gtk.Align.CENTER} />
                <label
                    cssClasses={["appName"]}
                    label={item.appName}
                    xalign={0}
                    ellipsize={Pango.EllipsizeMode.END}
                />
                <label hexpand />
                {/* the timestamp and the dismiss button swap in the same
                slot on hover — no layout shift either way */}
                <label cssClasses={["time"]} label={time} visible={hovered.as(h => !h)} />
                <button
                    $={self => {
                        interactiveButtons.push(self)
                    }}
                    cssClasses={["dismiss"]}
                    visible={hovered}
                    tooltipText={"Mark done"}
                    onClicked={dismiss}
                >
                    <image iconName="window-close-symbolic" />
                </button>
            </box>
            {/* side-by-side media row: a card-height thumbnail left,
            text wrapping beside it on the right. The summary line is
            skipped when it just repeats the header's app name
            (YouTube's channel); the body gets up to 3 lines beside
            the image instead of truncating early */}
            <box spacing={8}>
                {thumb && (
                    <box
                        cssClasses={["image"]}
                        halign={Gtk.Align.START}
                        overflow={Gtk.Overflow.HIDDEN}
                    >
                        {/* the texture is already exactly the slot, so
                        these only guard a thumb that failed to crop */}
                        <Gtk.Picture
                            paintable={thumb}
                            contentFit={Gtk.ContentFit.COVER}
                            canShrink={true}
                            widthRequest={THUMB_W}
                            heightRequest={THUMB_H}
                        />
                    </box>
                )}
                <box
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={2}
                    valign={Gtk.Align.START}
                    hexpand
                >
                    {item.summary !== item.appName && (
                        <label
                            cssClasses={["summary"]}
                            label={item.summary}
                            xalign={rtl ? 1 : 0}
                            hexpand
                            maxWidthChars={30}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    )}
                    {item.body !== "" && (
                        <label
                            cssClasses={["body"]}
                            label={item.body}
                            xalign={rtl ? 1 : 0}
                            hexpand
                            maxWidthChars={30}
                            wrap
                            lines={3}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    )}
                </box>
            </box>
            {/* provider action buttons (todoist's done/postpone/dismiss):
            same .actions row as the desktop card */}
            {item.actions && item.actions.length > 0 && (
                <box cssClasses={["actions"]} spacing={6} hexpand halign={Gtk.Align.END}>
                    {item.actions.map(a => (
                        <button
                            $={self => {
                                interactiveButtons.push(self)
                            }}
                            onClicked={() => {
                                if (onAction?.(a.id)) return
                                a.run()
                            }}
                        >
                            <label label={a.label} />
                        </button>
                    ))}
                </box>
            )}
        </box>
    )
}
