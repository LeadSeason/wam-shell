import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import toml from "toml"
import { exec } from "ags/process"
import { readFile } from "ags/file"
import { isFile } from "./lib/utils"

// scss/theme/script paths resolve against the repo root. Launching from
// another cwd breaks that; WAM_SHELL_DIR overrides when needed.
const instanceSrcDir = GLib.getenv("WAM_SHELL_DIR") || GLib.get_current_dir()
const userHomeDir = GLib.getenv("HOME")
const xdgConfigHomeDir = GLib.getenv("XDG_CONFIG_HOME")
const xdgRuntimeDir = GLib.getenv("XDG_RUNTIME_DIR")

// Locate and load config
const configFile = findConfigFile()
if (configFile) {
    console.log("Found config file:", configFile)
}
const configData = parseToml(readRawFile(configFile))

function findConfigFile(): string | undefined {
    // Candidates ordered by priority (highest first)
    const candidates = [
        `${xdgConfigHomeDir}/wam-shell/config.toml`,
        `${userHomeDir}/.config/wam-shell/config.toml`,
        `${instanceSrcDir}/config-override.toml`,
        `${instanceSrcDir}/config.toml`,
    ]

    for (const candidate of candidates) {
        if (isFile(candidate)) return candidate
    }
    return undefined
}

function readRawFile(path?: string): string {
    if (!path) return ""
    try {
        return readFile(path) || ""
    } catch (err) {
        console.error(`Failed reading ${path}:`, err)
        return ""
    }
}

function parseToml(raw: string): Record<string, any> {
    if (!raw) return {}
    try {
        return toml.parse(raw)
    } catch (err) {
        console.error("Failed parsing TOML:", err)
    }
    return {}
}

function getOsIcon(): string {
    if (configData.os_icon !== undefined) {
        if (typeof configData.os_icon !== "string") {
            console.error(
                `Config "os_icon" cannot be typeof ${typeof configData.os_icon}, must be string`,
            )
        } else {
            return configData.os_icon
        }
    }

    // Get OsIcon from /etc/os-release
    try {
        const content = readFile("/etc/os-release") || ""
        const match = content.match(/^LOGO=(.+)$/m)?.[1] ?? ""
        return match.replace(/^"|"$/g, "")
    } catch (err) {
        console.error("Failed to parse /etc/os-release for LOGO=\n", err)
    }

    return ""
}

function getDesktopSession(): string {
    let override = configData.desktop_session_override
    let desktop = GLib.getenv("DESKTOP_SESSION")

    // Preflight checks for override config variable
    if (override !== undefined) {
        if (typeof override !== "string") {
            console.error(
                `Config "desktop_session_override" cannot be typeof ${typeof override}, must be string`,
            )
            override = GLib.getenv("DESKTOP_SESSION") // Fallback
        }

        desktop = override
    }

    // Preflight checks for i3/sway (both speak the i3 IPC protocol)
    if (desktop === "sway" || desktop === "i3") {
        if (typeof GLib.getenv("I3SOCK") !== "string") {
            console.error(`i3/sway ipc I3SOCK Socket ENV missing`)
            return "" // Fallback
        }

        return desktop
    }

    // Preflight checks for hyprland
    if (desktop === "hyprland") {
        // @TODO
        return "hyprland"
    }

    // Default fallback
    if (desktop !== null) {
        console.warn(`${desktop} is unsupported desktop session`)
        return desktop
    }

    // Default fallback
    console.warn(`DESKTOP_SESSION env is ${desktop}`)
    return ""
}

function getWorkspacesConfig() {
    // Keys can be set in a [workspaces] section or flat at the top level;
    // the section takes precedence.
    const ws = configData.workspaces ?? {}
    const get = (key: string, fallback: any) => ws[key] ?? configData[key] ?? fallback

    let position = get("position", "left")
    if (position !== "left" && position !== "right") {
        console.error(`Config "workspaces.position" must be "left" or "right", got "${position}"`)
        position = "left"
    }

    return {
        enabled: get("enabled", true),
        position: position as "left" | "right",
        showIcons: get("show_icons", true),
        showLabels: get("show_labels", true),
        hideEmpty: get("hide_empty", false),
        collapseIcons: get("collapse_icons", false),
    }
}

