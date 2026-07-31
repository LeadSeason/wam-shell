import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Graphene from "gi://Graphene?version=1.0"
import Pango from "gi://Pango?version=1.0"
import { createState } from "gnim"
import { ProviderItem } from "../../lib/notificationProviders"

// Row for provider items (GitHub & co.): same structure and CSS classes
// as NotificationCard so the list style stays in sync, minus thumbnails
// and action buttons — a provider item has exactly two gestures:
// left click = activate (open + mark read), hover button / middle
// click = dismiss. Gesture overrides let a host (the popup banner)
// attach its own bookkeeping (removing the banner) to the same gestures
export default function ProviderCard({
    item,
    onDismiss,
    onActivate,
}: {
    item: ProviderItem
    onDismiss?: () => void
    onActivate?: () => void
}) {
    const dismiss = onDismiss ?? (() => item.dismiss())
    const activate = onActivate ?? (() => item.activate())
    const time = GLib.DateTime.new_from_unix_local(item.time)?.format("%H:%M") ?? ""

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
            cssClasses={["notification"]}
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
            {/* middle click anywhere dismisses */}
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
            <box spacing={8}>
                <box
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={2}
                    valign={Gtk.Align.START}
                    hexpand
                >
                    <label
                        cssClasses={["summary"]}
                        label={item.summary}
                        xalign={0}
                        hexpand
                        maxWidthChars={34}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                    {item.body !== "" && (
                        <label
                            cssClasses={["body"]}
                            label={item.body}
                            xalign={0}
                            hexpand
                            maxWidthChars={40}
                            wrap
                            lines={2}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    )}
                </box>
            </box>
        </box>
    )
}
