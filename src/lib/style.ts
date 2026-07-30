import { execAsync } from "ags/process"
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Config, { reloadTheme } from "../config"
import app from "ags/gtk4/app"
import { readFile } from "ags/file"
import { isFile } from "./utils"
import CommandRegistry from "./requestHandler"

const registry = CommandRegistry.get_default()

const scssDir = `${Config.instanceSrcDir}/scss`
const themeDir = `${scssDir}/theme`
// generated outside the source tree: the tree is read-only on
// system-wide installs. scss files import it by bare name and sass
// resolves that through the cache dir load path below
const activeThemePath = `${Config.instanceCacheDir}/active-theme.scss`

// array form: no shell, so a repo path with spaces can't break the
// command. Load paths keep bare-name imports resolving no matter where
// the importing file lives: the cache dir for the generated
// active-theme, the theme dir and the scss dir for user styles
function sassArgs(): string[] {
    return [
        "sass",
        "--load-path",
        Config.instanceCacheDir,
        "--load-path",
        themeDir,
        "--load-path",
        scssDir,
        Config.scssPath,
        Config.cssPath,
    ]
}

// the configured theme is what scss files import as active-theme.
// Returns true when the copy changed: a theme switch in the config
// touches no scss mtime, so the freshness sweep alone would miss it
function syncActiveTheme(): boolean {
    const srcPath = `${themeDir}/${Config.theme}.scss`
    try {
        if (readFile(activeThemePath) === readFile(srcPath)) return false
    } catch {
        /* missing or unreadable copy → (re)generate it */
    }
    Gio.File.new_for_path(srcPath).copy(
        Gio.File.new_for_path(activeThemePath),
        Gio.FileCopyFlags.OVERWRITE,
        null,
        null,
    )
    return true
}

// user.scss holds personal overrides (gitignored, created if missing)
function ensureUserScss() {
    const path = `${scssDir}/user.scss`
    if (isFile(path)) return
    try {
        GLib.file_set_contents(path, "")
    } catch {
        // read-only source tree: an empty file in the cache dir still
        // satisfies the `@use "user.scss"` through the load path
        GLib.file_set_contents(`${Config.instanceCacheDir}/user.scss`, "")
    }
}

function mtimeUsec(info: Gio.FileInfo): number {
    return (
        info.get_attribute_uint64("time::modified") * 1e6 +
        info.get_attribute_uint32("time::modified-usec")
    )
}

// newest mtime anywhere under dir, dir mtimes included (a copied-in
// file may keep an old mtime; its parent dir's can't). Unreadable dirs
// return Infinity so the freshness check errs on recompiling
function newestMtime(dir: string): number {
    try {
        const f = Gio.File.new_for_path(dir)
        let newest = mtimeUsec(
            f.query_info(
                "time::modified,time::modified-usec",
                Gio.FileQueryInfoFlags.NONE,
                null,
            ),
        )
        const en = f.enumerate_children(
            "standard::name,standard::type,time::modified,time::modified-usec",
            Gio.FileQueryInfoFlags.NONE,
            null,
        )
        let info: Gio.FileInfo | null
        while ((info = en.next_file(null)) !== null) {
            const m =
                info.get_file_type() === Gio.FileType.DIRECTORY
                    ? newestMtime(`${dir}/${info.get_name()}`)
                    : mtimeUsec(info)
            if (m > newest) newest = m
        }
        return newest
    } catch {
        return Infinity
    }
}

function cssIsFresh(): boolean {
    try {
        const cssMtime = mtimeUsec(
            Gio.File.new_for_path(Config.cssPath).query_info(
                "time::modified,time::modified-usec",
                Gio.FileQueryInfoFlags.NONE,
                null,
            ),
        )
        return newestMtime(scssDir) <= cssMtime
    } catch {
        return false
    }
}

export function compileScss() {
    const themeChanged = syncActiveTheme()
    ensureUserScss()
    // sass is the slowest part of startup; when no input is newer than
    // the emitted css, the cached file is reused as-is
    if (!themeChanged && isFile(Config.cssPath) && cssIsFresh()) return
    if (!isFile(Config.cssPath)) {
        // cold start: ags loads the css at activation, so it must exist
        // synchronously — the async path races the first frame and the
        // shell starts unstyled
        try {
            Gio.Subprocess.new(sassArgs(), Gio.SubprocessFlags.NONE).wait(null)
        } catch (e) {
            // a style failure must not take the whole shell down with it
            console.error("Failed to compile styles:", e)
        }
        return
    }
    execAsync(sassArgs())
        // app.start's css option only covers compiles that finish before
        // activation — apply the result ourselves when sass is done
        .then(() => app.apply_css(Config.cssPath))
        // a style failure must not take the whole shell down with it
        .catch(e => console.error("Failed to compile styles:", e))
}

export async function reloadStyle() {
    try {
        reloadTheme() // pick up theme config changes without a restart
        syncActiveTheme()
        ensureUserScss()
        // a request always forces a recompile, fresh cache or not
        await execAsync(sassArgs())
        console.log(`${Config.instanceName}: Style reloaded`)
        app.apply_css(Config.cssPath)
        return "Style reloaded"
    } catch (e) {
        console.log(e)
        return "Failed to apply style"
    }
}

/** switch the shell theme live (Dark Style toggle). Not persisted —
 *  the config file's theme key wins again on restart. */
export function setThemeLive(theme: string) {
    try {
        Config.theme = theme
        syncActiveTheme()
        execAsync(sassArgs())
            .then(() => app.apply_css(Config.cssPath))
            .catch(e => console.warn("setThemeLive failed:", e))
    } catch (e) {
        console.warn("setThemeLive failed:", e)
    }
}

registry.register({
    name: ["reloadStyle", "reloadstyle", "style"],
    description: "Reloads the style",
    help: "Reloads the style from the scss files",
    main: async () => {
        return await reloadStyle()
    }
})
