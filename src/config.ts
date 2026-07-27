import GLib from "gi://GLib?version=2.0"
import toml from "toml"
import { exec } from "ags/process"
import { readFile } from "ags/file"
import { isFile } from "./lib/utils"

const instanceSrcDir = exec("pwd").trim()
const userHomeDir = GLib.getenv("HOME");
const xdgConfigHomeDir = GLib.getenv("XDG_CONFIG_HOME");
const xdgRuntimeDir = GLib.getenv("XDG_RUNTIME_DIR");


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
        `${instanceSrcDir}/config.toml`
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
        if (typeof (configData.os_icon) !== "string") {
            console.error(`Config "os_icon" cannot be typeof ${typeof (configData.os_icon)}, must be string`);
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
        if (typeof (override) !== "string") {
            console.error(`Config "desktop_session_override" cannot be typeof ${typeof (override)}, must be string`);
            override = GLib.getenv("DESKTOP_SESSION")  // Fallback
        }

        desktop = override
    }

    // Preflight checks for i3/sway (both speak the i3 IPC protocol)
    if (desktop === "sway" || desktop === "i3") {
        if (typeof (GLib.getenv("I3SOCK")) !== "string") {
            console.error(`i3/sway ipc I3SOCK Socket ENV missing`);
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
        popupIconSize: get("popup_icon_size", 22),
    }
}

function getQSettingsConfig() {
    // Keys can be set in a [quicksettings] section or flat at the top level;
    // the section takes precedence.
    const q = configData.quicksettings ?? {}
    const get = (key: string, fallback: any) => q[key] ?? configData[key] ?? fallback

    let closeDelay = get("close_delay", 350)
    if (typeof closeDelay !== "number" || closeDelay < 0) {
        console.error(`Config "quicksettings.close_delay" must be a positive number, got "${closeDelay}"`)
        closeDelay = 350
    }

    let statsInterval = get("stats_interval", 1000)
    if (typeof statsInterval !== "number" || statsInterval <= 0) {
        console.error(`Config "quicksettings.stats_interval" must be a positive number, got "${statsInterval}"`)
        statsInterval = 1000
    }

    return {
        closeDelay,
        showBatteryPercentage: get("show_battery_percentage", true),
        showDeviceNames: get("show_device_names", false),
        showStats: get("show_stats", false),
        statsOnPanel: get("stats_on_panel", false),
        statsInterval,
    }
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

/**
 * Check if the pending updates daemon is active. pending update daemon is a 
 * LeadSeason 
 * 
 * @returns 
 * - false → daemon not active OR update file missing
 * - string → absolute path to the update file (when active and file exists)
 */
function getPendingUpdateDaemonStatus(): false | string {
    let status;
    try {
        status = exec("systemctl --user is-active pending-updates-daemon.service");
    } catch (e) {
        return false;
    }
    if (status !== "active") {
        return false;
    }

    let updateFile = "/tmp/system_updates";

    if (xdgRuntimeDir) {
        updateFile = `${xdgRuntimeDir}/system_updates`;
    }

    if (!isFile(updateFile)) {
        return false;
    }

    return updateFile;
}

export default class Config {
    static instanceName = configData.instance_name || "wam-shell"

    static instanceSrcDir = instanceSrcDir
    static osIcon = getOsIcon()
    static desktopSession = getDesktopSession()
    static pendingUpdates = getPendingUpdateDaemonStatus()
    static updatesThreshold = configData.arch_updates_threshold || 50

    static swayGaps = (configData.sway_gaps === undefined) ? true : configData.sway_gaps
    static swayGapsSizeDefault = 10

    static workspaces = getWorkspacesConfig()
    static tray = getTrayConfig()
    static quicksettings = getQSettingsConfig()
    static hyprsunset = getHyprsunsetConfig()
    static barMonitors = getBarMonitors()

    static instanceCacheDir = `${GLib.get_user_cache_dir()}/${this.instanceName}`
    static cacheFile = `${this.instanceCacheDir}/cache.json`

    static cssPath = `${this.instanceCacheDir}/style.css`
    static scssPath = `${this.instanceSrcDir}/scss/style.scss`
}