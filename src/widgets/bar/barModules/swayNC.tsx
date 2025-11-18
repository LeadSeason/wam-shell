import Gtk from "gi://Gtk?version=4.0";
import SwayNc from "../../../lib/swayNC"
import { execAsync } from "ags/process"
import { createBinding } from "ags";

export default function Notify() {
    const swayNc = SwayNc.get_default();

    const handleClick = (e: Gtk.Button) => {
        execAsync("swaync-client -t -sw")
    }
    const reveal = createBinding(swayNc, "count").as((v) => v > 0)
    const count = createBinding(swayNc, "count").as((v) => v.toString())
    const dnd = createBinding(swayNc, "dnd").as((v) => v ? "" : "")

    return <button
        onClicked={handleClick}
    >
        <box spacing={4}>
            <revealer
                transitionDuration={250}
                transitionType={Gtk.RevealerTransitionType.SLIDE_RIGHT}
                revealChild={reveal}
            >
                <label
                    class="Badge"
                    label={count} />
            </revealer>
                    
            <label label={dnd}/>
        </box>
    </button>
}