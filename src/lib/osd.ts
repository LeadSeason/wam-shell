import GLib from "gi://GLib?version=2.0"
import AstalWp from "gi://AstalWp?version=0.1"
import { createState } from "gnim"
import { createBinding } from "gnim"
import { exec, execAsync } from "ags/process"
import Config from "../config"
import Brightness from "./brightness"
import hyprsunset, { OUTDOOR_GAMMA } from "./hyprsunset"
import { ensureLayoutSource, layoutOsdText } from "./kbLayout"

// OSD state and triggers. Widgets read `content`/`visible`; triggers
// call show() which (re)starts the hide timer.

export interface OsdContent {
    icon: string
    value: number | null  // 0..1 for the bar, null = no bar
    label: string
    over: boolean  // overdrive styling (>100%, outdoor, caps on)
    kind: string   // volume|microphone|brightness|layout|lockKeys
}

export const [content, setContent] = createState<OsdContent>({
    icon: "", value: 0, label: "", over: false, kind: "",
})
export const [visible, setVisible] = createState(false)

let hideSource: number | null = null
// swallow trigger events fired at startup (initial binding values)
const graceUntil = Date.now() + 1500

type OsdKind = "volume" | "microphone" | "brightness" | "layout" | "lockKeys"

function show(c: Omit<OsdContent, "kind">, kind: OsdKind) {
    if (!Config.osd.enabled) return
    if (!Config.osd[kind]) return
    if (Date.now() < graceUntil) return
    setContent({ ...c, kind })
    setVisible(true)
    if (hideSource !== null) GLib.source_remove(hideSource)
    hideSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Config.osd.timeout, () => {
        hideSource = null
        setVisible(false)
        return GLib.SOURCE_REMOVE
    })
}

// volume + microphone
function hookEndpoint(
    getEndpoint: () => AstalWp.Endpoint | null,
    kind: "volume" | "microphone",
) {
    const mutedIcon = kind === "microphone"
        ? "microphone-sensitivity-muted-symbolic"
        : "audio-volume-muted-symbolic"
    let hooked: AstalWp.Endpoint | null = null
    let disposers: (() => void)[] = []
    const hook = (ep: AstalWp.Endpoint | null) => {
        if (!ep || ep === hooked) return
        // unsubscribe the old endpoint, its changes aren't the default's
        for (const d of disposers) d()
        disposers = []
        hooked = ep
        disposers.push(createBinding(ep, "volume").subscribe(() => {
            show({
                icon: ep.mute ? mutedIcon : ep.volumeIcon,
                value: Math.min(ep.volume, 1),
                label: `${Math.round(ep.volume * 100)}%`,
                over: ep.volume > 1.01,
            }, kind)
        }))
        disposers.push(createBinding(ep, "mute").subscribe(() => {
            show({
                icon: ep.mute ? mutedIcon : ep.volumeIcon,
                value: ep.mute ? 0 : Math.min(ep.volume, 1),
                label: ep.mute ? "Muted" : `${Math.round(ep.volume * 100)}%`,
                over: false,
            }, kind)
        }))
    }
    return hook
}

const wp = AstalWp.get_default()
if (wp) {
    const { audio } = wp
    const hookSpeaker = hookEndpoint(
        () => audio.defaultSpeaker, "volume")
    createBinding(audio, "defaultSpeaker").subscribe(() => {
        hookSpeaker(audio.defaultSpeaker)
    })
    hookSpeaker(audio.defaultSpeaker)

    const hookMic = hookEndpoint(
        () => audio.defaultMicrophone, "microphone")
    createBinding(audio, "defaultMicrophone").subscribe(() => {
        hookMic(audio.defaultMicrophone)
    })
    hookMic(audio.defaultMicrophone)
}

// brightness (covers slider, scroll and external keybinds via the
// hyprsunset watcher)
const brightness = Brightness.get_default()
createBinding(brightness, "screen").subscribe(() => {
    const outdoor = hyprsunset.outdoor.get()
    show({
        icon: "display-brightness-symbolic",
        value: outdoor ? 1 : brightness.screen,
        label: outdoor ? `${OUTDOOR_GAMMA}%` : `${Math.round(brightness.screen * 100)}%`,
        over: outdoor,
    }, "brightness")
})

// keyboard layout switches (hyprland, sway, i3). The source is shared
// with the bar widget but does not depend on it being on any panel.
ensureLayoutSource()
layoutOsdText.subscribe(() => {
    const text = layoutOsdText.get()
    if (!text) return
    show({
        icon: "", // flag only, no icon
        value: null, // no bar, just the flag + name
        label: text,
        over: false,
    }, "layout")
})

// the layer close/resize animation replays the OSD's last frame as a
// ghost on hide — disable animations for our namespace. lua configs
// (hyprland 0.55+) need eval, legacy hyprlang takes keyword.
if (Config.desktopSession === "hyprland" && Config.osd.enabled) {
    try {
        exec(`hyprctl eval 'hl.layer_rule({ match = { namespace = "osd" }, no_anim = true })'`)
    } catch {
        try { exec(`hyprctl keyword layerrule "noanim, osd"`) } catch { }
    }
}

// caps/num lock (hyprland only, no event exists — poll and diff).
// execAsync: a synchronous hyprctl call on a timer can stall the main loop
if (Config.desktopSession === "hyprland" && Config.osd.enabled && Config.osd.lockKeys) {
    let prev: { caps: boolean, num: boolean } | null = null
    let running = false
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
        if (running) return GLib.SOURCE_CONTINUE
        running = true
        execAsync("hyprctl devices -j").then((out) => {
            const devices = JSON.parse(out)
            const kb = devices.keyboards.find((k: any) => k.main)
                ?? devices.keyboards[0]
            if (!kb) return
            const cur = { caps: !!kb.capsLock, num: !!kb.numLock }
            if (prev && (cur.caps !== prev.caps || cur.num !== prev.num)) {
                if (cur.caps !== prev.caps) {
                    show({
                        icon: cur.caps
                            ? "changes-prevent-symbolic"
                            : "changes-allow-symbolic",
                        value: null,
                        label: "Caps Lock",
                        over: cur.caps, // tints the icon
                    }, "lockKeys")
                } else {
                    show({
                        icon: "input-keyboard-symbolic",
                        value: null,
                        label: `Num Lock ${cur.num ? "on" : "off"}`,
                        over: false,
                    }, "lockKeys")
                }
            }
            prev = cur
        }).catch(() => { }).finally(() => { running = false })
        return GLib.SOURCE_CONTINUE
    })
}
