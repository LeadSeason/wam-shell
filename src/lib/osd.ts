import GLib from "gi://GLib?version=2.0"
import AstalWp from "gi://AstalWp?version=0.1"
import { createState } from "gnim"
import { createBinding } from "gnim"
import { execAsync, timeoutAdd, sourceRemove } from "./metrics"
import Config from "../config"
import Brightness from "./brightness"
import hyprsunset, { OUTDOOR_GAMMA, refreshHyprsunset } from "./hyprsunset"
import { ensureLayoutSource, ensureLockSource, layoutOsdText, lockKeyState } from "./kbLayout"
import { watchDefaultEndpoint } from "./defaultEndpoint"
import { registerDispose } from "./lifecycle"

// OSD state and triggers. Widgets read `content`/`visible`; triggers
// call show() which (re)starts the hide timer.

export interface OsdContent {
    icon: string
    value: number | null // 0..1 for the bar, null = no bar
    label: string
    over: boolean // overdrive styling (>100%, outdoor, caps on)
    kind: string // volume|microphone|brightness|layout|lockKeys
}

export const [content, setContent] = createState<OsdContent>({
    icon: "",
    value: 0,
    label: "",
    over: false,
    kind: "",
})
export const [visible, setVisible] = createState(false)

let hideSource: number | null = null
// swallow trigger events fired at startup (initial binding values)
const graceUntil = Date.now() + 1500

// every long-lived subscription below lands here so dispose() can tear
// the module down in one place (convention for lib modules with
// long-lived sources, see AGENTS.md)
const disposers: (() => void)[] = []

type OsdKind = "volume" | "microphone" | "brightness" | "layout" | "lockKeys"

// ------------------------------------------------- layer-rule gating
//
// Hyprland matches layer rules when a layer surface is CREATED, so the
// no_anim rule below has to be installed before the OSD is first shown
// — otherwise the first pill of the session replays its last frame as a
// ghost on hide, which is the whole artifact the rule exists to remove.
//
// Applying it asynchronously is what keeps two hyprctl spawns off the
// startup path, and that is worth keeping; it just means a keypress can
// beat it. So the first show waits for the rule instead of racing it.
//
// Bounded, and deliberately so: if hyprctl hangs or never answers, an
// OSD with a ghost frame is a far better outcome than an OSD that never
// appears again. The wait ends either way.
const LAYER_RULE_WAIT_MS = 2000
const gatesOnLayerRule = Config.desktopSession === "hyprland" && Config.osd.enabled

let layerRuleSettled = !gatesOnLayerRule
let layerRuleTimeout = 0
// at most ONE held show, always the newest: replaying a volume level
// from before the rule landed would announce a value the user has
// already moved past
let pendingShow: (() => void) | null = null

function settleLayerRule() {
    if (layerRuleSettled) return
    layerRuleSettled = true
    if (layerRuleTimeout) {
        sourceRemove(layerRuleTimeout)
        layerRuleTimeout = 0
    }
    const queued = pendingShow
    pendingShow = null
    queued?.()
}

function show(c: Omit<OsdContent, "kind">, kind: OsdKind) {
    if (!Config.osd.enabled) return
    if (!Config.osd[kind]) return
    if (Date.now() < graceUntil) return
    if (!layerRuleSettled) {
        pendingShow = () => present(c, kind)
        return
    }
    present(c, kind)
}

function present(c: Omit<OsdContent, "kind">, kind: OsdKind) {
    setContent({ ...c, kind })
    setVisible(true)
    if (hideSource !== null) sourceRemove(hideSource)
    // the duration belongs to the kind, not the widget: a layout pill
    // that replaces a volume pill must take the layout timeout with it,
    // so this reads the map on every present rather than at startup
    const ms = Config.osd.timeouts[kind] ?? Config.osd.timeout
    hideSource = timeoutAdd("osd:hide", GLib.PRIORITY_DEFAULT, ms, () => {
        hideSource = null
        setVisible(false)
        return GLib.SOURCE_REMOVE
    })
}

// volume + microphone
function hookEndpoint(kind: "volume" | "microphone") {
    const mutedIcon =
        kind === "microphone"
            ? "microphone-sensitivity-muted-symbolic"
            : "audio-volume-muted-symbolic"
    let hooked: AstalWp.Endpoint | null = null
    let epDisposers: (() => void)[] = []
    // release the current endpoint's subscriptions (on re-hook and at
    // module teardown)
    const release = () => {
        for (const d of epDisposers) d()
        epDisposers = []
        hooked = null
    }
    const hook = (ep: AstalWp.Endpoint | null) => {
        if (ep === hooked) return
        // unsubscribe the old endpoint, its changes aren't the default's
        // (also when the default device disappears entirely: ep = null)
        release()
        hooked = ep
        if (!ep) return
        epDisposers.push(
            createBinding(ep, "volume").subscribe(() => {
                show(
                    {
                        icon: ep.mute ? mutedIcon : ep.volumeIcon,
                        value: Math.min(ep.volume, 1),
                        label: `${Math.round(ep.volume * 100)}%`,
                        over: ep.volume > 1.01,
                    },
                    kind,
                )
            }),
        )
        epDisposers.push(
            createBinding(ep, "mute").subscribe(() => {
                show(
                    {
                        icon: ep.mute ? mutedIcon : ep.volumeIcon,
                        value: ep.mute ? 0 : Math.min(ep.volume, 1),
                        label: ep.mute ? "Muted" : `${Math.round(ep.volume * 100)}%`,
                        over: false,
                    },
                    kind,
                )
            }),
        )
    }
    return { hook, release }
}

