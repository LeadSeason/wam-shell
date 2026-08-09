import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { createState } from "gnim"
import Config from "../config"
import CommandRegistry from "./commandRegistry"
import { registerDispose } from "./lifecycle"
import { execAsync } from "./metrics"
import { notify } from "./notify"

// Screenshots and screen recording.
//
// The shell already KNEW about screenshots before it could take one:
// `lib/popupFocus` watches for a picker layer surface (slurp and
// friends) so the popups do not vanish out of the frame mid-grab. It
// just had no way to start one, so every user wired grim and slurp into
// their compositor config by hand and the shell's own knowledge of what
// was happening went unused.
//
// grim/slurp/wf-recorder rather than the desktop portal: the portal
// route means a permission dialog per grab on wlroots compositors, and
// these three are what the users of this shell already have installed
// for exactly this job.

export type ShotMode = "region" | "window" | "screen"

const has = (bin: string) => GLib.find_program_in_path(bin) !== null

const [recording, setRecording] = createState(false)
/** Is a screen recording running right now? */
export { recording }

let recorder: Gio.Subprocess | null = null

function stamp(): string {
    // "2026-08-09_17-42-05" — sorts chronologically as text, and carries
    // no colons, which are legal in a filename right up until the file
    // meets a filesystem that disagrees
    return GLib.DateTime.new_now_local().format("%Y-%m-%d_%H-%M-%S") ?? "capture"
}

function outputDir(kind: "Screenshots" | "Recordings"): string {
    const base =
        GLib.get_user_special_dir(
            kind === "Screenshots"
                ? GLib.UserDirectory.DIRECTORY_PICTURES
                : GLib.UserDirectory.DIRECTORY_VIDEOS,
        ) ?? GLib.get_home_dir()
    const dir = `${base}/${kind}`
    try {
        GLib.mkdir_with_parents(dir, 0o755)
    } catch (e) {
        console.warn(`capture: could not create ${dir}:`, e)
    }
    return dir
}

/**
 * The geometry to capture, as grim's `-g` takes it ("x,y WxH").
 *
 * `null` means "the whole focused output", which grim expresses as `-o`
 * instead — and `undefined` means the user cancelled, which is not an
 * error and must not produce a file, a notification or a log line.
 */
async function geometryFor(mode: ShotMode): Promise<string | null | undefined> {
    if (mode === "screen") return null
    if (mode === "region") {
        try {
            const out = await execAsync(["slurp"])
            const geom = out.trim()
            return geom === "" ? undefined : geom
        } catch {
            // slurp exits non-zero when the selection is cancelled
            return undefined
        }
    }

    // window: ask the compositor where the focused one is, rather than
    // making the user draw a rectangle around something the compositor
    // can already measure exactly
    try {
        if (Config.desktopSession === "hyprland") {
            const info = JSON.parse(await execAsync(["hyprctl", "activewindow", "-j"]))
            const at = info?.at
            const size = info?.size
            if (!Array.isArray(at) || !Array.isArray(size)) return undefined
            return `${at[0]},${at[1]} ${size[0]}x${size[1]}`
        }
        if (Config.desktopSession === "sway" || Config.desktopSession === "i3") {
            const tree = JSON.parse(await execAsync(["swaymsg", "-t", "get_tree"]))
            const focused = findFocused(tree)
            const r = focused?.rect
            if (!r) return undefined
            return `${r.x},${r.y} ${r.width}x${r.height}`
        }
    } catch (e) {
        console.warn("capture: could not resolve the focused window:", e)
        return undefined
    }
    return undefined
}

/**
 * The connector of the output the user is looking at ("eDP-1"), or null.
 *
 * grim with neither `-g` nor `-o` captures the whole LAYOUT — every
 * monitor composited into one image, with a hole where the desktops do
 * not line up. On a single-monitor machine that is the same picture, so
 * it looks correct right up until someone plugs in a second screen and
 * "screenshot screen" starts handing back a 5000px strip.
 */
async function focusedOutput(): Promise<string | null> {
    try {
        if (Config.desktopSession === "hyprland") {
            const monitors = JSON.parse(await execAsync(["hyprctl", "monitors", "-j"]))
            const focused = Array.isArray(monitors) ? monitors.find(m => m?.focused) : null
            return focused?.name ?? null
        }
        if (Config.desktopSession === "sway" || Config.desktopSession === "i3") {
            const outputs = JSON.parse(await execAsync(["swaymsg", "-t", "get_outputs"]))
            const focused = Array.isArray(outputs) ? outputs.find(o => o?.focused) : null
            return focused?.name ?? null
        }
    } catch (e) {
        // not fatal: fall back to the whole layout, which is right on the
        // single-monitor machines this can happen on
        console.warn("capture: could not resolve the focused output:", e)
    }
    return null
}

/** `-o <connector>` for the focused output, or nothing when unknown.
 *  grim and wf-recorder spell the flag the same way. */
async function outputArgs(): Promise<string[]> {
    const output = await focusedOutput()
    return output ? ["-o", output] : []
}

function findFocused(node: any): any {
    if (node?.focused) return node
    for (const child of [...(node?.nodes ?? []), ...(node?.floating_nodes ?? [])]) {
        const found = findFocused(child)
        if (found) return found
    }
    return null
}

