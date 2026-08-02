import { Gtk } from "ags/gtk4"

// Centered empty state for panes with nothing to show. The quick
// settings shell keeps one consistent size across panes, so an empty
// pane shows this in the middle instead of shrinking to nothing.
export function PaneEmpty({
    icon,
    title,
    hint,
    onClick,
}: {
    icon: string
    title: string
    hint: string
    onClick?: () => void
}) {
    return (
        <box
            orientation={Gtk.Orientation.VERTICAL}
            cssClasses={["paneEmpty"]}
            valign={Gtk.Align.CENTER}
            vexpand
            // fill the pane's width too: the children center themselves
            // (halign CENTER), so the whole cluster sits in the middle
            // instead of hugging the left edge
            hexpand
            spacing={6}
        >
            {onClick && <Gtk.GestureClick button={1} onPressed={onClick} />}
            <box cssClasses={["paneEmptyIcon"]} halign={Gtk.Align.CENTER}>
                <image iconName={icon} pixelSize={22} />
            </box>
            <label cssClasses={["paneEmptyTitle"]} label={title} halign={Gtk.Align.CENTER} />
            <label cssClasses={["paneEmptyHint"]} label={hint} halign={Gtk.Align.CENTER} />
        </box>
    )
}
