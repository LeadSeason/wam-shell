import Config from "../../../config"

export default function OSIcon() {
    // show_os_icon = false removes the widget outright — null, not an
    // empty button shell — so both the [[panel]] lists and the legacy
    // layout lose it without a hole in the row
    if (!Config.showOsIcon) return null

    const icon = Config.osIcon
    let iconImage

    if (icon.includes("/")) iconImage = <image file={icon} pixelSize={24} />
    else iconImage = <image iconName={icon} pixelSize={24} />

    return <button cssClasses={["osIcon"]}>{iconImage}</button>
}
