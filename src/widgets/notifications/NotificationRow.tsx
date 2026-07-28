import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio?version=2.0"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import Pango from "gi://Pango?version=1.0"
import { relTime, timeTick } from "../../lib/notifd"

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

export default function NotificationRow({ n }: { n: AstalNotifd.Notification }) {
    const image = n.get_image()
    const headerIcon = isPath(image)
        ? (n.get_app_icon() || "application-x-executable-symbolic")
        : (image || n.get_app_icon() || "application-x-executable-symbolic")

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
                    label={n.get_body()}
                    useMarkup
                    xalign={0}
                    wrap
                    maxWidthChars={40}
                />
            }
            {isPath(image) &&
                <Gtk.Picture
                    cssClasses={["image"]}
                    file={Gio.File.new_for_path(image.replace(/^file:\/\//, ""))}
                    contentFit={Gtk.ContentFit.COVER}
                    // bound both axes: under COVER the picture requests the
                    // image's full natural size otherwise
                    heightRequest={120}
                    widthRequest={320}
                />
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