function getTrayConfig() {
    // Keys can be set in a [tray] section or flat at the top level;
    // the section takes precedence.
    const t = configData.tray ?? {}
    const get = (key: string, fallback: any) => t[key] ?? configData[key] ?? fallback

    let spacing = get("spacing", 0)
    if (typeof spacing !== "number" || spacing < 0) {
        console.error(`Config "tray.spacing" must be a positive number, got "${spacing}"`)
        spacing = 0
    }

    // Flat fallback is "tray_position": a bare "position" key would collide
    // with workspaces.position.
    let position = t.position ?? configData.tray_position ?? "left"
    if (position !== "left" && position !== "right") {
        console.error(`Config "tray.position" must be "left" or "right", got "${position}"`)
        position = "left"
    }

    let alwaysOnPanel = get("always_on_panel", [])
    if (!Array.isArray(alwaysOnPanel)) {
        console.error(`Config "tray.always_on_panel" must be a list of app ids`)
        alwaysOnPanel = []
    }
    alwaysOnPanel = alwaysOnPanel.filter(id => typeof id === "string" && id !== "")

    return {
        onPanel: get("on_panel", false),
        spacing,
        position: position as "left" | "right",
        alwaysOnPanel,
        // type-guarded like spacing/width: a non-number (popup_icon_size
        // = "22") reaches Gtk.Image.pixelSize / pill CSS at startup
        popupIconSize: (() => {
            const size = get("popup_icon_size", 22)
            if (typeof size !== "number" || size <= 0) {
                console.error(
                    `Config "tray.popup_icon_size" must be a positive number, got "${size}"`,
                )
                return 22
            }
            return size
        })(),
    }
}

function getQSettingsConfig() {
    // Keys can be set in a [quicksettings] section or flat at the top level;
    // the section takes precedence.
    const q = configData.quicksettings ?? {}
    const get = (key: string, fallback: any) => q[key] ?? configData[key] ?? fallback

    let statsInterval = get("stats_interval", 1000)
    if (typeof statsInterval !== "number" || statsInterval <= 0) {
        console.error(
            `Config "quicksettings.stats_interval" must be a positive number, got "${statsInterval}"`,
        )
        statsInterval = 1000
    }

    return {
        showBatteryPercentage: get("show_battery_percentage", true),
        showDeviceNames: get("show_device_names", false),
        showStats: get("show_stats", false),
        statsOnPanel: get("stats_on_panel", false),
        statsInterval,
        // popup content width in px (the scroll view clamps it)
        width: (() => {
            const w = get("width", 440)
            if (typeof w !== "number" || w <= 0) {
                console.error(`Config "quicksettings.width" must be a positive number, got "${w}"`)
                return 440
            }
            return w
        })(),
        // the power profile icon in the bar's quicksettings label
        powerProfileOnPanel: get("power_profile_on_panel", true),
        // header avatar: absolute path to an image; empty = the login
        // avatar from AccountsService, else the OS icon. Type-guarded:
        // a non-string (avatar = 5) would crash GLib.file_test at
        // startup
        avatar: (() => {
            const avatar = get("avatar", "")
            if (typeof avatar !== "string") {
                console.error(`Config "avatar" cannot be typeof ${typeof avatar}, must be string`)
                return ""
            }
            return avatar
        })(),
        showAvatar: get("show_avatar", true),
        // charge cap in percent: the header ring treats this as full.
        // explicit config wins; otherwise auto-detect from sysfs
        // (charge_control_end_threshold, e.g. Lenovo/ASUS limits);
        // default 100 when neither is available
        batteryFullAt: (() => {
            const explicit = configData.quicksettings?.battery_full_at ?? configData.battery_full_at
            if (typeof explicit === "number" && explicit > 0 && explicit <= 100) return explicit
            for (const bat of ["BAT0", "BAT1", "BAT2"]) {
                const p = `/sys/class/power_supply/${bat}/charge_control_end_threshold`
                try {
                    if (isFile(p)) {
                        const v = Number(readFile(p).trim())
                        if (v > 0 && v <= 100) return v
                    }
                } catch {}
            }
            return 100
        })(),
    }
}

function getBluetoothConfig() {
    const b = configData.bluetooth ?? {}
    const get = (key: string, fallback: any) => b[key] ?? configData[key] ?? fallback

    return {
        notifications: get("notifications", true),
    }
}