/** copy a file's bytes onto the clipboard, MIME type included */
function copyFile(path: string, mime: string) {
    if (!has("wl-copy")) return
    try {
        const copier = Gio.Subprocess.new(
            ["wl-copy", "--type", mime],
            Gio.SubprocessFlags.STDIN_PIPE,
        )
        const sink = copier.get_stdin_pipe()
        const source = Gio.File.new_for_path(path).read(null)
        sink?.splice_async(
            source,
            Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
            GLib.PRIORITY_DEFAULT,
            null,
            (stream, res) => {
                try {
                    stream!.splice_finish(res)
                } catch (e) {
                    console.warn("capture: clipboard copy failed:", e)
                }
            },
        )
    } catch (e) {
        console.warn("capture: clipboard copy failed:", e)
    }
}

function open(path: string) {
    execAsync(["xdg-open", path]).catch(e => console.warn("capture: xdg-open failed:", e))
}

/**
 * Take a screenshot. Saves it, copies it, and says where it went.
 *
 * Both, deliberately: "copied to the clipboard" alone loses the shot the
 * next time anything else is copied, and "saved to disk" alone means
 * finding it before it can be pasted anywhere.
 */
export async function screenshot(mode: ShotMode = "region"): Promise<string> {
    if (!has("grim")) return "grim is not installed"
    if (mode === "region" && !has("slurp")) return "slurp is not installed"

    const geometry = await geometryFor(mode)
    if (geometry === undefined && mode !== "screen") return "cancelled"

    const path = `${outputDir("Screenshots")}/Screenshot_${stamp()}.png`
    // no geometry means the whole screen, and "the screen" is the one
    // being looked at — see focusedOutput
    const argv = geometry ? ["grim", "-g", geometry, path] : ["grim", ...(await outputArgs()), path]

    try {
        await execAsync(argv)
    } catch (e) {
        console.warn("capture: grim failed:", e)
        notify({ summary: "Screenshot failed", body: String(e), icon: "camera-photo-symbolic" })
        return "failed"
    }

    copyFile(path, "image/png")
    notify({
        summary: "Screenshot saved",
        body: path,
        icon: "camera-photo-symbolic",
        transient: true,
        actions: [
            { id: "default", label: "Open", run: () => open(path) },
            { id: "folder", label: "Show folder", run: () => open(GLib.path_get_dirname(path)) },
        ],
    })
    return path
}

/**
 * Start or stop a screen recording.
 *
 * Stopping is a SIGINT rather than a kill: wf-recorder finalises the
 * container on interrupt, and a killed one leaves a file no player will
 * open — which is the whole recording, gone, at the exact moment the
 * user thought they had finished.
 */
export async function toggleRecording(mode: ShotMode = "screen"): Promise<string> {
    if (recorder) {
        recorder.send_signal(2)
        return "stopping"
    }
    if (!has("wf-recorder")) return "wf-recorder is not installed"
    if (mode === "region" && !has("slurp")) return "slurp is not installed"

    const geometry = await geometryFor(mode)
    if (geometry === undefined && mode !== "screen") return "cancelled"

    const path = `${outputDir("Recordings")}/Recording_${stamp()}.mp4`
    const argv = ["wf-recorder", "-f", path]
    // same as the screenshot path: a region is a region, and everything
    // else means the output being looked at rather than all of them
    if (geometry) argv.push("-g", geometry)
    else argv.push(...(await outputArgs()))

    try {
        recorder = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE)
    } catch (e) {
        console.warn("capture: wf-recorder failed to start:", e)
        return "failed"
    }
    setRecording(true)
    notify({
        summary: "Recording",
        body: "The bar shows a dot while it runs. Run `record` again to stop.",
        icon: "media-record-symbolic",
        transient: true,
    })

    const proc = recorder
    proc.wait_async(null, () => {
        // a newer recording may have replaced this one already
        if (recorder !== proc) return
        recorder = null
        setRecording(false)
        notify({
            summary: "Recording saved",
            body: path,
            icon: "media-record-symbolic",
            transient: true,
            actions: [
                { id: "default", label: "Open", run: () => open(path) },
                {
                    id: "folder",
                    label: "Show folder",
                    run: () => open(GLib.path_get_dirname(path)),
                },
            ],
        })
    })
    return path
}

const registry = CommandRegistry.get_default()

registry.register({
    name: ["screenshot", "shot"],
    description: "Take a screenshot: region, window or screen",
    subCommands: ["region", "window", "screen"],
    help: `screenshot [region|window|screen]
  Default is region (slurp). "window" asks the compositor for the
  focused window's geometry — no rectangle to draw — and works on
  hyprland, sway and i3.
  The image is saved under Pictures/Screenshots AND copied to the
  clipboard, and the banner offers to open either the file or its
  folder.`,
    main: async args => {
        const mode = (args[0] ?? "region") as ShotMode
        if (!["region", "window", "screen"].includes(mode))
            return `unknown mode "${mode}" (expected region, window or screen)`
        return await screenshot(mode)
    },
})

registry.register({
    name: ["record", "recording"],
    description: "Start or stop a screen recording",
    subCommands: ["region", "screen"],
    help: `record [region|screen]
  Starts a recording, or stops the one that is running (the argument is
  ignored when stopping). Saved under Videos/Recordings.
  Stopping finalises the file — killing wf-recorder by hand does not.`,
    main: async args => {
        const mode = (args[0] ?? "screen") as ShotMode
        if (!["region", "screen"].includes(mode))
            return `unknown mode "${mode}" (expected region or screen)`
        return await toggleRecording(mode)
    },
})

function dispose() {
    // Never leave a half-written file behind: the shell going away must
    // still finalise the container, for the same reason stopping does.
    if (recorder) {
        recorder.send_signal(2)
        recorder = null
    }
    setRecording(false)
}

registerDispose("capture", dispose)
