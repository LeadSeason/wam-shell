import { Gtk } from "ags/gtk4"
import { Accessor, For, With, createComputed, onCleanup } from "gnim"
import {
    BrightnessDevice,
    devices,
    externalChange,
    refreshExternal,
} from "../../../lib/brightnessDevices"
import { DropdownButton } from "./ToggleButton"
import { PaneEmpty } from "../../PaneEmpty"

// Peripheral brightness (keyboard backlights & co.): a pill in the
// toggle section plus its own pane. Hidden entirely when no writable
// device was discovered.

const levelText = (d: BrightnessDevice) =>
    d.stageLabel ? d.stageLabel() : `${Math.round(d.level() * 100)}%`

export function PeripheralBrightnessButton({ navigate }: { navigate: () => void }) {
    return (
        <With value={devices.as(l => l.length > 0)}>
            {any =>
                any && (
                    <DropdownButton
                        // body click navigates too: there is no global
                        // on/off to toggle
                        activate={navigate}
                        navigate={navigate}
                        icon={"input-keyboard-symbolic"}
                        // short and static on purpose: a long dynamic
                        // label ("Keyboard backlight") pushed the
                        // FlowBox to one column
                        label={"Peripherals"}
                        // count-aware so "Off" can't be misread as
                        // "some devices off": "1 device · Off",
                        // "2 devices · 1 on"
                        subtitle={createComputed([devices, externalChange], l => {
                            if (l.length === 1) return `1 device · ${levelText(l[0])}`
                            const on = l.filter(d => d.level() > 0).length
                            return `${l.length} devices · ${on} on`
                        })}
                        isActive={createComputed([devices, externalChange], l =>
                            l.some(d => d.level() > 0),
                        )}
                    />
                )
            }
        </With>
    )
}

function DeviceRow({ d }: { d: BrightnessDevice }) {
    const stages = d.stages
    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            <box spacing={10}>
                <image
                    iconName={d.icon ?? "input-keyboard-symbolic"}
                    pixelSize={16}
                    valign={Gtk.Align.CENTER}
                />
                <label cssClasses={["paneRowName"]} label={d.label} xalign={0} hexpand />
                <label cssClasses={["paneRowDesc"]} label={externalChange.as(() => levelText(d))} />
            </box>
            {/* staged devices (asusctl Off/Low/Med/High) get buttons
            only — a slider implies finer steps than exist */}
            {stages ? (
                <box spacing={6} homogeneous cssClasses={["stageButtons"]}>
                    {stages.map((s, i) => (
                        <button
                            cssClasses={externalChange.as(() => [
                                "paneRow",
                                "stageBtn",
                                ...(Math.round(d.level() * (stages.length - 1)) === i
                                    ? ["active"]
                                    : []),
                            ])}
                            onClicked={() => d.set(i / (stages.length - 1))}
                        >
                            <label label={s} />
                        </button>
                    ))}
                </box>
            ) : (
                <slider
                    hexpand
                    min={0}
                    max={1}
                    value={externalChange.as(() => d.level())}
                    onChangeValue={({ value }) => d.set(value)}
                />
            )}
        </box>
    )
}

export function PeripheralBrightnessWidget({
    pane,
    name,
}: {
    pane: Accessor<string>
    name: string
}) {
    // ddc has nothing to watch: re-read monitor levels on every open
    const unsub = pane.subscribe(() => {
        if (pane.get() === name) refreshExternal()
    })
    onCleanup(unsub)

    return (
        <With value={devices.as(l => l.length === 0)}>
            {empty =>
                empty ? (
                    <PaneEmpty
                        icon={"input-keyboard-symbolic"}
                        title={"No brightness devices"}
                        hint={
                            "Keyboard backlights, asusctl, ddcutil and OpenRGB devices show up here"
                        }
                    />
                ) : (
                    <box
                        orientation={Gtk.Orientation.VERTICAL}
                        cssClasses={["paneCard", "peripheralBrightness"]}
                        spacing={8}
                    >
                        <For each={devices}>{d => <DeviceRow d={d} />}</For>
                    </box>
                )
            }
        </With>
    )
}