const wp = AstalWp.get_default()
if (wp?.audio) {
    const speaker = hookEndpoint("volume")
    disposers.push(
        // the real default endpoint, not the never-notifying proxy —
        // see lib/defaultEndpoint
        watchDefaultEndpoint(wp.audio, "speakers", ep => speaker.hook(ep)),
        speaker.release,
    )

    const mic = hookEndpoint("microphone")
    disposers.push(
        watchDefaultEndpoint(wp.audio, "microphones", ep => mic.hook(ep)),
        mic.release,
    )
}

// brightness (covers slider, scroll and external keybinds via the
// hyprsunset watcher)
const brightness = Brightness.get_default()
disposers.push(
    createBinding(brightness, "screen").subscribe(() => {
        // the gamma-dim seed is an async daemon read, not a keypress:
        // it lands whenever startup gets out of the way, which on a slow
        // cold login is past the 1.5s grace below — and then popped a
        // brightness banner nobody asked for. The flag says which it is
        if (!hyprsunset.initialReadDone.get()) return
        // the other reader of this flag, and the reason the watch does
        // not need to run while the quick settings are closed: refresh
        // when brightness actually changes. Async, so THIS osd still
        // uses the previous value and the next one is correct — which
        // beats the old behaviour of being up to 30s stale
        refreshHyprsunset()
        const outdoor = hyprsunset.outdoor.get()
        show(
            {
                icon: "display-brightness-symbolic",
                value: outdoor ? 1 : brightness.screen,
                label: outdoor ? `${OUTDOOR_GAMMA}%` : `${Math.round(brightness.screen * 100)}%`,
                over: outdoor,
            },
            "brightness",
        )
    }),
)

// keyboard layout switches (hyprland, sway, i3). The source is shared
// with the bar widget but does not depend on it being on any panel.
if (Config.osd.enabled && Config.osd.layout) {
    ensureLayoutSource()
    disposers.push(
        layoutOsdText.subscribe(() => {
            const text = layoutOsdText.get()
            if (!text) return
            show(
                {
                    icon: "", // flag only, no icon
                    value: null, // no bar, just the flag + name
                    label: text,
                    over: false,
                },
                "layout",
            )
        }),
    )
}

// the layer close/resize animation replays the OSD's last frame as a
// ghost on hide — disable animations for our namespace. lua configs
// (hyprland 0.55+) need eval, legacy hyprlang takes keyword.
//
// Async on purpose: these were two synchronous fork+exec+waits on the
// startup path (see the same change in lib/hyprsunset.ts). But not
// fire-and-forget — the rule has to be in place before the first layer
// surface is created, so show() waits on it (see the gating above).
// lua configs (hyprland 0.55+) need eval, legacy hyprlang takes keyword.
if (gatesOnLayerRule) {
    layerRuleTimeout = timeoutAdd(
        "osd:layerRuleWait",
        GLib.PRIORITY_DEFAULT,
        LAYER_RULE_WAIT_MS,
        () => {
            layerRuleTimeout = 0
            console.warn("osd: layer rule still not applied; showing anyway")
            settleLayerRule()
            return GLib.SOURCE_REMOVE
        },
    )
    execAsync([
        "hyprctl",
        "eval",
        `hl.layer_rule({ match = { namespace = "osd" }, no_anim = true })`,
    ])
        .catch(() => execAsync(["hyprctl", "keyword", "layerrule", "noanim, osd"]))
        .catch(e => console.warn("osd: could not disable layer animations:", e))
        // settled either way: a failed apply is still an answer, and the
        // OSD must not be held hostage to it
        .finally(settleLayerRule)
}

// caps/num lock. GDK4 reports the state on the keyboard device
// (notify::caps/num-lock-state), compositor-agnostic, so this works on
// every session; kbLayout's ensureLockSource publishes it as
// lockKeyState.
if (Config.osd.enabled && Config.osd.lockKeys) {
    ensureLockSource()
    // seed from the initial device read, or the first real toggle would
    // only fill prev and its banner would be swallowed
    let prev = lockKeyState.get()
    disposers.push(
        lockKeyState.subscribe(() => {
            const cur = lockKeyState.get()
            if (!cur) return
            if (prev && (cur.caps !== prev.caps || cur.num !== prev.num)) {
                // two independent checks: a tick where both flip must
                // not drop the num-lock banner behind the caps one
                if (cur.caps !== prev.caps) {
                    show(
                        {
                            icon: cur.caps ? "changes-prevent-symbolic" : "changes-allow-symbolic",
                            value: null,
                            label: "Caps Lock",
                            over: cur.caps, // tints the icon
                        },
                        "lockKeys",
                    )
                }
                if (cur.num !== prev.num) {
                    show(
                        {
                            icon: "input-keyboard-symbolic",
                            value: null,
                            label: `Num Lock ${cur.num ? "on" : "off"}`,
                            over: false,
                        },
                        "lockKeys",
                    )
                }
            }
            prev = cur
        }),
    )
}

// convention for lib modules with long-lived sources, even though the
// shell never calls it today: one place that tears everything down
export function dispose() {
    if (hideSource !== null) {
        sourceRemove(hideSource)
        hideSource = null
    }
    if (layerRuleTimeout) {
        sourceRemove(layerRuleTimeout)
        layerRuleTimeout = 0
    }
    // a show held for the rule must not fire against a torn-down module
    pendingShow = null
    for (const d of disposers) d()
    disposers.length = 0
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("osd", dispose)
