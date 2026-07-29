import { exec, execAsync } from "ags/process"
import Config, { reloadTheme } from "../config"
import app from "ags/gtk4/app"
import CommandRegistry from "./requestHandler"

const registry = CommandRegistry.get_default()

export function compileScss() {
    // the configured theme is what scss files import as active-theme;
    // user.scss holds personal overrides (gitignored, created if missing)
    exec(`cp ${Config.instanceSrcDir}/scss/theme/${Config.theme}.scss ${Config.instanceSrcDir}/scss/theme/active-theme.scss`)
    exec(`touch ${Config.instanceSrcDir}/scss/user.scss`)
    exec(`sass ${Config.scssPath} ${Config.cssPath}`)
}

export async function reloadStyle() {
    try {
        reloadTheme() // pick up theme config changes without a restart
        exec(`cp ${Config.instanceSrcDir}/scss/theme/${Config.theme}.scss ${Config.instanceSrcDir}/scss/theme/active-theme.scss`)
        exec(`touch ${Config.instanceSrcDir}/scss/user.scss`)
        await execAsync(`sass ${Config.scssPath} ${Config.cssPath}`)
        console.log(`${Config.instanceName}: Style reloaded`)
        app.apply_css(Config.cssPath)
        return "Style reloaded"
    } catch (e) {
        console.log(e)
        return "Failed to apply style"
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