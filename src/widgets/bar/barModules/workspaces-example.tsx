
export default function WorkspacesExample() {
  return <box cssName={"workspaces"} cssClasses={["bold"]}>
    <button cssName={"workspace"}>
      <box>
        <label label="1" />
        <image iconName={"spotify-client"} />
        <image iconName={"discord"} />
      </box>
    </button>
    <button cssName={"workspace"} cssClasses={["active"]}>
      <box>
        <label label="3" />
        <image iconName={"firefox"} />
        <image iconName={"nemo"} cssClasses={["urgent"]} />
      </box>
    </button >
  </box>
}

