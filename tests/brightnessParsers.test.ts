import { test, eq } from "./framework"
import { parseDdcDetect, parseDdcGetvcp, parseOpenRgbList } from "../src/lib/brightnessParsers"

// real `ddcutil detect --brief` (Acer X34P on HDMI + laptop panel)
const DDC_DETECT = `
Display 1
   I2C bus:          /dev/i2c-4
   DRM connector:    card1-HDMI-A-1
   drm_connector_id: 0
   Monitor:          ACR:Acer X34 P:T3MEE0224202

Invalid display
   I2C bus:          /dev/i2c-5
   DRM connector:    card1-eDP-1
   drm_connector_id: 0
   Monitor:          SDC:ATNA60DL04-0:
`

test("parseDdcDetect: valid displays parsed, invalid skipped", () => {
    eq(parseDdcDetect(DDC_DETECT), [{ bus: 4, label: "Acer X34 P" }])
})

test("parseDdcDetect: empty on no displays", () => {
    eq(parseDdcDetect("Invalid display\n   I2C bus: /dev/i2c-0\n"), [])
})

test("parseDdcGetvcp: continuous reply", () => {
    eq(parseDdcGetvcp("VCP 10 C 100 100"), { cur: 100, max: 100 })
    eq(parseDdcGetvcp("VCP 10 C 0 100"), { cur: 0, max: 100 })
})

test("parseDdcGetvcp: unusable replies are null", () => {
    eq(parseDdcGetvcp("DDC communication failed"), null)
    eq(parseDdcGetvcp("VCP 10 C 50 0"), null) // max 0 would divide by zero
    eq(parseDdcGetvcp(""), null)
})

// real `openrgb --list-devices --noautoconnect` (1.0rc3, ASUS laptop;
// the giant per-key LEDs line is shortened — the parser ignores it)
const OPENRGB_LIST = `[GA605WI] device capabilities not found. Please creata a new device request.
<h2>Warning:</h2><p>One or more I2C/SMBus interfaces failed to initialize.</p>
0: G533ZM
  Type:           Laptop
  Description:    ITE Tech. Inc. ITE Device(8910)
  Location:       HID: /dev/hidraw2
  Modes: [Direct] Static Breathing 'Spectrum Cycle' Off
  Zones: Keyboard
  LEDs: 'Key: Escape' 'Key: F1'
1: ASUS TUF Laptop Keyboard
  Type:           Laptop
  Description:    Asus TUF Device
  Location:       /sys/devices/platform/asus-nb-wmi/leds/asus::kbd_backlight
  Modes: [Direct] Static Breathing 'Spectrum Cycle' Flashing
  Zones: 'Keyboard Backlight zone'
  LEDs: 'Keyboard Backlight LED'
`

test("parseOpenRgbList: device blocks with type/location", () => {
    eq(parseOpenRgbList(OPENRGB_LIST), [
        { index: 0, name: "G533ZM", type: "Laptop", location: "HID: /dev/hidraw2" },
        {
            index: 1,
            name: "ASUS TUF Laptop Keyboard",
            type: "Laptop",
            location: "/sys/devices/platform/asus-nb-wmi/leds/asus::kbd_backlight",
        },
    ])
})

test("parseOpenRgbList: noise only yields nothing", () => {
    eq(parseOpenRgbList("<h2>Warning:</h2>\nno devices here\n"), [])
})
