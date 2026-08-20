import GLib from "gi://GLib?version=2.0"
import AstalPowerProfiles from "gi://AstalPowerProfiles?version=0.1"
import Config, { isBlurSuspended, setBlurSuspended } from "../config"
import { connect, disconnect, execAsync } from "./metrics"
import { registerDispose } from "./lifecycle"
import { reloadStyle } from "./style"

// Frosted-glass surfaces (`[appearance] blur`). GTK has no backdrop blur,
// so the shell makes its window-level surfaces translucent (the
// `$surface-opacity` token — config.ts `surfaceOpacity()` keeps it at 1
// unless this module can deliver the blur) and asks the COMPOSITOR to
// blur whatever shows through. Hyprland only: sway has no layer blur, and
// translucency without blur behind it is just a washed-out shell.
//
// The rules are RUNTIME keywords: they apply to layer surfaces that
// already exist, so there is no startup ordering to gate (unlike the
// OSD's noanim rule, lib/osd.ts). Verified live on 0.56.2, where an
// ignore_alpha change landed on an OPEN popup without a restart. The flip
// side is that `hyprctl reload` drops them until the shell next starts;
// the persistent alternative — layerrule lines in hyprland.conf — is
// documented in wiki/Config-Appearance.md.
//
// Later rules override earlier ones per property, so suspension is a
// second round of rules with blur OFF, not a removal — also verified
// live on 0.56.2 (frost on the open bar disappeared on `blur = false`
// and returned on `blur = true`).

// every layer-shell window the shell can open, by namespace
// (dialog/QSettings key off the instance name, so they join at apply time)
const NAMESPACES = [
    "bar",
    "osd",
    "notification-popups",
    "notifications",
    "media-popup",
    "harvest-popup",
    "session-menu",
    "launcher",
    "bluetooth-pairing",
]

// ignore_alpha is a THRESHOLD: blur skips pixels at or below it. 0 (the
// legacy `ignorezero` idea) does nothing observable — a popup's
// transparent margin still frosts, leaving a blurred ring between the
// card and the sharp desktop at the window's bounding box. 0.4 sits
// above the drop shadow's peak alpha (0.35 dark themes, 0.12 light) and
// below the blur_opacity floor (0.5), so margins and the shadow zone
// stay sharp while the card itself frosts. Verified live on 0.56.2.
const IGNORE_ALPHA = 0.4

// Both hyprctl grammars — one lua `eval` on Hyprland 0.55+, one
// `keyword --batch` before that, the same split as lib/osd.ts. One
// process either way: 11 namespaces as separate spawns would be up to 22
// hyprctl processes on the startup path. The legacy spelling is the
// valued `ignorealpha` — `ignorezero` would reintroduce the blurred ring
// described above. ignore_alpha only matters with blur on; once blur is
// off a stale value is inert, so suspension sends blur alone.
function ruleCommands(blurOn: boolean): { lua: string; legacy: string } {
    const all = [...NAMESPACES, `${Config.instanceName}Dialog`, `${Config.instanceName}QSettings`]
    const lua =
        all
            .map(ns => `hl.layer_rule({ match = { namespace = "${ns}" }, blur = ${blurOn} });`)
            .join("") +
        (blurOn
            ? all
                  .map(
                      ns =>
                          `hl.layer_rule({ match = { namespace = "${ns}" }, ignore_alpha = ${IGNORE_ALPHA} });`,
                  )
                  .join("")
            : "")
    // blur on keeps the proven flag spelling; blur OFF needs the valued
    // form, which pre-0.55 Hyprland may reject — the .catch below warns
    // and the shell simply stays frosted there until a restart
    const legacy = all
        .flatMap(ns => [
            `keyword layerrule ${blurOn ? "blur" : "blur 0"}, ${ns}`,
            ...(blurOn ? [`keyword layerrule ignorealpha ${IGNORE_ALPHA}, ${ns}`] : []),
        ])
        .join(" ; ")
    return { lua, legacy }
}

// Fire-and-forget: if the apply fails the shell simply stays unfrosted
// (or frosted, when suspending), so failures warn and nothing is retried
// or gated on.
function setBlurRules(blurOn: boolean): void {
    const { lua, legacy } = ruleCommands(blurOn)
    execAsync(["hyprctl", "eval", lua])
        .catch(() => execAsync(["hyprctl", "--batch", legacy]))
        .catch(e => console.warn("blur: could not apply layer rules:", e))
}

export function applyBlurRules(): void {
    if (!Config.appearance.blur) return
    if (Config.desktopSession !== "hyprland") {
        console.warn("blur: needs Hyprland's layer blur; surfaces stay opaque on this session")
        return
    }
    setBlurRules(!isBlurSuspended())
}

// The quick settings close ghost: Hyprland's layer fade-out replays the
// surface's last committed buffer, and the revealer's settled collapse
// paints the media card ALONE (its art's min-height survives the
// zero-height allocation that blanks every other section), so the player
// lingered as a fading ghost on every close. no_anim takes the
// compositor animation out of it; the open/close motion that survives is
// the GTK-side reveal slide, which is unaffected. Same artifact and same
// cure as the OSD's no_anim rule (lib/osd.ts), except QS hides on every
// close rather than once per session, so there is no first-show gate —
// the rule is fire-and-forget at startup, and runtime application lands
// on the existing surface (verified live on 0.56.2).
export function applyQSettingsNoAnim(): void {
    if (Config.desktopSession !== "hyprland") return
    const ns = `${Config.instanceName}QSettings`
    execAsync([
        "hyprctl",
        "eval",
        `hl.layer_rule({ match = { namespace = "${ns}" }, no_anim = true })`,
    ])
        .catch(() => execAsync(["hyprctl", "keyword", "layerrule", `noanim, ${ns}`]))
        .catch(e => console.warn("qsettings: could not apply no_anim layer rule:", e))
}

// [appearance] blur_in_powersaver = false: while power-profiles-daemon
// sits on the power-saver profile the frost is suspended — the sheet
// recompiles opaque (config.ts surfaceOpacity) and the compositor rules
// flip off, because a blur the user cannot see would still cost the GPU.
// Nothing persists: the state is re-derived from the daemon on every
// shell start.
let powerProfiles: AstalPowerProfiles.PowerProfiles | null = null
let profileListener = 0

export function initPowerSaverBlur(): void {
    if (!Config.appearance.blur || Config.appearance.blurInPowersaver) return
    if (Config.desktopSession !== "hyprland") return
    // the CLI ships with the daemon; without it there is no profile to
    // follow (the same probe the QSettings power-mode widget gates on)
    if (GLib.find_program_in_path("powerprofilesctl") === null) return
    const pp = AstalPowerProfiles.get_default()
    const update = () => {
        const suspend = pp.activeProfile === "power-saver"
        if (suspend === isBlurSuspended()) return
        setBlurSuspended(suspend)
        setBlurRules(!suspend)
        // restyle through the style-reload path: the opacity lives in
        // the compiled sheet (active-tuning.scss), so a token change
        // alone reaches no widget
        reloadStyle()
    }
    // seed WITHOUT the restyle/rules round: app startup calls this
    // before applyBlurRules and before the first compile, both of which
    // read the seeded state on their own
    setBlurSuspended(pp.activeProfile === "power-saver")
    powerProfiles = pp
    profileListener = connect(pp, "notify::active-profile", update)
    registerDispose("layerBlur", dispose)
}

function dispose(): void {
    if (powerProfiles !== null && profileListener !== 0) disconnect(powerProfiles, profileListener)
    powerProfiles = null
    profileListener = 0
}
