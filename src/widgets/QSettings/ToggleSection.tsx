import Gtk from "gi://Gtk?version=4.0";
import { Accessor, createState, Setter } from "gnim";

interface TbButtonProps {
    active: Accessor<number>
    setActive: Setter<number>
    index: number
    
    icon: string | Accessor<string>
    label: string | Accessor<string>
}

function DropdownButton({active, setActive, index, icon, label }: TbButtonProps) {
    // const setState = data[1]
    const setState = (i: number) => {
        if (active.get() === i)
            setActive(0)
        else
            setActive(i)
    }
    return <box cssName={"button"} hexpand cssClasses={["toggleButton", "ToggleSectionActive"]}>
        <Gtk.GestureClick
            button={1}
            onPressed={() => {
                setState(index);
            }} />
        <box spacing={5}>
            <image iconName={"applications-system-symbolic"} />
            <label label={"MEAW" + index.toString()} />
        </box>
        <image halign={Gtk.Align.END} hexpand iconName={active.as(s => (s === index) ? "arrow-up-symbolic" : "arrow-down-symbolic")} />
    </box>
}

export function ToggleSection() {
    const [activeDropdown, setActiveDropdown] = createState(0);

    return <box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
        <box>
            <DropdownButton 
                active={activeDropdown}
                setActive={setActiveDropdown}
                index={1}
                icon={"applications-system-symbolic"}
                label={"Test 1"}
            />        
            <DropdownButton 
                active={activeDropdown}
                setActive={setActiveDropdown}
                index={2}
                icon={"applications-system-symbolic"}
                label={"Test"}
            />        
        </box>
        <revealer
            revealChild={activeDropdown.as(s => (s === 1))}
        >
            <label label={"label 1"} />
        </revealer>
        <revealer
            revealChild={activeDropdown.as(s => (s === 2))}
        >
            <label label={"label 2"} />
        </revealer>
        <box>
            <DropdownButton 
                active={activeDropdown}
                setActive={setActiveDropdown}
                index={3}
                icon={"applications-system-symbolic"}
                label={"Test 3"}
            />        
            <DropdownButton 
                active={activeDropdown}
                setActive={setActiveDropdown}
                index={4}
                icon={"applications-system-symbolic"}
                label={"Test 4"}
            />        
        </box>
        <revealer
            revealChild={activeDropdown.as(s => (s === 3))}
        >
            <label label={"label 3"} />
        </revealer>
        <revealer
            revealChild={activeDropdown.as(s => (s === 4))}
        >
            <label label={"label 4"} />
        </revealer>
    </box>;
}
