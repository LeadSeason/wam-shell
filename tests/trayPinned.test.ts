import { test, eq } from "./framework"
import { isPinned } from "../src/lib/trayPinned"

// the harness runs with an empty XDG_CONFIG_HOME, so the resolved config
// has tray.always_on_panel = [] and nothing pins
const item = (over: Record<string, unknown>) => ({
    get_id: () => "some-app",
    get_title: () => "Some App",
    iconName: "some-app-icon",
    tooltip_markup: "<b>Some App</b>",
    ...over,
}) as any

test("isPinned: nothing pinned by default", () => {
    eq(isPinned(item({})), false)
})

test("isPinned: missing tooltip does not throw", () => {
    eq(isPinned(item({ tooltip_markup: null })), false)
})