function getMediaConfig() {
    const m = configData.media ?? {}
    const get = (key: string, fallback: any) => m[key] ?? configData[key] ?? fallback

    let maxWidth = get("max_width", 20)
    if (typeof maxWidth !== "number" || maxWidth <= 0) {
        console.error(`Config "media.max_width" must be a positive number, got "${maxWidth}"`)
        maxWidth = 20
    }

    return {
        enabled: get("enabled", false),
        showControls: get("show_controls", true),
        maxWidth,
        // while screen sharing, hide the quick-settings player entirely
        // (title/artist/cover are visible to viewers otherwise)
        hideWhenScreenSharing: get("hide_when_screen_sharing", false),
        // treat browsers' scrubbed private-session titles as no track
        hidePrivateSessions: get("hide_private_sessions", true),
    }
}

function getAppearanceConfig() {
    const a = configData.appearance ?? {}
    const get = (key: string, fallback: any) => a[key] ?? configData[key] ?? fallback

    const themeOr = (key: string, fallback: string) => {
        const t = get(key, fallback)
        return typeof t === "string" && isFile(`${instanceSrcDir}/scss/theme/${t}.scss`)
            ? t
            : fallback
    }

    return {
        // themes applied when Dark Style toggles on/off
        darkTheme: themeOr("dark_theme", "catppuccin-mocha"),
        lightTheme: themeOr("light_theme", "catppuccin-latte"),
        // also follow the system color scheme at startup
        followSystem: get("follow_system", true),
    }
}

// resolve the theme, following the system color scheme when enabled:
// Dark Style left off must survive a shell restart
function resolveTheme(data: Record<string, any>): string {
    const theme = getTheme(data)
    const appearance = getAppearanceConfig()
    if (!appearance.followSystem) return theme
    // new Gio.Settings({schema_id}) on a missing schema aborts the
    // process (a g_error, not a catchable exception) — look it up first
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(
        "org.gnome.desktop.interface",
        true,
    )
    // schema not installed — keep the configured theme
    if (!schema) return theme
    const s = new Gio.Settings({ settings_schema: schema })
    return s.get_string("color-scheme").includes("prefer-dark")
        ? appearance.darkTheme
        : appearance.lightTheme
}

function getHyprsunsetConfig() {
    const h = configData.hyprsunset ?? {}
    const get = (key: string, fallback: any) => h[key] ?? configData[key] ?? fallback

    return {
        // temperature used normally (night light off, gamma <= 100%)
        temperatureDefault: get("temperature_default", 6000),
        // temperature applied in outdoor mode (gamma > 100%).
        // falls back to temperature_default when omitted
        temperatureOutdoor: get("temperature_outdoor", null),
        nightTemp: get("night_temp", 4000),
        // gamma in outdoor mode, in percent (may exceed 100)
        gammaOutdoor: get("gamma_outdoor", 150),
    }
}

function getBarMonitors(): string[] {
    // connectors (e.g. "eDP-1") that get a panel; empty = all monitors
    const m = configData.bar_monitors
    if (m === undefined) return []
    if (!Array.isArray(m)) {
        console.error(`Config "bar_monitors" must be a list of monitor connectors`)
        return []
    }
    return m.filter(x => typeof x === "string" && x !== "")
}

function getSleepTimerConfig() {
    const s = configData.sleep_timer ?? {}
    const get = (key: string, fallback: any) => s[key] ?? configData[key] ?? fallback

    let presets = get("presets", [10, 15, 20, 30, 45, 60])
    if (
        !Array.isArray(presets) ||
        presets.length === 0 ||
        presets.some((p: any) => typeof p !== "number" || p <= 0)
    ) {
        console.error(
            `Config "sleep_timer.presets" must be a non-empty list of positive numbers, got "${JSON.stringify(presets)}"`,
        )
        presets = [10, 15, 20, 30, 45, 60]
    }

    // a 0..1 fraction, or the fallback when missing/wrong
    const fraction = (key: string, fallback: number) => {
        const v = get(key, fallback)
        if (typeof v !== "number" || v < 0 || v > 1) {
            console.error(
                `Config "sleep_timer.${key}" must be a number between 0 and 1, got "${v}"`,
            )
            return fallback
        }
        return v
    }

    // 1..100 percent as a fraction, or the fallback when missing/wrong
    const percent = (key: string, fallback: number) => {
        const v = get(key, fallback)
        if (typeof v !== "number" || v < 1 || v > 100) {
            console.error(
                `Config "sleep_timer.${key}" must be a number between 1 and 100, got "${v}"`,
            )
            return fallback / 100
        }
        return v / 100
    }

    return {
        presets,
        // show the sleep timer toggle in quick settings
        enabled: get("enabled", true),
        // show the countdown on the panel while a timer runs.
        // Section-only lookup, NOT the usual top-level fallback: the
        // tray's top-level on_panel key would leak in otherwise
        onPanel: s["on_panel"] ?? true,
        // dim the screen on fire: dim_level as a fraction of the current
        // brightness (default half), never below the dim_floor minimum
        dim: get("dim", true),
        dimLevel: fraction("dim_level", 0.5),
        dimFloor: fraction("dim_floor", 0.1),
        // play a soothing chime in a loop when the timer reaches 0,
        // until stopped from the pill
        alarm: get("alarm", false),
        // the volume the sink is raised to while the alarm rings
        alarmVolume: percent("alarm_volume", 100),
    }
}

