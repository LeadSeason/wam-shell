import app from "ags/gtk4/app"
import style from "./style.scss"
import Bar from "./widget/Bar"
import Tray from "./widget/Tray"

app.start({
  css: style,
  instanceName: "wam-shell",
  main() {
    const primaryMon = app.get_monitors()[0]
    Bar(primaryMon)
    Tray()
  },
})
