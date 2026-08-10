import Config, { reloadTheme } from "../config"
import app from "ags/gtk4/app"
import CommandRegistry from "./requestHandler"
import {
    compileAsync,
    compileSync,
    planCompile,
    sassAvailable,
    syncActiveTheme,
} from "./styleCompile"

// The display-side half of styling: deciding when to compile, and
// applying the result to the running app. Everything that actually
// touches sass and the cache dir lives in lib/styleCompile, which has no
// ags/gtk4/app dependency so `wam install` can run it headlessly.

const registry = CommandRegistry.get_default()

/**
 * Swap the running stylesheet for the freshly compiled one.
 *
 * `reset`, always. ags's `apply_css(style, reset = false)` ADDS a
 * Gtk.CssProvider to the display and leaves every earlier one installed,
 * so the three call sites below were stacking a provider per reload and
 * per Dark Style toggle. Two consequences, both reported as bugs about
 * the wrong thing: a rule DELETED from user.scss kept applying (the old
 * provider still had it), and every widget restyle walked a provider
 * list that grew for the life of the session.
 */
function applyStylesheet() {
    app.apply_css(Config.cssPath, true)
}

export function compileScss() {
    const { needed, cold } = planCompile()
    if (!needed) return
    if (cold) {
        // Nothing to show: ags loads the css at activation, so an async
        // compile races the first frame and the shell starts unstyled.
        // This is the ONE blocking path left, and `wam install` /
        // `wam update` precompile precisely so users do not hit it —
        // see scripts/precompile-style.ts
        if (!compileSync()) {
            // Name the actual cause and the actual fix. "Failed to
            // compile styles" sent people looking at their scss, when
            // the overwhelmingly common reason is that dart-sass is not
            // installed at all — an entirely unstyled shell reads as
            // broken rather than as a missing package, and nothing said
            // which. `wam status` reports the same thing.
            console.error(
                sassAvailable()
                    ? "Failed to compile styles; starting unstyled. Check scss/user.scss and the theme for syntax errors."
                    : "dart-sass is not installed, so there is no stylesheet to show and the shell is starting UNSTYLED. Install it (arch: pacman -S dart-sass) and run `wam restart`.",
            )
        }
        return
    }
    // a stale sheet is still a sheet: show it, and swap in the fresh one
    // when sass is done (app.start's css option only covers compiles
    // that finish before activation)
    compileAsync()
        .then(applyStylesheet)
        // a style failure must not take the whole shell down with it
        .catch(e => console.error("Failed to compile styles:", e))
}

export async function reloadStyle() {
    try {
        reloadTheme() // pick up theme config changes without a restart
        // for the side effects, not the verdict: regenerate the
        // active-theme copy the reload may have just changed, and make
        // sure user.scss exists. A request always forces a recompile,
        // fresh cache or not
        planCompile()
        await compileAsync()
        console.log(`${Config.instanceName}: Style reloaded`)
        applyStylesheet()
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
        compileAsync()
            .then(applyStylesheet)
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
    },
})
