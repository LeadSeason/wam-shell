import { createBinding } from "gnim"
import Brightness from "../../../lib/brightness"
import { Gtk } from "ags/gtk4"

function DisplayBrightness() {
    const brightness = Brightness.get_default()
    // @TODO, Switch to use icons instead of nerdfonts 
    const icons = [ '󰃛', '󰃜', '󰃞', '󰃟', '󰃝', '󰃠' ]
    // Return box instead of everything.
    if (!brightness.screenIsPresent)
        return <box></box>

    return <box>
        <Gtk.EventControllerScroll
            flags={Gtk.EventControllerScrollFlags.VERTICAL}
            onScroll={(
                source: Gtk.EventControllerScroll,
                arg0: number,
                arg1: number
            ) => {
                // @TODO, This is really slow, Like really.
                brightness.screen += arg1 / 150
                return true
            }}
        />
        <label label={createBinding(brightness, "screen").as((v: number) =>
            `${Math.floor(v * 100)}% ${icons[Math.floor(v * 5)]}`
            )} />
    </box>
}