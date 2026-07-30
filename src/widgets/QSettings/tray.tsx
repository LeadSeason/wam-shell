import { createBinding, createState, For, With } from "gnim"
import { Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import AstalTray from "gi://AstalTray"
import Config from "../../config"

export default function Tray({
    filter,
    iconSize = 16,
    pill = false,
    spacing = Config.tray.spacing,
}: {
    filter?: (item: AstalTray.TrayItem) => boolean
    iconSize?: number
    pill?: boolean
    spacing?: number
}) {
    const [trayItems, setTrayItems] = createState([] as AstalTray.TrayItem[])
    const registry = AstalTray.get_default() // Singleton.

    // AppImage-based apps ship their icons outside the icon theme and
    // point to them via IconThemePath, which GTK does not search by
    // default. Register each item's path so its icon resolves. Track
    // which live item provided each path so the bookkeeping stays
    // bounded (GTK4 has no icon-theme path removal, so the theme keeps
    // a retired path, but the map no longer grows without bound).
    const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!)
    const pathOwners = new Map<string, Set<string>>() // path -> item ids

    registry.connect("item-added", (_, item_id) => {
        const t = registry.get_item(item_id)

        const path = t.iconThemePath
        if (path) {
            let owners = pathOwners.get(path)
            if (!owners) {
                owners = new Set()
                pathOwners.set(path, owners)
                iconTheme.add_search_path(path)
            }
            owners.add(item_id)
        }

        setTrayItems(items => {
            if (items.find(item => item.get_item_id() === item_id)) {
                return items
            }
            return [...items, t]
        })
    })

    registry.connect("item-removed", (_, item_id) => {
        // drop this item's claim on any path it owned; entries whose
        // last owner left are pruned so the map tracks live items only
        for (const [path, owners] of pathOwners) {
            if (owners.delete(item_id) && owners.size === 0) pathOwners.delete(path)
        }
        // Filter on item.get_item_id() NOT item.get_id().
        setTrayItems(items => items.filter(item => item.get_item_id() !== item_id))
    })

    // TODO: Icons served as raw pixmaps may still not show up.

    const visibleItems = trayItems.as(items => (filter ? items.filter(filter) : items))

    // spacing semantics: 0 = no inline margins, so stylesheet rules
    // (incl. user.scss) control the icon gap; >0 = multiplier of the
    // 6px base unit ($bar-widget-spacing in conf.scss), applied as an
    // inline margin on each icon
    const BASE = 6
    const gap = spacing > 0 ? spacing * BASE : null

    return (
        <Gtk.FlowBox
            maxChildrenPerLine={8}
            selectionMode={Gtk.SelectionMode.NONE}
            columnSpacing={0}
            rowSpacing={gap ?? 0}
            // only has an effect inside the quick settings window
            cssClasses={["QSSection"]}
        >
            <For each={visibleItems}>
                {item => {
                    const gicon = createBinding(item, "gicon")
                    const tooltip = createBinding(item, "tooltip_markup")

                    /* Isn't reactive */
                    const menuModel = Gtk.PopoverMenu.new_from_model(item.get_menu_model())
                    menuModel.set_has_arrow(false)

                    return (
                        <menubutton
                            $={self => {
                                self.insert_action_group("dbusmenu", item.get_action_group())
                                const gestureClick = new Gtk.GestureClick({
                                    button: 0, // Listen to all buttons.
                                })

                                gestureClick.connect("pressed", event => {
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
                            cssClasses={["trayItem"]}
                            css={
                                [
                                    gap !== null ? `margin-right: ${gap}px;` : "",
                                    pill
                                        ? `min-width: ${iconSize + 22}px; min-height: ${iconSize + 22}px;`
                                        : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ") || ""
                            }
                        >
                            <image gicon={gicon} pixelSize={iconSize} />
                            {menuModel}
                        </menubutton>
                    )
                }}
            </For>
        </Gtk.FlowBox>
    )
}
