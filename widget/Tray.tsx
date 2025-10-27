import { createState, For } from "ags"
import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import AstalTray from "gi://AstalTray"

export default function Tray() {
  const [trayItems, setTrayItems] = createState([] as AstalTray.TrayItem[])
  const registry = AstalTray.get_default() // Singleton.

  registry.connect("item-added", (_, item_id) => {
    const t = registry.get_item(item_id)
    setTrayItems((items) => {
      if (items.find((item) => item.get_item_id() === item_id)) {
        items
      }
      return [...items, t]
    })
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
            <menubutton
              $={(self) =>
                self.insert_action_group("dbusmenu", item.get_action_group())
              }
              tooltipMarkup={item.tooltipMarkup}
            >
              <image gicon={item.get_gicon()} tooltip-text={item.get_title()} />
              {Gtk.PopoverMenu.new_from_model(item.get_menu_model())}
            </menubutton>
          )}
        </For>
      </box>
    </window>
  )
}
