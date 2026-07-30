import app from "ags/gtk4/app"
import CommandRegistry from "./commandRegistry"

const registry = CommandRegistry.get_default()

// registered here, not in commandRegistry.ts: it needs ags/gtk4/app,
// which runs Gtk.init() at import (display required)
registry.register({
    name: ["quit", "exit"],
    description: "quit Application",
    help: `Exits the app`,
    main: () => {
        app.quit(0)
        return "exiting ..."
    },
})

// requestHandler, Pass this to app.start()
export async function requestHandler(argv: string[], res: (response: string) => void) {
    res(await registry.execute(argv))
}

export default CommandRegistry
