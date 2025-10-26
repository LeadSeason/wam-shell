import { createState, For } from "ags"
import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import AstalTray from "gi://AstalTray"

export default function Tray() {
  const [trayItems, setTrayItems] = createState([] as AstalTray.TrayItem[])
  const registry = AstalTray.get_default() // Singleton.

  registry.connect("item-added", (_, item_id) => {
    const t = registry.get_item(item_id)
    setTrayItems((items) => [...items, t])
  })

  registry.connect("item-removed", (_, item_id) => {
    // Filter on item.get_item_id() NOT item.get_id().
    setTrayItems((items) =>
      items.filter((item) => item.get_item_id() !== item_id)
    )
  })

  return (
    <window visible application={app}>
      <box orientation={Gtk.Orientation.HORIZONTAL}>
        <For each={trayItems}>
          {(item) => (
            <image gicon={item.get_gicon()} tooltip-text={item.get_title()} />
          )}
        </For>
      </box>
    </window>
  )
}
