import { Gtk } from "ags/gtk4"
import { Accessor } from "gnim"

// Centered empty state for panels with nothing to show (quick
// settings panes, the notification center). The shell keeps one
// consistent size, so an empty panel shows this in the middle instead
// of shrinking to nothing. `child` slots below the hint (e.g. a
// sign-in button).
export function PaneEmpty({
    icon,
    title,
    hint,
    onClick,
    child,
    titleClasses = [],
}: {
    icon: string | Accessor<string>
    title: string | Accessor<string>
    hint: string | Accessor<string>
    onClick?: () => void
    child?: Gtk.Widget
    // extra classes on the title label (e.g. "status" for a provider's
    // sync-error styling)
    titleClasses?: string[]
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
            <label
                cssClasses={["paneEmptyTitle", ...titleClasses]}
                label={title}
                halign={Gtk.Align.CENTER}
            />
            {/* hidden while empty: a blank hint must not take a line */}
            {typeof hint === "string" ? (
                hint !== "" && (
                    <label cssClasses={["paneEmptyHint"]} label={hint} halign={Gtk.Align.CENTER} />
                )
            ) : (
                <label
                    cssClasses={["paneEmptyHint"]}
                    label={hint}
                    halign={Gtk.Align.CENTER}
                    visible={hint.as(h => h !== "")}
                />
            )}
            {child}
        </box>
    )
}
