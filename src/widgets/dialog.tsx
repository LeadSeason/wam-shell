import { Astal, Gdk, Gtk } from "ags/gtk4"
import { timeout } from "ags/time"
import Graphene from "gi://Graphene?version=1.0"
import Config from "../config"
import app from "ags/gtk4/app"
import CommandRegistry from "../lib/requestHandler"
import { Accessor, createBinding, createState, With } from "gnim"
import { Setter } from "gnim"
import GObject, { register } from "gnim/gobject"

const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

/** IDEA section @TODO
 * Make this fairly generic dialog. we Could also use this for example for sway-scratchpad
 * Program make a new dialog box then adds its own content in it.
 * And we could make pre made formats, like:
 * - Are you sure?
 *    - For example your trying to reboot / shutdown. Prompts you before doing action
 * - Authentication required
 *    - For example connection to wifi could ask you if password required.
 */


class Dialog {
    static instance: Dialog

    static get_default() {
        if (!this.instance)
            this.instance = new Dialog()

        return this.instance
    }

    hide = () => {
        this.revealer.reveal_child = false
        // give some time for the animation to play.
        timeout(50, () => {
            this.win.hide()
        })
    }

    Show = (): boolean => {
        if (!this.win.is_visible()) {
            this.win.present()
            return true
        } else {
            this.hide()
        }
        return false
    }

    private onKey = (_e: Gtk.EventControllerKey, keyValue: number, _: number, mod: number) => {
        if (keyValue === Gdk.KEY_Escape)
            this.hide()
    }

    private onClick = (_e: Gtk.GestureClick, _: number, x: number, y: number) => {
        const [, rect] = this.contentBox.compute_bounds(this.win)
        const position = new Graphene.Point({ x, y })

        if (!rect.contains_point(position))
            this.hide()
    }

    win: Astal.Window
    private contentBox: Gtk.Box
    private revealer: Gtk.Revealer
    private content: Accessor<GObject.Object>
    setContent: Setter<GObject.Object>

    constructor() {
        [this.content, this.setContent] = createState(
            <box
                orientation={Gtk.Orientation.VERTICAL}
                valign={Gtk.Align.CENTER}
                halign={Gtk.Align.CENTER}
                hexpand
            >
                <label label={"No content set"} />
                <label label={"Merp"} />
                <box
                    hexpand={false}
                    vexpand={false}
                    cssName={"button"}
                >
                    <Gtk.GestureClick
                        button={1}
                        onPressed={() => { this.hide() }}
                    />
                    <label hexpand label={"Close"}></label>
                </box>
            </box>)

        this.contentBox = (<box
            name="main-content"
            valign={Gtk.Align.CENTER}
            halign={Gtk.Align.CENTER}
        >
            <With value={this.content}>
                {(value) => { return value }}
            </With>
        </box>) as Gtk.Box

        this.revealer = (<revealer>
            {this.contentBox}
        </revealer>) as Gtk.Revealer

        this.win = (<window
            name="Dialog"
            class="Dialog"
            namespace={`${Config.instanceName}Dialog`}
            anchor={TOP | BOTTOM | LEFT | RIGHT}
            exclusivity={Astal.Exclusivity.IGNORE}
            keymode={Astal.Keymode.EXCLUSIVE}
            onNotifyVisible={(visible) => {
                if (visible)
                    this.revealer.reveal_child = true
            }}
        >
            <Gtk.EventControllerKey onKeyPressed={this.onKey} />
            <Gtk.GestureClick onPressed={this.onClick} />
            {this.revealer}
        </window>) as Astal.Window
    }
}


export default Dialog

interface confirmDialogProps {
    text?: string
    subtext?: string
    yesButton?: string
    noButton?: string
}

export async function confirmDialog({
    text = "Are you user?",
    subtext = "Your about to do some action",
    yesButton = "Confirm",
    noButton = "Cancel",
}: confirmDialogProps): Promise<boolean> {
    const dialog = Dialog.get_default();
    // @TODO Clean up style for this function

    return new Promise((resolve) => {
        dialog.setContent(<box
            cssClasses={["confirm"]}
            orientation={Gtk.Orientation.VERTICAL}
            valign={Gtk.Align.CENTER}
            halign={Gtk.Align.CENTER}
            hexpand
        >
            <label cssClasses={["title"]} label={text} />
            <label cssClasses={["subtext"]} label={subtext} />
            <box homogeneous>
                <box cssName={"button"}>
                    <Gtk.GestureClick
                        button={1}
                        onPressed={() => {
                            dialog.hide();
                            resolve(true);
                        }} />
                    <label hexpand label={yesButton}></label>
                </box>
                <box cssName={"button"}>
                    <Gtk.GestureClick
                        button={1}
                        onPressed={() => {
                            dialog.hide();
                            resolve(false);
                        }} />
                    <label hexpand label={noButton}></label>
                </box>
            </box>
        </box>);
        dialog.Show();
        createBinding(dialog.win, "visible").subscribe(() => {
            if (!dialog.win.get_visible()) {
                resolve(false);
            }
        });
    });
}