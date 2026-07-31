import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Graphene from "gi://Graphene?version=1.0"
import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import Pango from "gi://Pango?version=1.0"
import { createState } from "gnim"
import { createIconResolver } from "../../lib/appIcon"
import { isRtl, rtlAlign, safeMarkup } from "../../lib/utils"

function isPath(image: string | null): image is string {
    return !!image && (image.startsWith("/") || image.startsWith("file://"))
}

// Gtk.Picture can never be shrunk below its texture's natural size by
// width/height-request, so scale the image data itself (2x for hidpi)
function loadTexture(path: string, size: number): Gdk.Texture | null {
    try {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, size, size, true)
        return Gdk.Texture.new_for_pixbuf(pixbuf)
    } catch {
        return null
    }
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

// Shared notification card (Marble-style composition): dimmed header
// (app icon + name, clock time, dismiss), thumbnail left, summary + body
// right. Used by the notification center and the transient popups.
export default function NotificationCard({
    n,
    onDismiss,
    onActivate,
}: {
    n: AstalNotifd.Notification
    onDismiss: () => void
    // left click with no default action (popups hide the banner; the
    // center passes nothing and ignores the click)
    onActivate?: () => void
}) {
    const resolveIcon = createIconResolver(
        Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!),
    )
    const image = n.get_image()
    const appIcon =
        n.get_app_icon() || resolveIcon(n.get_app_name()) || "application-x-executable-symbolic"
    // get_image() is either a file path (thumbnail) or an icon name
    const icon = isPath(image) ? appIcon : image || appIcon
    const imageTexture = isPath(image) ? loadTexture(image.replace(/^file:\/\//, ""), 96) : null

    const actions = n.get_actions().filter(a => a.get_id() !== "default")
    const hasDefault = n.get_actions().some(a => a.get_id() === "default")

    const summary = n.get_summary() || n.get_app_name()
    const body = n.get_body()
    // the whole card aligns by the summary's base direction; the body
    // needs an explicit RLM so small LTR lines follow it too
    const rtl = isRtl(summary)
    const bodyMarkup = rtl ? rtlAlign(safeMarkup(body)) : safeMarkup(body)

    const time = GLib.DateTime.new_from_unix_local(n.get_time())?.format("%H:%M") ?? ""

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
            cssClasses={["notification", ...urgencyClass(n), ...(rtl ? ["rtl"] : [])]}
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
                    if (hasDefault) n.invoke("default")
                    else onActivate?.()
                }}
            />
            {/* middle click anywhere dismisses */}
            <Gtk.GestureClick button={2} onReleased={onDismiss} />
            <box spacing={6}>
                <image iconName={icon} pixelSize={16} valign={Gtk.Align.CENTER} />
                <label
                    cssClasses={["appName"]}
                    label={n.get_app_name() || "unknown"}
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
                    tooltipText="Dismiss"
                    onClicked={onDismiss}
                >
                    <image iconName="window-close-symbolic" />
                </button>
            </box>
            <box spacing={8}>
                {/* the thumbnail slot is for real images only — the app
                icon already shows in the header */}
                {imageTexture && (
                    <box
                        cssClasses={["image"]}
                        widthRequest={48}
                        heightRequest={48}
                        valign={Gtk.Align.START}
                        overflow={Gtk.Overflow.HIDDEN}
                    >
                        <Gtk.Picture
                            paintable={imageTexture}
                            contentFit={Gtk.ContentFit.COVER}
                            canShrink={true}
                        />
                    </box>
                )}
                <box
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={2}
                    valign={Gtk.Align.START}
                    hexpand
                >
                    {/* maxWidthChars bounds the label's NATURAL width:
                    without it a long text grows the whole window past
                    popupWidth instead of wrapping. hexpand stretches the
                    label to the column's allocation, so the wrap happens
                    at the card's edge and no dead space remains */}
                    <label
                        cssClasses={["summary"]}
                        label={summary}
                        xalign={rtl ? 1 : 0}
                        hexpand
                        maxWidthChars={34}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                    {body !== "" && (
                        <label
                            cssClasses={["body"]}
                            label={bodyMarkup}
                            useMarkup
                            xalign={rtl ? 1 : 0}
                            hexpand
                            maxWidthChars={40}
                            wrap
                            lines={3}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    )}
                </box>
            </box>
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
    )
}
