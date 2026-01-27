import GLib from "gi://GLib?version=2.0"
import toml from "toml"
import { exec } from "ags/process"
import { readFile } from "ags/file"
import { isFile } from "./lib/utils"
import app from "ags/gtk4/app"

const instanceSrcDir = exec("pwd").trim()


// Locate and load config
const configFile = findConfigFile()
if (configFile) {
    console.log("Found config file:", configFile)
}
const data = parseToml(readRawFile(configFile))

function findConfigFile(): string | undefined {
    // Candidates ordered by priority (highest first)
    const candidates = [
        `${instanceSrcDir}/config-override.toml`,
        `${instanceSrcDir}/config.toml`,
        // @TODO: add XDG_CONFIG_HOME and $HOME/.config/wam-shell paths here
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
    if (data.os_icon !== undefined) {
        if (typeof (data.os_icon) !== "string") {
            console.error(`Config "os_icon" cannot be typeof ${typeof (data.os_icon)}, must be string`);
        } else {
            return data.os_icon
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
    let override = data.desktop_session_override
    let desktop = GLib.getenv("DESKTOP_SESSION")


    // Preflight checks for override config variable
    if (override !== undefined) {
        if (typeof (override) !== "string") {
            console.error(`Config "desktop_session_override" cannot be typeof ${typeof (override)}, must be string`);
            override = GLib.getenv("DESKTOP_SESSION")  // Fallback
        }

        desktop = override
    }

    // Preflight checks for swaywm
    if (desktop === "sway") {
        if (typeof (GLib.getenv("I3SOCK")) !== "string") {
            console.error(`sway ipc I3SOCK Socket ENV missing`);
            return "" // Fallback
        }

        return "sway"
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


export default class Config {
    static instanceName = data.instance_name || "wam-shell"

    static instanceSrcDir = instanceSrcDir
    static osIcon = getOsIcon()
    static desktopSession = getDesktopSession()

    static swayGaps = (data.sway_gaps === undefined) ? true : data.sway_gaps
    static swayGapsSizeDefault = 10

    static instanceCacheDir = `${GLib.get_user_cache_dir()}/${this.instanceName}`
    static cacheFile = `${this.instanceCacheDir}/cache.json`

    static cssPath = `${this.instanceCacheDir}/style.css`
    static scssPath = `${this.instanceSrcDir}/scss/style.scss`
}