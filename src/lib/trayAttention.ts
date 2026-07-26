import AstalTray from "gi://AstalTray"
import { createState } from "ags"

// Tracks whether any tray item reports Status.NeedsAttention.
// Used to show an indicator on the bar when the tray is nested inside
// the quick settings popup (tray.on_panel = false).

const registry = AstalTray.get_default()
const items = new Map<string, AstalTray.TrayItem>()

const [needsAttention, setNeedsAttention] = createState(false)

function update() {
    for (const item of items.values()) {
        if (item.status === AstalTray.Status.NEEDS_ATTENTION) {
            setNeedsAttention(true)
            return
        }
    }
    setNeedsAttention(false)
}

registry.connect("item-added", (_, itemId: string) => {
    const item = registry.get_item(itemId)
    items.set(itemId, item)
    item.connect("notify::status", update)
    update()
})

registry.connect("item-removed", (_, itemId: string) => {
    items.delete(itemId)
    update()
})

export default needsAttention
