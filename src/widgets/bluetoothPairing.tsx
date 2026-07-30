import { Astal, Gtk, Gdk } from "ags/gtk4"
import { With } from "gnim"
import { pairingRequest, btPaneOpen, PairingRequest } from "../lib/bluetoothAgent"

export function PromptContent({ req }: { req: PairingRequest }) {
    let entry: Gtk.Entry | null = null

    // empty pin/passkey answers fail the pairing anyway (passkey even
    // becomes "0") — don't send them
    const confirm = (text?: string) => {
        if ((req.kind === "pin" || req.kind === "passkey") && !text) return
        req.respond(true, text)
    }

    const title =
        req.kind === "authorize"
            ? `Allow ${req.deviceName} to connect?`
            : req.kind === "display"
              ? `Enter this code on ${req.deviceName}`
              : `Pair with ${req.deviceName}?`

    return (
        <box cssClasses={["pairing"]} orientation={Gtk.Orientation.VERTICAL} spacing={12}>
            <box spacing={8}>
                <image iconName={req.icon} pixelSize={32} />
                <label cssClasses={["title"]} label={title} xalign={0} hexpand wrap />
            </box>
            {(req.kind === "confirm" || req.kind === "display") && (
                <label
                    cssClasses={["passkey"]}
                    label={req.code ? `${req.code.slice(0, 3)} ${req.code.slice(3)}` : ""}
                />
            )}
            {req.kind === "confirm" && (
                <label
                    cssClasses={["hint"]}
                    label={"Does this code match the one on the device?"}
                    xalign={0.5}
                />
            )}
            {(req.kind === "pin" || req.kind === "passkey") && (
                <Gtk.Entry
                    $={self => {
                        entry = self
                        self.grab_focus()
                    }}
                    cssClasses={["pinEntry"]}
                    placeholderText={req.kind === "pin" ? "PIN" : "123456"}
                    maxLength={req.kind === "pin" ? 16 : 6}
                    inputPurpose={Gtk.InputPurpose.DIGITS}
                    xalign={0.5}
                    onActivate={(self: Gtk.Entry) => confirm(self.get_text())}
                />
            )}
            <box cssClasses={["buttons"]} spacing={8} halign={Gtk.Align.END}>
                {req.kind === "display" ? (
                    <button cssName={"button"} onClicked={() => req.respond(true)}>
                        <label label={"Close"} />
                    </button>
                ) : (
                    <>
                        <button cssName={"button"} onClicked={() => req.respond(false)}>
                            <label label={"Cancel"} />
                        </button>
                        <button
                            cssName={"button"}
                            cssClasses={["confirm"]}
                            onClicked={() => confirm(entry?.get_text())}
                        >
                            <label label={req.kind === "authorize" ? "Allow" : "Confirm"} />
                        </button>
                    </>
                )}
            </box>
        </box>
    )
}

export default function BluetoothPairing() {
    let win: Astal.Window

    // fallback for prompts that arrive while the QS bluetooth pane is
    // not on screen (e.g. pairing initiated from the phone); when the
    // pane is open the prompt renders inline instead. Watch both states:
    // the QS closing mid-prompt must surface the floating dialog
    const updateVisibility = () => {
        if (pairingRequest.get() !== null && !btPaneOpen.get()) win.present()
        else win.hide()
    }
    pairingRequest.subscribe(updateVisibility)
    btPaneOpen.subscribe(updateVisibility)

    function onKey(_e: Gtk.EventControllerKey, keyValue: number) {
        if (keyValue === Gdk.KEY_Escape) pairingRequest.get()?.respond(false)
    }

    return (
        <window
            $={self => {
                win = self
            }}
            name="BluetoothPairing"
            class="BluetoothPairing"
            namespace="bluetooth-pairing"
            // OVERLAY: above the quick-settings overlay, or the dialog is
            // hidden behind it (and unclickable) when pairing from the pane
            layer={Astal.Layer.OVERLAY}
            // no anchors: centered
            keymode={Astal.Keymode.EXCLUSIVE}
            visible={false}
        >
            <Gtk.EventControllerKey onKeyPressed={onKey} />
            <With value={pairingRequest}>{req => req && <PromptContent req={req} />}</With>
        </window>
    )
}