function getHarvestConfig() {
    const h = configData.harvest ?? {}
    const get = (key: string, fallback: any) => h[key] ?? configData[key] ?? fallback

    let pollInterval = get("poll_interval", 10)
    if (typeof pollInterval !== "number" || pollInterval <= 0) {
        console.error(
            `Config "harvest.poll_interval" must be a positive number, got "${pollInterval}"`,
        )
        pollInterval = 10
    }
    // floor: a config typo must not throttle the Harvest account
    if (pollInterval < 5) pollInterval = 5

    let recents = get("recents", 5)
    if (typeof recents !== "number" || recents <= 0) {
        console.error(`Config "harvest.recents" must be a positive number, got "${recents}"`)
        recents = 5
    }

    // both keys must hold "HH:MM" or the window is disabled
    const hhmm = (v: any) => typeof v === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v)
    let workStart = get("work_start", "")
    let workEnd = get("work_end", "")
    if (!hhmm(workStart) || !hhmm(workEnd)) {
        if (workStart !== "" || workEnd !== "") {
            console.error(
                `Config "harvest.work_start"/"harvest.work_end" must both be "HH:MM", got "${workStart}"/"${workEnd}"; disabling the window`,
            )
        }
        workStart = ""
        workEnd = ""
    }

    let workDays: number[] = []
    const workDaysRaw = get("work_days", "")
    if (typeof workDaysRaw !== "string") {
        console.error(
            `Config "harvest.work_days" must be a string like "1-5", got ${JSON.stringify(workDaysRaw)}`,
        )
    } else {
        const parsed = parseWorkDays(workDaysRaw)
        if (parsed === null) {
            console.error(
                `Config "harvest.work_days" has an invalid range, got "${workDaysRaw}" (expected e.g. "1-5" or "6,0"; 0=Sunday); treating as every day`,
            )
        } else {
            workDays = parsed
        }
    }

    return {
        enabled: get("enabled", false),
        // section-only lookup, NOT the usual top-level fallback: the
        // tray's top-level on_panel key would leak in otherwise
        onPanel: h["on_panel"] ?? true,
        pollInterval,
        recents,
        workStart,
        workEnd,
        workDays,
        // off work_days, shrink to a bare icon instead of hiding
        collapseOffDays: get("collapse_off_days", false),
        // while screen sharing, mask entry details on the panel
        hideWhenScreenSharing: get("hide_when_screen_sharing", true),
    }
}

// "1-5" / "5-1" / "6,0" -> weekday numbers matching Date.getDay()
// (0=Sunday); ranges walk forward modulo the week, so they may wrap
// ("5-1" = Fri,Sat,Sun,Mon). null = malformed
function parseWorkDays(raw: string): number[] | null {
    if (raw.trim() === "") return []
    const out = new Set<number>()
    for (const part of raw.split(",")) {
        const m = part.trim().match(/^(\d)(?:-(\d))?$/)
        if (!m) return null
        const a = Number(m[1])
        const b = m[2] !== undefined ? Number(m[2]) : a
        if (a > 6 || b > 6) return null
        for (let d = a; ; d = (d + 1) % 7) {
            out.add(d)
            if (d === b) break
        }
    }
    return [...out].sort((x, y) => x - y)
}

