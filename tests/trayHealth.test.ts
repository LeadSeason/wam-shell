import { test, eq } from "./framework"
import { itemBusName, hasRenderableContent } from "../src/lib/trayHealth"

test("itemBusName: well-known name + custom path", () => {
    eq(
        itemBusName(
            "org.freedesktop.StatusNotifierItem-6425-1/StatusNotifierItem/1/StatusNotifierItem",
        ),
        "org.freedesktop.StatusNotifierItem-6425-1",
    )
})

test("itemBusName: unique name", () => {
    eq(itemBusName(":1.22/org/ayatana/NotificationItem/nm_applet"), ":1.22")
})

test("itemBusName: id without a path is not a name", () => {
    eq(itemBusName("orphan"), null)
})

const item = (over: Record<string, unknown>) =>
    ({
        gicon: null,
        title: null,
        tooltip_markup: null,
        ...over,
    }) as any

test("hasRenderableContent: hollow registration has nothing", () => {
    eq(hasRenderableContent(item({})), false)
    eq(hasRenderableContent(item({ title: "", tooltip_markup: "" })), false)
})

test("hasRenderableContent: icon alone renders", () => {
    eq(hasRenderableContent(item({ gicon: {} })), true)
})

test("hasRenderableContent: title alone renders", () => {
    eq(hasRenderableContent(item({ title: "Some App" })), true)
})

test("hasRenderableContent: tooltip alone renders", () => {
    eq(hasRenderableContent(item({ tooltip_markup: "Some App" })), true)
})
