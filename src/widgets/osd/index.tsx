import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import app from "ags/gtk4/app"
import { createBinding, With } from "gnim"
import AstalHyprland from "gi://AstalHyprland"
import Config from "../../config"
import { content, visible } from "../../lib/osd"

const BAR_WIDTH = 160

export default function OSD({ gdkMonitor }: { gdkMonitor: Gdk.Monitor }) {
    const { TOP, BOTTOM } = Astal.WindowAnchor

    // show only on the focused monitor (hyprland); elsewhere primary
    let isFocused
    if (Config.desktopSession === "hyprland") {
        const hyprland = AstalHyprland.get_default()
        isFocused = createBinding(hyprland, "focusedMonitor").as(m =>
            m?.name === gdkMonitor.get_connector())
    } else {
        isFocused = app.monitors[0] === gdkMonitor
    }

    const anchor = Config.osd.position === "bottom" ? BOTTOM
        : Config.osd.position === "top" ? TOP : 0
    const margin = Config.osd.position === "center" ? {} :
        { [Config.osd.position === "bottom" ? "marginBottom" : "marginTop"]: 60 }

    let win: Astal.Window
    let rev: Gtk.Revealer
    let hideSource: number | null = null

    // drive window visibility from the lib state: present+reveal on show,
    // slide out and fully unmap on hide (a mapped window ghosts its last
    // frame on some compositors)
    visible.subscribe(() => {
        const focused = typeof isFocused === "boolean" ? isFocused : isFocused.get()
        if (!focused) return
        if (visible.get()) {
            if (hideSource !== null) {
                GLib.source_remove(hideSource)
                hideSource = null
            }
            win.present()
            rev.revealChild = true
        } else {
            rev.revealChild = false
            hideSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                hideSource = null
                win.hide()
                return GLib.SOURCE_REMOVE
            })
        }
    })

    return <window
        $={(self) => { win = self }}
        name="OSD"
        class="OSDWindow"
        namespace="osd"
        gdkmonitor={gdkMonitor}
        layer={Astal.Layer.OVERLAY}
        exclusivity={Astal.Exclusivity.IGNORE}
        keymode={Astal.Keymode.NONE}
        anchor={anchor}
        visible={false}
        application={app}
        {...margin}
    >
        <revealer
            $={(self) => { rev = self }}
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.CROSSFADE}
            transitionDuration={200}
        >
            <box cssClasses={["OSD"]} spacing={10} canTarget={false}>
                <image
                    iconName={content.as(c => c.icon)}
                    visible={content.as(c => c.icon !== "")}
                    cssClasses={content.as(c => c.over ? ["osdOn"] : ["osdOff"])}
                    pixelSize={20}
                />
                <With value={content}>
                    {(c) => c.value !== null &&
                        <box cssClasses={["osdBar"]} widthRequest={BAR_WIDTH}>
                            <box
                                cssClasses={c.over ? ["osdFill", "over"] : ["osdFill"]}
                                css={`min-width: ${Math.round((c.value ?? 0) * BAR_WIDTH)}px;`}
                            />
                        </box>}
                </With>
                <label
                    label={content.as(c => c.label)}
                    widthChars={4}
                />
            </box>
        </revealer>
    </window>
}