// Google Calendar in the clock popover. Section-only keys: no top-level
// fallbacks exist for these names and none should leak in
function getCalendarConfig() {
    const c = configData.calendar ?? {}

    let pollMinutes = c["poll_minutes"] ?? 15
    if (typeof pollMinutes !== "number" || pollMinutes <= 0) {
        console.error(
            `Config "calendar.poll_minutes" must be a positive number, got "${pollMinutes}"`,
        )
        pollMinutes = 15
    }
    // floor: a config typo must not burn the Calendar API quota
    if (pollMinutes < 5) pollMinutes = 5

    let hiddenCalendars = c["hidden_calendars"] ?? []
    if (
        !Array.isArray(hiddenCalendars) ||
        hiddenCalendars.some((x: any) => typeof x !== "string")
    ) {
        console.error(
            `Config "calendar.hidden_calendars" must be a list of strings, got "${JSON.stringify(hiddenCalendars)}"`,
        )
        hiddenCalendars = []
    }

    return {
        enabled: c["enabled"] ?? true,
        pollMinutes,
        hiddenCalendars,
        // ISO-8601 week numbers down the month grid's left edge
        weekNumbers: c["week_numbers"] ?? true,
    }
}

// GitHub notifications in the notification center. Section-only keys:
// no top-level fallbacks exist for these names and none should leak in
function getGitHubConfig() {
    const g = configData.github ?? {}

    let pollMinutes = g["poll_minutes"] ?? 5
    if (typeof pollMinutes !== "number" || pollMinutes <= 0) {
        console.error(
            `Config "github.poll_minutes" must be a positive number, got "${pollMinutes}"`,
        )
        pollMinutes = 5
    }
    // floor: a config typo must not burn the GitHub API rate limit
    if (pollMinutes < 1) pollMinutes = 1

    return {
        enabled: g["enabled"] ?? true,
        pollMinutes,
    }
}

// Todoist tasks (due today/overdue) in the notification center.
// Section-only keys: no top-level fallbacks exist for these names and
// none should leak in
function getTodoistConfig() {
    const t = configData.todoist ?? {}

    let pollMinutes = t["poll_minutes"] ?? 5
    if (typeof pollMinutes !== "number" || pollMinutes <= 0) {
        console.error(
            `Config "todoist.poll_minutes" must be a positive number, got "${pollMinutes}"`,
        )
        pollMinutes = 5
    }
    // floor: a config typo must not burn the Todoist API rate limit
    if (pollMinutes < 1) pollMinutes = 1

    let remindBefore = t["remind_before_minutes"] ?? 5
    if (typeof remindBefore !== "number" || remindBefore < 0) {
        console.error(
            `Config "todoist.remind_before_minutes" must be a number >= 0, got "${remindBefore}"`,
        )
        remindBefore = 5
    }

    return {
        enabled: t["enabled"] ?? true,
        pollMinutes,
        // proactive banners before a scheduled (timed) task is due
        reminders: t["reminders"] ?? true,
        remindBeforeMinutes: remindBefore,
    }
}

// ProtonMail unread mail in the notification center, via ProtonMail
// Bridge's local IMAP. Section-only keys: no top-level fallbacks exist
// for these names and none should leak in
function getProtonmailConfig() {
    const p = configData.protonmail ?? {}

    let pollMinutes = p["poll_minutes"] ?? 2
    if (typeof pollMinutes !== "number" || pollMinutes <= 0) {
        console.error(
            `Config "protonmail.poll_minutes" must be a positive number, got "${pollMinutes}"`,
        )
        pollMinutes = 2
    }
    // floor: a config typo must not hammer the bridge
    if (pollMinutes < 1) pollMinutes = 1

    let port = p["port"] ?? 1143
    if (typeof port !== "number" || port <= 0) {
        console.error(`Config "protonmail.port" must be a positive number, got "${port}"`)
        port = 1143
    }

    const host = typeof p["host"] === "string" && p["host"] !== "" ? p["host"] : "127.0.0.1"

    return {
        enabled: p["enabled"] ?? true,
        pollMinutes,
        host,
        port,
    }
}

// YouTube notifications in the notification center. Section-only keys:
// no top-level fallbacks exist for these names and none should leak in
function getYouTubeConfig() {
    const y = configData.youtube ?? {}

    let pollMinutes = y["poll_minutes"] ?? 60
    if (typeof pollMinutes !== "number" || pollMinutes <= 0) {
        console.error(
            `Config "youtube.poll_minutes" must be a positive number, got "${pollMinutes}"`,
        )
        pollMinutes = 60
    }
    // floor: a config typo must not burn the YouTube API quota (each
    // poll costs ~1 unit per subscription; see config.toml)
    if (pollMinutes < 15) pollMinutes = 15

    return {
        enabled: y["enabled"] ?? true,
        pollMinutes,
    }
}

