// Config is an import-time singleton that reads env and config files, so
// each scenario spawns tests/config-dump.ts (pre-bundled by run.sh) in its
// own gjs process with a controlled env and parses its JSON stdout.
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { test, eq } from "./framework"

const TMP = GLib.getenv("WAM_TEST_TMP")!
const DUMP = GLib.getenv("WAM_TEST_CONFIG_DUMP")!
const SRC_DIR = GLib.getenv("WAM_SHELL_DIR")!

let scenarioCount = 0

function loadConfig(env: Record<string, string | null>, configToml?: string): any {
    const dir = `${TMP}/scenario-${scenarioCount++}`
    GLib.mkdir_with_parents(`${dir}/config/wam-shell`, 0o755)
    GLib.mkdir_with_parents(`${dir}/cache`, 0o755)
    GLib.mkdir_with_parents(`${dir}/home`, 0o755)
    if (configToml !== undefined)
        GLib.file_set_contents(`${dir}/config/wam-shell/config.toml`, configToml)

    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    })
    launcher.setenv("XDG_CONFIG_HOME", `${dir}/config`, true)
    launcher.setenv("XDG_CACHE_HOME", `${dir}/cache`, true)
    launcher.setenv("HOME", `${dir}/home`, true)
    launcher.setenv("WAM_SHELL_DIR", SRC_DIR, true)
    for (const [key, value] of Object.entries(env)) {
        if (value === null) (launcher as any).unsetenv(key)
        else launcher.setenv(key, value, true)
    }

    const proc = launcher.spawnv([DUMP])
    const [, stdout, stderr] = proc.communicate_utf8(null, null)
    const status = proc.get_exit_status()
    if (status !== 0) throw new Error(`config-dump exited ${status}: ${stderr}`)
    // config.ts logs to stdout; the dump is the last line
    const dump = JSON.parse(stdout.trim().split("\n").pop()!)
    dump.__dir = dir
    return dump
}

// --- desktop session detection: each compositor takes its own path ---

test("config: hyprland session", () => {
    const c = loadConfig({ DESKTOP_SESSION: "hyprland" })
    eq(c.desktopSession, "hyprland")
})

test("config: sway session requires I3SOCK", () => {
    const c = loadConfig({ DESKTOP_SESSION: "sway", I3SOCK: "/tmp/fake.sock" })
    eq(c.desktopSession, "sway")
})

test("config: sway without I3SOCK falls back to empty", () => {
    const c = loadConfig({ DESKTOP_SESSION: "sway", I3SOCK: null })
    eq(c.desktopSession, "")
})

test("config: i3 session with I3SOCK", () => {
    const c = loadConfig({ DESKTOP_SESSION: "i3", I3SOCK: "/tmp/fake.sock" })
    eq(c.desktopSession, "i3")
})

test("config: unknown session passes through", () => {
    const c = loadConfig({ DESKTOP_SESSION: "budgie" })
    eq(c.desktopSession, "budgie")
})

// --- defaults with no config file anywhere ---

test("config: documented defaults without a config file", () => {
    const c = loadConfig({ DESKTOP_SESSION: "hyprland" })
    eq(c.instanceName, "wam-shell", "instanceName")
    eq(c.tray.onPanel, false, "tray.onPanel")
    eq(c.tray.alwaysOnPanel, [], "tray.alwaysOnPanel")
    eq(c.notifications.popupTimeout, 5000, "notifications.popupTimeout")
    eq(c.notifications.daemon, "auto", "notifications.daemon")
    eq(c.osd.position, "bottom", "osd.position")
    eq(c.panels, [], "panels")
    eq(c.calendar.enabled, false, "calendar.enabled")
    eq(c.calendar.pollMinutes, 15, "calendar.pollMinutes")
    eq(c.calendar.hiddenCalendars, [], "calendar.hiddenCalendars")
    eq(c.github.enabled, false, "github.enabled")
    eq(c.github.pollMinutes, 5, "github.pollMinutes")
    eq(c.youtube.enabled, false, "youtube.enabled")
    eq(c.youtube.pollMinutes, 60, "youtube.pollMinutes")
    eq(c.notifications.popupProviders, [], "notifications.popupProviders")
})

