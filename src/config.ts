import GLib from "gi://GLib?version=2.0";
import { exec } from "ags/process";

const osRelease = exec("cat /etc/os-release")
const logo = (osRelease.match(/^LOGO=(.+)$/m)?.[1] ?? "").replace(/^"|"$/g, ""); // gpt

export default class Config {
    static instanceName = "wam-shell";

    static instanceSrcDir = exec("pwd") // Will resolve correctly even if user launches in different dir.
    // osIcon Filepath or icon name
    // static osIcon = `${this.instanceSrcDir}/assets/polyarch.png`
    static osIcon = `${logo}`

    static instanceCacheDir= `${GLib.get_user_cache_dir()}/${this.instanceName}`
    static cacheFile = `${this.instanceCacheDir}/cache.json`

    static cssPath = `${this.instanceCacheDir}/style.css`
    static scssPath = `${this.instanceSrcDir}/scss/style.scss`
}