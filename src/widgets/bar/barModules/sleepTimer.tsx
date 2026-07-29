import { Gtk } from "ags/gtk4"
import { formatRemaining, remaining } from "../../../lib/sleepTimer"

// Sleep timer countdown (lib/sleepTimer). Only visible while a timer
// is running, so it costs no panel space otherwise.
export default function SleepTimer() {
    return <box
        cssClasses={["sleepTimer"]}
        spacing={4}
        visible={remaining.as(s => s > 0)}
    >
        <image iconName="alarm-symbolic" />
        <label label={remaining.as(formatRemaining)} />
    </box>
}
