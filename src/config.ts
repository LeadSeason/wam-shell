import GLib from "gi://GLib?version=2.0"
import toml from "toml"
import { exec } from "ags/process"
import { readFile } from "ags/file"

import { isFile } from "./lib/utils"

const instanceSrcDir = exec("pwd").trim()

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

function extractOsIconFromRelease(): string {
	try {
		const content = readFile("/etc/os-release") || ""
		const match = content.match(/^LOGO=(.+)$/m)?.[1] ?? ""
		return match.replace(/^"|"$/g, "")
	} catch (err) {
		console.error("Failed to parse /etc/os-release for LOGO=\n", err)
	}

	return ""
}


// Locate and load config
const configFile = findConfigFile()
if (configFile) {
    console.log("Found config file:", configFile)
}
const data = parseToml(readRawFile(configFile))

const osIcon = data.os_icon || extractOsIconFromRelease()
const desktopSession = data.desktop_session || (GLib.getenv("DESKTOP_SESSION") || "")

export default class Config {
	static instanceName = data.instance_name || "wam-shell"

	static instanceSrcDir = instanceSrcDir
	static osIcon = osIcon
	static desktopSession = desktopSession

	static instanceCacheDir = `${GLib.get_user_cache_dir()}/${this.instanceName}`
	static cacheFile = `${this.instanceCacheDir}/cache.json`

	static cssPath = `${this.instanceCacheDir}/style.css`
	static scssPath = `${this.instanceSrcDir}/scss/style.scss`
}