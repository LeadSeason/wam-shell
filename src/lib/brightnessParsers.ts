// Pure parsers for the peripheral-brightness backends' CLI outputs.
// Kept side-effect-free so the unit tests can import them — the lib
// itself starts discovery and file watches at import time.

export interface DdcDisplay {
    bus: number
    label: string
}

// `ddcutil detect --brief` blocks look like:
//
//   Display 1
//      I2C bus:          /dev/i2c-4
//      DRM connector:    card1-HDMI-A-1
//      drm_connector_id: 0
//      Monitor:          ACR:Acer X34 P:T3MEE0224202
//
// "Invalid display" blocks (e.g. laptop panels) are skipped. The
// monitor label is the model field of the mfg:model:serial triple.
export function parseDdcDetect(text: string): DdcDisplay[] {
    const out: DdcDisplay[] = []
    let valid = false
    let bus: number | null = null
    let model: string | null = null

    const flush = () => {
        if (valid && bus !== null && model !== null) out.push({ bus, label: model })
        valid = false
        bus = null
        model = null
    }

    for (const line of text.split("\n")) {
        const head = line.match(/^(Display\s+\d+|Invalid display)\b/)
        if (head) {
            flush()
            valid = head[1].startsWith("Display")
            continue
        }
        const b = line.match(/I2C bus:\s+\/dev\/i2c-(\d+)/)
        if (b) bus = Number(b[1])
        const m = line.match(/Monitor:\s+[^\s:]+:(.*):[^\s:]+\s*$/)
        if (m) model = m[1].trim()
    }
    flush()
    return out
}

// `ddcutil getvcp 10 --bus N --brief` → "VCP 10 C 100 100"
// (feature, type, current, max). null when the reply is unusable.
export function parseDdcGetvcp(text: string): { cur: number; max: number } | null {
    const m = text.match(/VCP\s+10\s+\S+\s+(\d+)\s+(\d+)/)
    if (!m) return null
    const max = Number(m[2])
    return max > 0 ? { cur: Number(m[1]), max } : null
}

export interface OpenRgbDeviceInfo {
    index: number
    name: string
    type: string
    location: string
}

// `openrgb --list-devices --noautoconnect` prints one block per device:
//
//   0: G533ZM
//     Type:           Laptop
//     Description:    ITE Tech. Inc. ITE Device(8910)
//     Location:       HID: /dev/hidraw2
//     Modes: [Direct] Static ...
//     Zones: Keyboard
//     LEDs: 'Key: Escape' ...
//
// Warning/log noise around the blocks (I2C warnings, "device
// capabilities not found", HTML) is ignored.
export function parseOpenRgbList(text: string): OpenRgbDeviceInfo[] {
    const out: OpenRgbDeviceInfo[] = []
    let cur: OpenRgbDeviceInfo | null = null

    for (const line of text.split("\n")) {
        const head = line.match(/^(\d+):\s+(.+?)\s*$/)
        if (head) {
            cur = { index: Number(head[1]), name: head[2], type: "", location: "" }
            out.push(cur)
            continue
        }
        if (!cur) continue
        const field = line.match(/^\s+(Type|Location):\s+(.+?)\s*$/)
        if (field?.[1] === "Type") cur.type = field[2]
        else if (field?.[1] === "Location") cur.location = field[2]
    }
    return out
}