test("config: theme fallback with follow_system off", () => {
    const c = loadConfig(
        { DESKTOP_SESSION: "hyprland" },
        `
[appearance]
follow_system = false
`,
    )
    eq(c.theme, "catppuccin-mocha")
})

// --- invalid values are corrected, not trusted ---

test("config: invalid values fall back to documented defaults", () => {
    const c = loadConfig(
        { DESKTOP_SESSION: "hyprland" },
        `
instance_name = "wam-shell-test-x"
desktop_session_override = "hyprland"

[tray]
spacing = -5
position = "middle"
always_on_panel = "notalist"

[notifications]
position = "bottomLeft"
popup_timeout = -1
daemon = "bogus"

[workspaces]
position = "up"

[quicksettings]
avatar = 5

[[panel]]
position = "middle"
left = ["osicon", "bogus-widget", "clock"]
`,
    )
    eq(c.instanceName, "wam-shell-test-x", "instanceName")
    eq(c.desktopSession, "hyprland", "desktopSession override")
    eq(c.tray.spacing, 0, "tray.spacing")
    eq(c.tray.position, "left", "tray.position")
    eq(c.tray.alwaysOnPanel, [], "tray.alwaysOnPanel")
    eq(c.notifications.position, "topRight", "notifications.position")
    eq(c.notifications.popupTimeout, 5000, "notifications.popupTimeout")
    eq(c.notifications.daemon, "auto", "notifications.daemon")
    eq(c.workspaces.position, "left", "workspaces.position")
    eq(c.quicksettings.avatar, "", "quicksettings.avatar non-string falls back")
    eq(c.panels.length, 1, "panels.length")
    eq(c.panels[0].position, "top", "panels[0].position")
    eq(c.panels[0].left, ["osicon", "clock"], "panels[0].left filters unknown widgets")
})

test("config: harvest hide_when_screen_sharing toggles the streaming-mode mask", () => {
    const on = loadConfig(
        { DESKTOP_SESSION: "hyprland" },
        `
[harvest]
hide_when_screen_sharing = true
`,
    )
    eq(on.harvest.hideWhenScreenSharing, true)

    const off = loadConfig(
        { DESKTOP_SESSION: "hyprland" },
        `
[harvest]
hide_when_screen_sharing = false
`,
    )
    eq(off.harvest.hideWhenScreenSharing, false)
})

test("config: harvest work_days parses numeric ranges", () => {
    const wd = (s: string) =>
        loadConfig(
            { DESKTOP_SESSION: "hyprland" },
            `
[harvest]
work_days = "${s}"
`,
        ).harvest.workDays

    eq(loadConfig({ DESKTOP_SESSION: "hyprland" }).harvest.workDays, [], "default empty")
    eq(wd("1-5"), [1, 2, 3, 4, 5], "Mon-Fri")
    eq(wd("5-1"), [0, 1, 5, 6], "wrapping range Fri-Mon")
    eq(wd("6,0"), [0, 6], "weekend list")
    eq(wd("1, 2, 4-5"), [1, 2, 4, 5], "mixed singles and range")
    eq(wd("3"), [3], "single day")
    eq(wd("mon-fri"), [], "day names rejected, falls back to every day")
    eq(wd("9"), [], "out of range rejected")
    eq(
        loadConfig({ DESKTOP_SESSION: "hyprland" }).harvest.collapseOffDays,
        false,
        "collapse default",
    )
})

test("config: instance cache dir follows XDG_CACHE_HOME and instance name", () => {
    const c = loadConfig(
        { DESKTOP_SESSION: "hyprland" },
        `
instance_name = "wam-shell-test-x"
`,
    )
    eq(c.instanceCacheDir, `${c.__dir}/cache/wam-shell-test-x`)
})
