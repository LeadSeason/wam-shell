import { exec, execAsync } from "ags/process"
import Config from "../config"
import app from "ags/gtk4/app"
import CommandRegistry from "./requestHandler"

const registry = CommandRegistry.get_default()

export function compileScss() {
    // the configured theme is what scss files import as active-theme
    exec(`cp ${Config.instanceSrcDir}/scss/theme/${Config.theme}.scss ${Config.instanceSrcDir}/scss/theme/active-theme.scss`)
    exec(`sass ${Config.scssPath} ${Config.cssPath}`)
}

export async function reloadStyle() {
    try {
        exec(`cp ${Config.instanceSrcDir}/scss/theme/${Config.theme}.scss ${Config.instanceSrcDir}/scss/theme/active-theme.scss`)
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
    help: "Reloads the style from ",
    main: async () => {
        return await reloadStyle()
    }
})