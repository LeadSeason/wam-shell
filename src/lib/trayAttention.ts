import AstalTray from "gi://AstalTray"
import { createState } from "gnim"
import { isPinned } from "./trayPinned"
import { connect, disconnect } from "./metrics"

// Tracks whether any tray item reports Status.NeedsAttention.
// Used to show an indicator on the bar when the tray is nested inside
// the quick settings popup (tray.on_panel = false). Pinned items
// (tray.always_on_panel) are visible on the bar already and are ignored.

const registry = AstalTray.get_default()
const items = new Map<string, AstalTray.TrayItem>()
// per-item notify::status handler ids, tracked so they can be
// disconnected when the item goes away and at teardown
const itemHandlers = new Map<string, number>()

const [needsAttention, setNeedsAttention] = createState(false)

function update() {
    for (const item of items.values()) {
        if (isPinned(item)) continue
        if (item.status === AstalTray.Status.NEEDS_ATTENTION) {
            setNeedsAttention(true)
            return
        }
    }
    setNeedsAttention(false)
}

const registryHandlers = [
    connect(registry, "item-added", (_: AstalTray.Tray, itemId: string) => {
        const item = registry.get_item(itemId)
        console.log(
            "Tray item added:",
            `${item.tooltip_markup || item.get_title() || "?"} (id: ${item.get_id()})`,
        )
        items.set(itemId, item)
        itemHandlers.set(itemId, connect(item, "notify::status", update))
        update()
    }),

    connect(registry, "item-removed", (_: AstalTray.Tray, itemId: string) => {
        const item = items.get(itemId)
        const handler = itemHandlers.get(itemId)
        if (item && handler !== undefined) disconnect(item, handler)
        itemHandlers.delete(itemId)
        items.delete(itemId)
        update()
    }),
]

// convention for lib modules with long-lived sources, even though the
// shell never calls it today: one place that tears everything down
export function dispose() {
    for (const id of registryHandlers) disconnect(registry, id)
    registryHandlers.length = 0
    for (const [itemId, id] of itemHandlers) {
        const item = items.get(itemId)
        if (item) disconnect(item, id)
    }
    itemHandlers.clear()
    items.clear()
}

export default needsAttention
