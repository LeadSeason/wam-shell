import GLib from "gi://GLib?version=2.0"

// Is the Hyprland IPC socket pair actually on disk?
//
// Split out of config.ts so the startup session preflight and the
// runtime AstalHyprland guards (lib/hyprlandGuard) ask the same
// question without dragging an astal typelib into the config root —
// config.ts is imported by everything, including modules that must
// stay display-free and GI-free.
//
// The env var alone is not enough: HYPRLAND_INSTANCE_SIGNATURE
// survives the compositor it names, so a stale signature (compositor
// restarting, an old instance) points at a socket that is not there —
// and astal's get_default() reads from the connection without checking
// the connect succeeded, which segfaults the whole process inside the
// library. try/catch cannot help a segfault; a stat can (#225). Both
// sockets: hyprland.vala opens .socket.sock for requests and
// .socket2.sock for events.

/** The two socket paths for the running instance, or [] without a signature. */
export function hyprlandSocketPaths(): string[] {
    const his = GLib.getenv("HYPRLAND_INSTANCE_SIGNATURE")
    if (typeof his !== "string") return []
    const sockDir = `${GLib.get_user_runtime_dir()}/hypr/${his}`
    return [".socket.sock", ".socket2.sock"].map(sock => `${sockDir}/${sock}`)
}

/** null when the IPC is reachable, otherwise why not (for the log). */
export function hyprlandIpcProblem(): string | null {
    const paths = hyprlandSocketPaths()
    if (paths.length === 0) return "hyprland ipc HYPRLAND_INSTANCE_SIGNATURE env missing"
    for (const path of paths) {
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return `hyprland ipc socket missing: ${path}`
    }
    return null
}

export function hyprlandIpcUp(): boolean {
    return hyprlandIpcProblem() === null
}
