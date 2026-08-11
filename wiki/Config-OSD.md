# OSD

On-screen display: the pills that pop up when volume, microphone or
brightness change, or when a lock key or keyboard layout flips.

Section: `[osd]`

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | bool | `true` | Show the OSD at all |
| `position` | `"bottom"` / `"center"` / `"top"` | `"bottom"` | Which screen edge the OSD anchors to, or the middle of the screen |
| `margin` | int (px) | `140` | Distance between the OSD and the edge it is anchored to; ignored when `position = "center"` |
| `timeout` | int (ms) | `2000` | How long the pills you drive (volume, microphone, brightness) stay up before hiding; announcements that only report a state get a fraction of it — layout 30%, lock keys 60% |
| `timeout_volume` | int (ms) | derived | Pin the volume pill's duration instead of deriving it from `timeout` |
| `timeout_microphone` | int (ms) | derived | Same, for the microphone pill |
| `timeout_brightness` | int (ms) | derived | Same, for the brightness pill |
| `timeout_layout` | int (ms) | derived | Same, for layout-change announcements |
| `timeout_lock_keys` | int (ms) | derived | Same, for lock-key announcements |
| `volume` | bool | `true` | Show a pill when the volume changes |
| `microphone` | bool | `true` | Show a pill when the microphone is muted/unmuted |
| `brightness` | bool | `true` | Show a pill when the brightness changes |
| `layout` | bool | `true` | Show a pill when the keyboard layout changes |
| `lock_keys` | bool | `true` | Show a pill when Caps Lock / Num Lock toggle |
