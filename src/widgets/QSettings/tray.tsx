import { createBinding, createState, For, With, onCleanup } from "gnim"
import { Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import AstalTray from "gi://AstalTray"
import Config from "../../config"
import { connect, disconnect } from "../../lib/metrics"

export default function Tray({
    filter,
    iconSize = 16,
    pill = false,
    spacing = Config.tray.spacing,
    singleRow = false,
}: {
    filter?: (item: AstalTray.TrayItem) => boolean
    iconSize?: number
    pill?: boolean
    spacing?: number
    // bar only: never wrap to a second line. A wrapping FlowBox grows
    // the whole panel — the bar's heightRequest is a floor, not a cap,
    // so a 9th tray item used to produce a full-width strip under the
    // bar holding the overflow icons. Quick settings wants the grid,
    // the bar does not.
    singleRow?: boolean
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

    // disconnected when this instance is destroyed (the bar mount dies
    // with its monitor on hotplug): gnim only auto-disposes JSX-prop
    // bindings, not manual connects
    function addItem(t: AstalTray.TrayItem, item_id: string) {
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
    }

    // backfill items that registered before this instance connected —
    // the bar's Tray is recreated on monitor hotplug and would
    // otherwise come up empty until each app re-registers (never)
    for (const t of registry.get_items() ?? []) addItem(t, t.get_item_id())

    const registryHandlers = [
        connect(registry, "item-added", (_: AstalTray.Tray, item_id: string) =>
            addItem(registry.get_item(item_id), item_id),
        ),

        connect(registry, "item-removed", (_: AstalTray.Tray, item_id: string) => {
            // drop this item's claim on any path it owned; entries whose
            // last owner left are pruned so the map tracks live items only
            for (const [path, owners] of pathOwners) {
                if (owners.delete(item_id) && owners.size === 0) pathOwners.delete(path)
            }
            // Filter on item.get_item_id() NOT item.get_id().
            setTrayItems(items => items.filter(item => item.get_item_id() !== item_id))
        }),
    ]
    onCleanup(() => {
        for (const id of registryHandlers) disconnect(registry, id)
    })

    // TODO: Icons served as raw pixmaps may still not show up.

    const visibleItems = trayItems.as(items => (filter ? items.filter(filter) : items))

    // spacing semantics: 0 = no inline margins, so stylesheet rules
    // (incl. user.scss) control the icon gap; >0 = multiplier of the
    // 6px base unit ($bar-widget-spacing in conf.scss), applied as an
    // inline margin on each icon
    const BASE = 6
    const gap = spacing > 0 ? spacing * BASE : null

    const renderItem = (item: AstalTray.TrayItem) => {
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

                    connect(gestureClick, "pressed", (event: Gtk.GestureClick) => {
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
                            ? `min-width: ${iconSize + 12}px; min-height: ${iconSize + 12}px;`
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
    }

    if (singleRow) {
        return (
            <box>
                <For each={visibleItems}>{renderItem}</For>
            </box>
        )
    }

    return (
        <Gtk.FlowBox
            maxChildrenPerLine={8}
            selectionMode={Gtk.SelectionMode.NONE}
            columnSpacing={0}
            rowSpacing={gap ?? 0}
            // only has an effect inside the quick settings window
            cssClasses={["QSSection"]}
        >
            <For each={visibleItems}>{renderItem}</For>
        </Gtk.FlowBox>
    )
}
