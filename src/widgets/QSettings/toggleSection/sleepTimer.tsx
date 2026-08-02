import { Gtk } from "ags/gtk4"
import { Accessor, createComputed, Setter } from "gnim"
import Config from "../../../config"
import { DropdownButton } from "./ToggleButton"
import {
    cancelSleepTimer,
    formatRemaining,
    paused,
    remaining,
    startSleepTimer,
} from "../../../lib/sleepTimer"

// Sleep timer toggle: main click cancels a running timer or opens the
// duration dropdown; the dropdown starts the timer for the picked
// duration (presets or a custom minute count).

const PRESETS = Config.sleepTimer.presets

interface dropdownProps {
    activeDropdown: Accessor<number>
    setActiveDropdown: Setter<number>
    dropdownIndex: number
}

export function SleepTimerButton({
    activeDropdown,
    setActiveDropdown,
    dropdownIndex,
}: dropdownProps) {
    if (!Config.sleepTimer.enabled) return <></>
    return (
        <DropdownButton
            activeDropdown={activeDropdown}
            setActiveDropdown={setActiveDropdown}
            dropdownIndex={dropdownIndex}
            icon={"alarm-symbolic"}
            label={"Sleep Timer"}
            subtitle={createComputed([remaining, paused], (s, p) =>
                s > 0 ? `${formatRemaining(s)}${p ? " (paused)" : ""}` : "Off",
            )}
            isActive={remaining.as(s => s > 0)}
            activate={() => {
                // running: cancel. otherwise open the duration dropdown
                if (remaining.get() > 0) cancelSleepTimer()
                else if (activeDropdown.get() === dropdownIndex) setActiveDropdown(0)
                else setActiveDropdown(dropdownIndex)
            }}
        />
    )
}

export function SleepTimerWidget({
    activeDropdown: revealChild,
    dropdownIndex: index,
}: Omit<dropdownProps, "setActiveDropdown">) {
    if (!Config.sleepTimer.enabled) return <></>
    let entry: Gtk.Entry | null = null

    const startCustom = () => {
        const minutes = Number(entry?.get_text())
        if (Number.isFinite(minutes) && minutes > 0) {
            startSleepTimer(minutes)
            entry?.set_text("")
        }
    }

    return (
        <revealer revealChild={revealChild.as(s => s === index)}>
            <box
                cssClasses={["sleepTimer", "paneCard"]}
                orientation={Gtk.Orientation.VERTICAL}
                spacing={6}
                marginTop={4}
            >
                <box spacing={6} homogeneous>
                    {PRESETS.map(minutes => (
                        <button cssClasses={["paneRow"]} onClicked={() => startSleepTimer(minutes)}>
                            <label label={`${minutes}m`} />
                        </button>
                    ))}
                </box>
                <box spacing={6}>
                    <Gtk.Entry
                        $={self => {
                            entry = self
                        }}
                        cssClasses={["textInput"]}
                        placeholderText={"minutes"}
                        inputPurpose={Gtk.InputPurpose.DIGITS}
                        hexpand
                        onActivate={startCustom}
                    />
                    <button cssClasses={["confirm", "paneRow"]} onClicked={startCustom}>
                        <label label={"Start"} />
                    </button>
                </box>
            </box>
        </revealer>
    )
}
