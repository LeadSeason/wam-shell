import Config from "../../../config"

export default function OSIcon() {
  const icon = Config.osIcon
  let iconImage

  if (icon.includes("/"))
    iconImage = <image file={icon} pixelSize={24} />
  else
    iconImage = <image iconName={icon} pixelSize={24} />

  return <button>
    {iconImage}
  </button>
}