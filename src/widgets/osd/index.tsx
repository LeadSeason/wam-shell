import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import app from "ags/gtk4/app"
import { createBinding, With } from "gnim"
import AstalHyprland from "gi://AstalHyprland"
import Config from "../../config"
import Sway from "../../lib/sway"
import { content, dismiss, hoverBlock, setHoverBlock, visible } from "../../lib/osd"

export default function OSD({ gdkMonitor }: { gdkMonitor: Gdk.Monitor }) {
    const { TOP, BOTTOM, LEFT } = Astal.WindowAnchor

    // show only on the focused monitor
    let isFocused
    if (Config.desktopSession === "hyprland") {
        const hyprland = AstalHyprland.get_default()
        isFocused = createBinding(hyprland, "focusedMonitor").as(m =>
            m?.name === gdkMonitor.get_connector())
    } else if (Config.desktopSession === "sway" || Config.desktopSession === "i3") {
        const sway = Sway.get_default()
        isFocused = sway.ok
            ? createBinding(sway, "outputs").as(outputs =>
                (outputs.find((o: any) => o.focused)?.name ?? null)
                === gdkMonitor.get_connector())
            : app.monitors[0] === gdkMonitor
    } else {
        isFocused = app.monitors[0] === gdkMonitor
    }

    // placement: bottom/top are centered horizontally, center fully
    // centered, topLeft hugs the corner (old-shell design)
    const anchor = Config.osd.position === "bottom" ? BOTTOM
        : Config.osd.position === "top" ? TOP
        : Config.osd.position === "topLeft" ? TOP | LEFT : 0
    const margin = Config.osd.position === "bottom" ? { marginBottom: 60 }
        : Config.osd.position === "top" ? { marginTop: 60 }
        : Config.osd.position === "topLeft" ? { marginTop: 20, marginLeft: 40 }
        : {}

    let win: Astal.Window
    let rev: Gtk.Revealer
    let hideSource: number | null = null

    // drive window visibility from the lib state AND focus: the pill
    // follows the focused monitor. Hiding must never be gated — a focus
    // change between show and hide, or a visible-stays-true trigger
    // streak on another monitor, must not leave the pill stuck.
    const update = () => {
        const focused = typeof isFocused === "boolean" ? isFocused : isFocused.get()
        if (visible.get() && focused) {
            if (hideSource !== null) {
                GLib.source_remove(hideSource)
                hideSource = null
            }
            win.present()
            rev.revealChild = true
        } else {
            rev.revealChild = false
            if (hideSource !== null) return
            hideSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                hideSource = null
                win.hide()
                return GLib.SOURCE_REMOVE
            })
        }
    }
    visible.subscribe(update)
    if (typeof isFocused !== "boolean") isFocused.subscribe(update)

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
        {/* click dismisses; hovering blocks the hide timer */}
        <Gtk.GestureClick button={1} onPressed={dismiss} />
        <Gtk.EventControllerMotion
            onEnter={() => setHoverBlock(true)}
            onLeave={() => setHoverBlock(false)}
        />
        <revealer
            $={(self) => { rev = self }}
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.CROSSFADE}
            transitionDuration={200}
        >
            <box cssClasses={content.as(c => ["OSD", `osd-${c.kind}`])} spacing={10} canTarget={false}>
                <image
                    iconName={content.as(c => c.icon)}
                    visible={content.as(c => c.icon !== "")}
                    cssClasses={content.as(c => c.over ? ["osdOn"] : ["osdOff"])}
                />
                <With value={content}>
                    {(c) => c.value !== null &&
                        <levelbar
                            $={(self) => {
                                // blocks past 100% get .overflow (peach)
                                self.add_offset_value("overflow", 1.0)
                            }}
                            valign={Gtk.Align.CENTER}
                            widthRequest={200}
                            value={content.as(c =>
                                Math.min(c.value ?? 0, c.valueMax))}
                            minValue={0}
                            maxValue={content.as(c => c.valueMax)}
                        />}
                </With>
                <label
                    label={content.as(c => c.label)}
                    widthChars={4}
                    maxWidthChars={36}
                    ellipsize={Pango.EllipsizeMode.END}
                />
            </box>
        </revealer>
    </window>
}
