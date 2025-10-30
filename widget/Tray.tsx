import { createState, For } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
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
              $={(self) => {
                self.insert_action_group("dbusmenu", item.get_action_group())
                const gestureClick = new Gtk.GestureClick({
                  button: 0, // Listen to all buttons.
                })

                gestureClick.connect("pressed", (event) => {
                  // Prevent default behavior.
                  event.set_state(Gtk.EventSequenceState.CLAIMED)

                  switch (event.get_current_button()) {
                    case Gdk.BUTTON_PRIMARY:
                      item.activate(0, 0)
                      break
                    case Gdk.BUTTON_SECONDARY:
                      self.get_popover()?.popup()
                      break
                    default:
                  }
                })

                // TODO: self.add_controller(gestureClick)
              }}
              tooltipMarkup={item.tooltipMarkup}
              direction={Gtk.ArrowType.DOWN}
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