function getNotificationsConfig() {
    const n = configData.notifications ?? {}
    const get = (key: string, fallback: any) => n[key] ?? configData[key] ?? fallback

    let popupTimeout = get("popup_timeout", 5000)
    if (typeof popupTimeout !== "number" || popupTimeout <= 0) {
        console.error(
            `Config "notifications.popup_timeout" must be a positive number, got "${popupTimeout}"`,
        )
        popupTimeout = 5000
    }

    let position = get("position", "topRight")
    if (!["topRight", "topCenter"].includes(position)) {
        console.error(
            `Config "notifications.position" must be "topRight" or "topCenter", got "${position}"`,
        )
        position = "topRight"
    }

    let daemon = get("daemon", "auto")
    if (!["auto", "wam-shell", "system"].includes(daemon)) {
        console.error(
            `Config "notifications.daemon" must be "auto", "wam-shell" or "system", got "${daemon}"`,
        )
        daemon = "auto"
    }

    let transientApps = get("transient_apps", [])
    if (!Array.isArray(transientApps)) {
        console.error(`Config "notifications.transient_apps" must be a list of app names`)
        transientApps = []
    }
    transientApps = transientApps
        .filter((a: any) => typeof a === "string" && a !== "")
        .map((a: string) => a.toLowerCase())

    let popupProviders = get("popup_providers", [])
    if (!Array.isArray(popupProviders) || popupProviders.some((x: any) => typeof x !== "string")) {
        console.error(
            `Config "notifications.popup_providers" must be a list of provider names, got "${JSON.stringify(popupProviders)}"`,
        )
        popupProviders = []
    }

    return {
        // transient banners for incoming notifications
        popups: get("popups", true),
        // provider names ("github", "youtube", ...) whose items may
        // also raise transient banners. opt-in: empty = center only
        popupProviders,
        // ms before a popup auto-hides (critical stays until dismissed,
        // low urgency drains in half the time)
        popupTimeout,
        position: position as "topRight" | "topCenter",
        // fixed banner width in px: the stack must not resize as
        // notifications arrive and expire
        popupWidth: (() => {
            const w = get("popup_width", 460)
            if (typeof w !== "number" || w <= 0) {
                console.error(
                    `Config "notifications.popup_width" must be a positive number, got "${w}"`,
                )
                return 460
            }
            return w
        })(),
        // whose notification daemon is used: auto = the system's if one
        // is running, ours otherwise
        daemon: daemon as "auto" | "wam-shell" | "system",
        // app names (lowercased) whose notifications are popup-only:
        // shown as banners but excluded from the center's history
        transientApps: transientApps as string[],
    }
}

function getOsdConfig() {
    const o = configData.osd ?? {}
    const get = (key: string, fallback: any) => o[key] ?? configData[key] ?? fallback

    let position = get("position", "bottom")
    if (!["bottom", "center", "top"].includes(position)) {
        console.error(
            `Config "osd.position" must be "bottom", "center" or "top", got "${position}"`,
        )
        position = "bottom"
    }

    let timeout = get("timeout", 2000)
    if (typeof timeout !== "number" || timeout <= 0) {
        console.error(`Config "osd.timeout" must be a positive number, got "${timeout}"`)
        timeout = 2000
    }

    return {
        enabled: get("enabled", true),
        position: position as "bottom" | "center" | "top",
        timeout,
        // per-trigger toggles
        volume: get("volume", true),
        microphone: get("microphone", true),
        brightness: get("brightness", true),
        layout: get("layout", true),
        lockKeys: get("lock_keys", true),
    }
}

function getTheme(data: Record<string, any>): string {
    const fallback = "catppuccin-mocha"
    const t = data.theme
    if (t === undefined) return fallback
    if (typeof t !== "string" || !isFile(`${instanceSrcDir}/scss/theme/${t}.scss`)) {
        console.error(`Config "theme": no scss/theme/${t}.scss, falling back to ${fallback}`)
        return fallback
    }
    return t
}

export interface PanelConfig {
    monitors: string[]
    position: "top" | "bottom"
    class: string
    left: string[]
    center: string[]
    right: string[]
}

