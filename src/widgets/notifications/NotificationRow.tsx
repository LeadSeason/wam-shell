import { Gtk, Gdk } from "ags/gtk4"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import Pango from "gi://Pango?version=1.0"
import { relTime, timeTick } from "../../lib/notifd"
import { safeMarkup } from "../../lib/utils"

function isPath(image: string | null): image is string {
    return !!image && (image.startsWith("/") || image.startsWith("file://"))
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

function urgencyClass(n: AstalNotifd.Notification): string[] {
    switch (n.urgency) {
        case AstalNotifd.Urgency.CRITICAL: return ["critical"]
        case AstalNotifd.Urgency.LOW: return ["low"]
        default: return []
    }
}

export default function NotificationRow({ n }: { n: AstalNotifd.Notification }) {
    const image = n.get_image()
    const headerIcon = isPath(image)
        ? (n.get_app_icon() || "application-x-executable-symbolic")
        : (image || n.get_app_icon() || "application-x-executable-symbolic")
    const imageTexture = isPath(image)
        ? loadTexture(image.replace(/^file:\/\//, ""), 640, 240)
        : null

    const actions = n.get_actions().filter((a) => a.get_id() !== "default")
    const hasDefault = n.get_actions().some((a) => a.get_id() === "default")

    return <box
        cssClasses={["notification", ...urgencyClass(n)]}
        orientation={Gtk.Orientation.VERTICAL}
        spacing={6}
    >
        <box spacing={8}>
            <image iconName={headerIcon} pixelSize={24} valign={Gtk.Align.CENTER} />
            <label
                cssClasses={["appName"]}
                label={n.get_app_name() || "unknown"}
                xalign={0}
                ellipsize={Pango.EllipsizeMode.END}
            />
            <label
                cssClasses={["time"]}
                hexpand
                xalign={1}
                label={timeTick.as((now) => relTime(n.get_time(), now))}
            />
            <button cssClasses={["dismiss"]} onClicked={() => n.dismiss()}>
                <image iconName="window-close-symbolic" />
            </button>
        </box>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            {hasDefault &&
                <Gtk.GestureClick
                    button={1}
                    onReleased={() => n.invoke("default")}
                />
            }
            <label
                cssClasses={["summary"]}
                label={n.get_summary() || n.get_app_name()}
                xalign={0}
                maxWidthChars={34}
                ellipsize={Pango.EllipsizeMode.END}
            />
            {n.get_body() !== "" &&
                <label
                    cssClasses={["body"]}
                    label={safeMarkup(n.get_body())}
                    useMarkup
                    xalign={0}
                    wrap
                    maxWidthChars={40}
                />
            }
            {imageTexture &&
                // hard bound the image: the texture is pre-scaled at 2x
                // for hidpi, and Picture sizes itself to the texture —
                // on scale-1 displays that renders double size
                <box
                    cssClasses={["image"]}
                    widthRequest={320}
                    heightRequest={120}
                    overflow={Gtk.Overflow.HIDDEN}
                >
                    <Gtk.Picture
                        paintable={imageTexture}
                        contentFit={Gtk.ContentFit.COVER}
                        canShrink={true}
                    />
                </box>
            }
        </box>
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
}
