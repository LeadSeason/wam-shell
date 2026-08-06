import { Gtk } from "ags/gtk4"
import { timeout } from "ags/time"
import { Accessor, createComputed, onCleanup, Setter } from "gnim"
import Config from "../../../config"
import { connect, disconnect } from "../../../lib/metrics"
import { DropdownButton } from "./ToggleButton"
import {
    alarmEnabled,
    alarming,
    cancelSleepTimer,
    formatRemaining,
    notificationText,
    paused,
    remaining,
    restoreOnPlay,
    setAlarmEnabled,
    setNotificationText,
    setRestoreOnPlay,
    startSleepTimer,
    stopAlarm,
} from "../../../lib/sleepTimer"

// Sleep timer toggle: main click stops the ringing alarm, cancels a
// running timer or opens the duration dropdown; the dropdown starts
// the timer for the picked duration (presets or a custom minute
// count) and carries the alarm on/off checkbox.

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
            subtitle={createComputed([remaining, paused, alarming], (s, p, a) =>
                // short: long subtitles push the toggle grid to 1 column
                a
                    ? "Stop the alarm"
                    : s > 0
                      ? `${formatRemaining(s)}${p ? " (paused)" : ""}`
                      : "Off",
            )}
            isActive={createComputed([remaining, alarming], (s, a) => s > 0 || a)}
            activate={() => {
                // ringing: stop. running: cancel. otherwise the dropdown
                if (alarming.get()) stopAlarm()
                else if (remaining.get() > 0) cancelSleepTimer()
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
                    <button
                        cssClasses={["confirm", "paneRow", "trailingBtn"]}
                        onClicked={startCustom}
                    >
                        <label label={"Start"} />
                    </button>
                </box>
                <box spacing={8}>
                    <image iconName={"alarm-symbolic"} />
                    <label label={"Alarm"} xalign={0} hexpand />
                    {/* a paneRow button like Start and the preset chips:
                    the right edges align by construction (a Gtk.Switch
                    has its own geometry, and is invisible unstyled) */}
                    <button
                        cssClasses={["paneRow", "trailingBtn"]}
                        tooltipText={
                            Config.sleepTimer.alarmOnly
                                ? "Ring at 0 as a reminder: playback, volume and brightness are left alone"
                                : "Play the alarm when the timer reaches 0"
                        }
                        onClicked={() => setAlarmEnabled(!alarmEnabled.get())}
                    >
                        <image
                            iconName={alarmEnabled.as(v =>
                                v ? "checkbox-checked-symbolic" : "checkbox-symbolic",
                            )}
                        />
                    </button>
                </box>
                <box spacing={8}>
                    <image iconName={"display-brightness-symbolic"} />
                    <label label={"Undim on play"} xalign={0} hexpand />
                    <button
                        cssClasses={["paneRow", "trailingBtn"]}
                        tooltipText={
                            "Restore the brightness when media starts playing after the timer fired"
                        }
                        onClicked={() => setRestoreOnPlay(!restoreOnPlay.get())}
                    >
                        <image
                            iconName={restoreOnPlay.as(v =>
                                v ? "checkbox-checked-symbolic" : "checkbox-symbolic",
                            )}
                        />
                    </button>
                </box>
                {/* the note belongs to the alarm: no field without one.
                Saved as it is typed (debounced), not on Enter — a
                message typed and left unconfirmed must still be there
                at 0 */}
                <Gtk.Entry
                    visible={alarmEnabled}
                    $={self => {
                        self.set_text(notificationText.get())
                        let save: ReturnType<typeof timeout> | null = null
                        const handler = connect(self, "changed", () => {
                            save?.cancel()
                            save = timeout(600, () => {
                                save = null
                                setNotificationText(self.get_text())
                            })
                        })
                        onCleanup(() => {
                            save?.cancel()
                            disconnect(self, handler)
                        })
                    }}
                    cssClasses={["textInput"]}
                    placeholderText={"Reminder message"}
                    tooltipText={
                        "Shown as a notification when the time is up, until you dismiss it"
                    }
                    hexpand
                />
            </box>
        </revealer>
    )
}