const PANEL_WIDGETS = [
    "osicon",
    "workspaces",
    "clock",
    "stats",
    "tray",
    "quicksettings",
    "language",
    "notifications",
    "media",
    "sleeptimer",
    "harvest",
    "windowtitle",
]

function getPanelsConfig(): PanelConfig[] {
    const p = configData.panel
    if (p === undefined) return []
    if (!Array.isArray(p)) {
        console.error(`Config "panel" must be a list of [[panel]] tables`)
        return []
    }

    const strList = (v: any, fallback: string[]) =>
        Array.isArray(v) ? v.filter(x => typeof x === "string") : fallback

    return p.map((entry: any, i: number) => {
        let position = entry.position ?? "top"
        if (position !== "top" && position !== "bottom") {
            console.error(
                `Config "panel[${i}].position" must be "top" or "bottom", got "${position}"`,
            )
            position = "top"
        }

        const checkWidgets = (names: string[]) =>
            names.filter(n => {
                if (PANEL_WIDGETS.includes(n)) return true
                console.error(`Config "panel[${i}]": unknown widget "${n}", skipping`)
                return false
            })

        return {
            monitors: strList(entry.monitors, []),
            position: position as "top" | "bottom",
            class: typeof entry.class === "string" ? entry.class : "",
            left: checkWidgets(strList(entry.left, ["osicon", "workspaces"])),
            center: checkWidgets(strList(entry.center, ["clock"])),
            right: checkWidgets(
                strList(entry.right, [
                    "stats",
                    "tray",
                    "quicksettings",
                    "language",
                    "notifications",
                ]),
            ),
        }
    })
}

/**
 * Check if the pending updates daemon is active. pending update daemon is a
 * LeadSeason
 *
 * @returns
 * - false → daemon not active OR update file missing
 * - string → absolute path to the update file (when active and file exists)
 */
function getPendingUpdateDaemonStatus(): false | string {
    let status
    try {
        status = exec("systemctl --user is-active pending-updates-daemon.service")
    } catch (e) {
        return false
    }
    if (status !== "active") {
        return false
    }

    let updateFile = "/tmp/system_updates"

    if (xdgRuntimeDir) {
        updateFile = `${xdgRuntimeDir}/system_updates`
    }

    if (!isFile(updateFile)) {
        return false
    }

    return updateFile
}

export default class Config {
    static instanceName = configData.instance_name || "wam-shell"

    static instanceSrcDir = instanceSrcDir
    static osIcon = getOsIcon()
    static desktopSession = getDesktopSession()
    static pendingUpdates = getPendingUpdateDaemonStatus()
    static updatesThreshold = (() => {
        const v = configData.arch_updates_threshold
        if (v === undefined) return 50
        if (typeof v !== "number" || v < 0) {
            console.error(
                `Config "arch_updates_threshold" must be a non-negative number, got "${v}"`,
            )
            return 50
        }
        return v
    })()

    static swayGaps = configData.sway_gaps === undefined ? true : configData.sway_gaps
    static swayGapsSizeDefault = 10

    static workspaces = getWorkspacesConfig()
    static tray = getTrayConfig()
    static quicksettings = getQSettingsConfig()
    static bluetooth = getBluetoothConfig()
    static media = getMediaConfig()
    static hyprsunset = getHyprsunsetConfig()
    static barMonitors = getBarMonitors()
    static panels = getPanelsConfig()
    static theme = resolveTheme(configData)
    static appearance = getAppearanceConfig()
    static osd = getOsdConfig()
    static notifications = getNotificationsConfig()
    static sleepTimer = getSleepTimerConfig()
    static harvest = getHarvestConfig()
    static calendar = getCalendarConfig()
    static github = getGitHubConfig()
    static youtube = getYouTubeConfig()
    static todoist = getTodoistConfig()
    static protonmail = getProtonmailConfig()
    static instanceCacheDir = `${GLib.get_user_cache_dir()}/${this.instanceName}`
    static cacheFile = `${this.instanceCacheDir}/cache.json`

    static cssPath = `${this.instanceCacheDir}/style.css`
    static scssPath = `${this.instanceSrcDir}/scss/style.scss`
}

// Re-read the theme key from the config file so theme changes apply
// on reloadStyle without a restart.
export function reloadTheme(): string {
    const data = parseToml(readRawFile(findConfigFile()))
    Config.theme = resolveTheme(data)
    return Config.theme
}
