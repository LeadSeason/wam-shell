import Gtk from "gi://Gtk?version=4.0";
import { Accessor, createState, Setter } from "gnim";

function TbButton({data: data}: {data: [Accessor<number>, Setter<number>, number]}) {
    const state = data[0]
    // const setState = data[1]
    const index = data[2]
    const setState = (i: number) => {
        if (state.get() === i)
            data[1](0)
        else
            data[1](i)
    }
    return <box cssName={"button"} hexpand cssClasses={["toggleButton", "TBactive"]}>
        <Gtk.GestureClick
            button={1}
            onPressed={() => {
                setState(index);
            }} />
        <image iconName={"applications-system-symbolic"} />
        <label label={"MEAW" + index.toString()} />
        <image halign={Gtk.Align.END} hexpand iconName={state.as(s => (s === index) ? "arrow-up-symbolic" : "arrow-down-symbolic")} />
    </box>
}

export function ToggleSection() {
    const [active, setActive] = createState(0);

    return <box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
        <box>
            <TbButton data={[active, setActive, 1]} />        
            <TbButton data={[active, setActive, 2]} />        
        </box>
        <revealer
            revealChild={active.as(s => (s === 1))}
        >
            <label label={"label 1"} />
        </revealer>
        <revealer
            revealChild={active.as(s => (s === 2))}
        >
            <label label={"label 2"} />
        </revealer>
        <box>
            <TbButton data={[active, setActive, 3]} />        
            <TbButton data={[active, setActive, 4]} />        
        </box>
        <revealer
            revealChild={active.as(s => (s === 3))}
        >
            <label label={"label 3"} />
        </revealer>
        <revealer
            revealChild={active.as(s => (s === 4))}
        >
            <label label={"label 4"} />
        </revealer>
    </box>;
}
