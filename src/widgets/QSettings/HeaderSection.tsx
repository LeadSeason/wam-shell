import { Gtk } from "ags/gtk4";

export function HeaderSection() {
    // @TODO default avatar "avatar-default-symbolic"
    // @TODO make avatar a circle or make the corners rounded, Css cannot do this
    // @TODO Implement functions

    // @TODO Implement Battery,
    return <box cssClasses={["QSHeader", "QSSection"]}>
        <image cssClasses={["QSPFP"]} file={"assets/pfp.jpg"} pixelSize={32} />
        <box cssClasses={["QSBat"]} orientation={Gtk.Orientation.VERTICAL}>
            <box>
                <image iconName={"battery-040-symbolic"} />
                <label label={"42 %"} />
            </box>
            <label label={"2 hours 34 minutes"} />
        </box>
        <button hexpand halign={Gtk.Align.END} iconName={"system-lock-screen-symbolic"} />
        <button iconName={"system-log-out-symbolic"} />
        <button iconName={"system-shutdown-panel-symbolic"} />
    </box>;
}
