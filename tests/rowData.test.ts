import { test, eq } from "./framework"
import { fromItem } from "../src/widgets/notifications/rowData"
import type { ProviderItem } from "../src/lib/notificationProviders"

// fromItem is the half that needs no GDK display: fromDesktop resolves
// icons through the theme and cannot run headless. Both go through the
// same `distinct` rule, which is what these pin.
const item = (over: Partial<ProviderItem>): ProviderItem =>
    ({
        id: "p:1",
        provider: "p",
        time: 1_700_000_000,
        appName: "App",
        summary: "",
        body: "",
        iconName: "icon-symbolic",
        url: "",
        hide: () => {},
        dismiss: () => {},
        activate: () => {},
        ...over,
    }) as ProviderItem

test("rowData: a summary that says something is kept", () => {
    const r = fromItem(item({ summary: "Sync complete", body: "1,204 files" }))
    eq(r.summary, "Sync complete")
    eq(r.body, "1,204 files")
})

test("rowData: a summary that only repeats the app name is dropped", () => {
    // the monux/monux row: an app whose summary IS its name printed the
    // name twice, once as the header and once as the headline
    eq(fromItem(item({ appName: "monux", summary: "monux" })).summary, "")
})

test("rowData: a body that repeats the app name or the summary is dropped", () => {
    eq(fromItem(item({ appName: "monux", body: "monux" })).body, "")
    eq(fromItem(item({ summary: "Sync complete", body: "Sync complete" })).body, "")
})

test("rowData: the repeat check ignores surrounding whitespace", () => {
    eq(fromItem(item({ appName: "monux", summary: "  monux  " })).summary, "")
})

test("rowData: whitespace-only text counts as absent", () => {
    eq(fromItem(item({ summary: "   " })).summary, "")
    eq(fromItem(item({ body: "\n" })).body, "")
})

test("rowData: a body may repeat a summary that was itself dropped", () => {
    // summary == appName so the summary goes; the body then carries the
    // same words, and dropping it too would leave a row saying nothing
    const r = fromItem(item({ appName: "monux", summary: "monux", body: "monux" }))
    eq(r.summary, "")
    eq(r.body, "")
})

test("rowData: base direction comes from the summary, falling back to the app name", () => {
    eq(fromItem(item({ summary: "مايا أورتيز" })).rtl, true)
    eq(fromItem(item({ summary: "Maya Ortiz" })).rtl, false)
    // no summary: the app name decides
    eq(fromItem(item({ appName: "واتساب" })).rtl, true)
})

test("rowData: provider items carry no urgency of their own", () => {
    eq(fromItem(item({ summary: "x" })).urgency, "normal")
})

test("rowData: actions map across, absent becomes an empty list", () => {
    eq(fromItem(item({})).actions, [])
    eq(fromItem(item({ actions: [{ id: "done", label: "Mark done", run: () => {} }] })).actions, [
        { id: "done", label: "Mark done" },
    ])
})
