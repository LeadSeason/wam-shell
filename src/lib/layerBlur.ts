import Config from "../config"
import { execAsync } from "./metrics"

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

// Fire-and-forget from app startup: if the apply fails the shell simply
// stays unfrosted, so failures warn and nothing is retried or gated on.
//
// Both hyprctl grammars — one lua `eval` on Hyprland 0.55+, one
// `keyword --batch` before that, the same split as lib/osd.ts. One
// process either way: 11 namespaces as separate spawns would be up to 22
// hyprctl processes on the startup path. The legacy spelling is the
// valued `ignorealpha` — `ignorezero` would reintroduce the blurred ring
// described above.
export function applyBlurRules(): void {
    if (!Config.appearance.blur) return
    if (Config.desktopSession !== "hyprland") {
        console.warn("blur: needs Hyprland's layer blur; surfaces stay opaque on this session")
        return
    }
    const all = [...NAMESPACES, `${Config.instanceName}Dialog`, `${Config.instanceName}QSettings`]
    const lua = all
        .map(
            ns =>
                `hl.layer_rule({ match = { namespace = "${ns}" }, blur = true });` +
                `hl.layer_rule({ match = { namespace = "${ns}" }, ignore_alpha = ${IGNORE_ALPHA} });`,
        )
        .join("")
    const legacy = all
        .flatMap(ns => [
            `keyword layerrule blur, ${ns}`,
            `keyword layerrule ignorealpha ${IGNORE_ALPHA}, ${ns}`,
        ])
        .join(" ; ")
    execAsync(["hyprctl", "eval", lua])
        .catch(() => execAsync(["hyprctl", "--batch", legacy]))
        .catch(e => console.warn("blur: could not apply layer rules:", e))
}
