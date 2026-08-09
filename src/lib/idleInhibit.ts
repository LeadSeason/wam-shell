import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { createState } from "gnim"
import Config from "../config"
import CommandRegistry from "./commandRegistry"
import { registerDispose } from "./lifecycle"

// "Keep awake": hold off the idle timeout and automatic suspend while
// something is running that has nothing to do with the keyboard.
//
// The default backend is a logind inhibitor lock, taken over D-Bus. It
// is the same mechanism `systemd-inhibit` uses, minus the child process,
// and its central property is how it is RELEASED: the lock lives for
// exactly as long as the file descriptor, and the kernel closes every
// descriptor a process holds when that process dies. So a crashed shell
// releases it. The spawn-a-helper approach cannot promise that — a
// `systemd-inhibit … sleep infinity` orphaned by a crash is a laptop
// that never sleeps again, with nothing left on screen to say why.
//
// What honours it:
//
// - logind's own idle actions and suspend-on-idle.
// - hypridle, unless the user set `ignore_systemd_inhibit`.
// - swayidle does NOT check logind inhibitors. Sway sessions that want
//   this need a helper speaking the Wayland idle-inhibit protocol, which
//   is what `[idle_inhibit] command` is for (e.g. `command = ["wlinhibit"]`).
//
// GTK's own `Gtk.Application.inhibit(IDLE)` was the obvious candidate
// and is not usable here: on Wayland GTK routes it through the
// xdg-desktop-portal Inhibit interface, which the wlroots and Hyprland
// portals do not implement — it returns a 0 cookie and inhibits nothing.

const [inhibited, setInhibited] = createState(false)

/** Is something holding the machine awake right now? */
export { inhibited }

// logind backend: the lock IS this descriptor
let lockFd = -1
// command backend: the lock is this process running
let child: Gio.Subprocess | null = null

function takeLogindLock(): boolean {
    try {
        // Synchronous, deliberately: this runs from a click, logind is
        // on the local system bus, and the alternative is a toggle whose
        // state settles a frame after the pointer left it.
        const [reply, fdList] = Gio.DBus.system.call_with_unix_fd_list_sync(
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
            "Inhibit",
            // "block" rather than "delay": delay only postpones a
            // suspend that is already happening, by a few seconds
            new GLib.Variant("(ssss)", [
                "idle:sleep",
                Config.instanceName,
                "Keep awake is on",
                "block",
            ]),
            new GLib.VariantType("(h)"),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null,
        )
        // the reply carries an INDEX into the fd list, not the fd
        const index = reply.deepUnpack<number[]>()[0] ?? 0
        const fds = fdList?.steal_fds() ?? []
        const fd = fds[index]
        // close anything else that came back, or it leaks for the
        // session — steal_fds() handed us ownership of all of them
        for (let i = 0; i < fds.length; i++) if (i !== index) GLib.close(fds[i]!)
        if (fd === undefined) {
            console.warn("idleInhibit: logind returned no descriptor")
            return false
        }
        lockFd = fd
        return true
    } catch (e) {
        console.warn("idleInhibit: could not take a logind lock:", e)
        return false
    }
}

function startCommand(argv: string[]): boolean {
    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE)
        child = proc
        // An inhibitor that exits on its own is no longer inhibiting
        // anything, and the tile has to stop claiming otherwise —
        // a missing binary is the common case.
        proc.wait_async(null, () => {
            // a newer child may have replaced this one already
            if (child !== proc) return
            child = null
            if (inhibited.get()) {
                console.warn(`idleInhibit: ${argv[0]} exited; keep awake is off`)
                setInhibited(false)
            }
        })
        return true
    } catch (e) {
        console.warn(`idleInhibit: could not run ${argv[0]}:`, e)
        return false
    }
}

function release() {
    if (lockFd >= 0) {
        GLib.close(lockFd)
        lockFd = -1
    }
    if (child) {
        const proc = child
        // cleared BEFORE the kill so wait_async's handler sees the
        // replacement-or-teardown case and stays quiet
        child = null
        proc.force_exit()
    }
}

/**
 * Turn keep-awake on or off.
 *
 * Idempotent, and it reports the truth: if the lock could not be taken
 * the state stays off, so the tile does not sit there lit while the
 * machine suspends underneath it.
 */
export function setIdleInhibit(on: boolean): void {
    if (on === inhibited.get()) return
    if (!on) {
        release()
        setInhibited(false)
        return
    }
    const custom = Config.idleInhibit.command
    const ok = custom.length > 0 ? startCommand(custom) : takeLogindLock()
    if (ok) setInhibited(true)
}

export function toggleIdleInhibit(): void {
    setIdleInhibit(!inhibited.get())
}

function dispose() {
    release()
    setInhibited(false)
}

// A keybind is the natural way to reach this — it is the toggle you
// want on the way INTO the thing you are keeping the machine awake for,
// not after opening quick settings
CommandRegistry.get_default().register({
    name: ["keep-awake", "caffeine"],
    description: "Keep awake: toggle, on, off, status",
    help: `keep-awake
  Toggles it.
keep-awake on|off
  Sets it, without caring what it was.
keep-awake status
  One line: inhibited=<bool> backend=<logind|command>`,
    main: args => {
        const arg = args[0] ?? ""
        const backend = Config.idleInhibit.command.length > 0 ? "command" : "logind"
        if (arg === "status") return `inhibited=${inhibited.get()} backend=${backend}`
        if (arg === "on" || arg === "off") setIdleInhibit(arg === "on")
        else if (arg === "") toggleIdleInhibit()
        else return `unknown argument "${arg}" (expected on, off or status)`
        // report what it ACTUALLY is: taking the lock can fail, and a
        // keybind that says "on" when nothing is held is worse than one
        // that says it could not
        return inhibited.get() ? "keep awake is on" : "keep awake is off"
    },
})

registerDispose("idleInhibit", dispose)
