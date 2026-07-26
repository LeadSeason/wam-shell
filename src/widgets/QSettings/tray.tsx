import { createBinding, createState, For, With } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import AstalTray from "gi://AstalTray"
import Config from "../../config"

export default function Tray({ filter }: { filter?: (id: string) => boolean }) {
    const [trayItems, setTrayItems] = createState([] as AstalTray.TrayItem[])
    const registry = AstalTray.get_default() // Singleton.

    // AppImage-based apps ship their icons outside the icon theme and
    // point to them via IconThemePath, which GTK does not search by
    // default. Register each item's path so its icon resolves.
    const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!)
    const addedPaths = new Set<string>()

    registry.connect("item-added", (_, item_id) => {
        const t = registry.get_item(item_id)
        console.log("Tray item added:", t.get_id())

        const path = t.iconThemePath
        if (path && !addedPaths.has(path)) {
            addedPaths.add(path)
            iconTheme.add_search_path(path)
        }

        setTrayItems((items) => {
            if (items.find((item) => item.get_item_id() === item_id)) {
                return items
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

    // TODO: Icons served as raw pixmaps may still not show up.

    const visibleItems = trayItems.as(items =>
        filter ? items.filter(item => filter(item.get_id())) : items
    )

    return (
        <Gtk.FlowBox
            maxChildrenPerLine={8}
            selectionMode={Gtk.SelectionMode.NONE}
            columnSpacing={Config.tray.spacing}
        >
            <For each={visibleItems}>
                {(item) => {
                    const gicon = createBinding(item, "gicon")
                    const tooltip = createBinding(item, "tooltip_markup")

                    /* Isn't reactive */
                    const menuModel = Gtk.PopoverMenu.new_from_model(item.get_menu_model())
                    menuModel.set_has_arrow(false)

                    return (<menubutton
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

                            self.add_controller(gestureClick)
                        }}
                        tooltipMarkup={tooltip}
                        direction={Gtk.ArrowType.DOWN}
                    >
                        <image gicon={gicon} />
                        {menuModel}
                    </menubutton>
                    )
                }}
            </For>
        </Gtk.FlowBox>
    )
}
