import { Gtk } from "ags/gtk4";
import { Accessor, Setter } from "gnim";
import { DropdownButton } from "./ToggleButton";
import { cancelSleepTimer, formatRemaining, remaining, startSleepTimer } from "../../../lib/sleepTimer";

// Sleep timer toggle: main click cancels a running timer or opens the
// duration dropdown; the dropdown starts the timer for the picked
// duration (presets or a custom minute count).

const PRESETS = [15, 30, 45, 60]

interface dropdownProps {
    activeDropdown: Accessor<number>
    setActiveDropdown: Setter<number>
    dropdownIndex: number
}

export function SleepTimerButton({ activeDropdown, setActiveDropdown, dropdownIndex }: dropdownProps) {
    return <DropdownButton
        activeDropdown={activeDropdown}
        setActiveDropdown={setActiveDropdown}
        dropdownIndex={dropdownIndex}
        icon={"alarm-symbolic"}
        label={"Sleep Timer"}
        subtitle={remaining.as(s => s > 0 ? formatRemaining(s) : "Off")}
        isActive={remaining.as(s => s > 0)}
        activate={() => {
            // running: cancel. otherwise open the duration dropdown
            if (remaining.get() > 0) cancelSleepTimer()
            else if (activeDropdown.get() === dropdownIndex) setActiveDropdown(0)
            else setActiveDropdown(dropdownIndex)
        }}
    />
}

export function SleepTimerWidget({ activeDropdown: revealChild, dropdownIndex: index }: Omit<dropdownProps, "setActiveDropdown">) {
    let entry: Gtk.Entry | null = null

    const startCustom = () => {
        const minutes = Number(entry?.get_text())
        if (Number.isFinite(minutes) && minutes > 0) {
            startSleepTimer(minutes)
            entry?.set_text("")
        }
    }

    return <revealer revealChild={revealChild.as(s => s === index)}>
        <box cssClasses={["sleepTimer"]} orientation={Gtk.Orientation.VERTICAL} spacing={6} marginTop={4}>
            <box spacing={6} homogeneous>
                {PRESETS.map(minutes =>
                    <button onClicked={() => startSleepTimer(minutes)}>
                        <label label={`${minutes}m`} />
                    </button>
                )}
            </box>
            <box spacing={6}>
                <Gtk.Entry
                    $={(self) => { entry = self }}
                    placeholderText={"minutes"}
                    inputPurpose={Gtk.InputPurpose.DIGITS}
                    hexpand
                    onActivate={startCustom}
                />
                <button cssClasses={["confirm"]} onClicked={startCustom}>
                    <label label={"Start"} />
                </button>
            </box>
            <Gtk.Separator />
        </box>
    </revealer>
}
