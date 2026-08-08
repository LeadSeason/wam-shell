import Config, { reloadTheme } from "../config"
import app from "ags/gtk4/app"
import CommandRegistry from "./requestHandler"
import { compileAsync, compileSync, planCompile, syncActiveTheme } from "./styleCompile"

// The display-side half of styling: deciding when to compile, and
// applying the result to the running app. Everything that actually
// touches sass and the cache dir lives in lib/styleCompile, which has no
// ags/gtk4/app dependency so `wam install` can run it headlessly.

const registry = CommandRegistry.get_default()

export function compileScss() {
    const { needed, cold } = planCompile()
    if (!needed) return
    if (cold) {
        // Nothing to show: ags loads the css at activation, so an async
        // compile races the first frame and the shell starts unstyled.
        // This is the ONE blocking path left, and `wam install` /
        // `wam update` precompile precisely so users do not hit it —
        // see scripts/precompile-style.ts
        if (!compileSync()) console.error("Failed to compile styles; starting unstyled")
        return
    }
    // a stale sheet is still a sheet: show it, and swap in the fresh one
    // when sass is done (app.start's css option only covers compiles
    // that finish before activation)
    compileAsync()
        .then(() => app.apply_css(Config.cssPath))
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
        compileAsync()
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
    },
})
