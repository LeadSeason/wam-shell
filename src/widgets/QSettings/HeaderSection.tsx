import { Gtk } from "ags/gtk4";
import Pango from "gi://Pango?version=1.0";
import GLib from "gi://GLib?version=2.0";
import { execAsync } from "ags/process";
import { createPoll } from "ags/time";
import AstalBattery from "gi://AstalBattery?version=0.1";
import { createBinding, createState } from "gnim";

function BatWidget() {
    const bat = AstalBattery.get_default()
    const batIcon = createBinding(bat, "batteryIconName")
    const batProc = createBinding(bat, "percentage")

    const batTimeConvert = (timeRemaining: number, charging: boolean): string => {
        if (timeRemaining <= 0) return charging ? "Full" : "?";

        const hours = Math.floor(timeRemaining / 3600);
        const minutes = Math.floor((timeRemaining % 3600) / 60);

        const time = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        return charging ? `${time} to full` : `${time} left`;
    };

    const currentBatTime = (): string =>
        batTimeConvert(bat.charging ? bat.timeToFull : bat.timeToEmpty, bat.charging)

    const [batTime, setBatTime] = createState(currentBatTime())

    // Debounce: UPower oscillates around the charge limit (charging state
    // and time estimates flip back and forth), only update the label once
    // the computed text has been stable for a few seconds.
    let pendingSource: number | null = null
    let pendingValue: string | null = null

    function updateBatTime() {
        const raw = currentBatTime()

        if (raw === batTime.get()) {
            // back to the displayed value, drop any pending change
            if (pendingSource !== null) {
                GLib.source_remove(pendingSource)
                pendingSource = null
                pendingValue = null
            }
            return
        }
        if (raw === pendingValue) return

        if (pendingSource !== null) GLib.source_remove(pendingSource)
        pendingValue = raw
        pendingSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            pendingSource = null
            pendingValue = null
            setBatTime(raw)
            return GLib.SOURCE_REMOVE
        })
    }

    createBinding(bat, "timeToEmpty").subscribe(updateBatTime)
    createBinding(bat, "timeToFull").subscribe(updateBatTime)
    createBinding(bat, "charging").subscribe(updateBatTime)

    return <box cssClasses={["QSBat"]} orientation={Gtk.Orientation.VERTICAL}>
        <box>
            <image iconName={batIcon} />
            <label label={batProc.as(v => `${(v * 100).toFixed(0)} %`)} />
        </box>
        <label
            label={batTime}
            xalign={0}
            maxWidthChars={20}
            ellipsize={Pango.EllipsizeMode.END}
        />
    </box>
}

const uptimeConvert = (uptimeOutput: string): string => {
    // Example input:
    // "13:22:26 up 16 days, 10:51,  1 user,  load average: 3.14, 2.97, 2.41"

    const upMatch = uptimeOutput.match(/up\s+(.*?),\s+\d+\s+user/);
    if (!upMatch) return "";

    const upPart = upMatch[1].trim(); // "16 days, 10:51"

    let days = 0;
    let hours = 0;
    let minutes = 0;

    // Days
    const dayMatch = upPart.match(/(\d+)\s+day/);
    if (dayMatch) {
        days = parseInt(dayMatch[1], 10);
    }

    // Time (HH:MM)
    const timeMatch = upPart.match(/(\d+):(\d+)/);
    if (timeMatch) {
        hours = parseInt(timeMatch[1], 10);
        minutes = parseInt(timeMatch[2], 10);
    }

    const parts: string[] = [];

    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 && days < 0) parts.push(`${minutes}m`);

    return `Up ${parts.join(" ")}`;
};

const loadConvert = (uptimeOutput: string): string => {
    // "load average: 3.14, 2.97, 2.41"
    const loadMatch = uptimeOutput.match(
        /load average:\s*([\d.]+),?\s*([\d.]+),?\s*([\d.]+)/
    );

    if (!loadMatch) return "";

    const [, one, five, fifteen] = loadMatch;
    return `Load ${one} ${five} ${fifteen}`;
};

function Uptime() {
    const [uptime, setUptime] = createState("")
    const [sysLoad, setSysLoad] = createState("")
    const poll = createPoll("", 1000, async () => {
        let val = ""
        await execAsync("uptime").then((v) => {
            val = v
        })
        return val
    })
    poll.subscribe(() => {
        let v = poll.peek()
        setUptime(uptimeConvert(v))
        setSysLoad(loadConvert(v))
    })
    // xalign Aligns text to the left side
    return <box cssClasses={["QSBat"]} orientation={Gtk.Orientation.VERTICAL}>
        <label
            xalign={0}
            label={uptime}
            maxWidthChars={20}
            ellipsize={Pango.EllipsizeMode.END}
        />
        <label
            xalign={0}
            label={sysLoad}
            maxWidthChars={20}
            ellipsize={Pango.EllipsizeMode.END}
        />
    </box>
}

export function HeaderSection() {
    // @TODO default avatar "avatar-default-symbolic"
    // @TODO make avatar a circle or make the corners rounded, Css cannot do this
    // @TODO Implement functions
    // @TODO have a Are you sure warning before turning the computer off.

    let batWidget = <></>
    const bat = AstalBattery.get_default()
    if (bat.isPresent) {
        batWidget = <BatWidget />
    } else {
        batWidget = <Uptime />
    }

    return <box cssClasses={["QSHeader", "QSSection"]}>
        <image cssClasses={["QSPFP"]} file={"assets/pfp.jpg"} pixelSize={32} />
        {batWidget}
        <button hexpand halign={Gtk.Align.END} iconName={"system-lock-screen-symbolic"} />
        <button iconName={"system-log-out-symbolic"} />
        <button iconName={"system-shutdown-panel-symbolic"} />
    </box>;
}
