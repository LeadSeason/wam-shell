# OSD

On-screen display: the pills that pop up when volume, microphone or
brightness change, or when a lock key or keyboard layout flips.

Section: `[osd]`

| Key                  | Type                              | Default    | What it does                                                                                                                                                                 |
| -------------------- | --------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | bool                              | `true`     | Show the OSD at all                                                                                                                                                          |
| `position`           | `"bottom"` / `"center"` / `"top"` | `"bottom"` | Which screen edge the OSD anchors to, or the middle of the screen                                                                                                            |
| `margin`             | int (px)                          | `140`      | Distance between the OSD and the edge it is anchored to; ignored when `position = "center"`                                                                                  |
| `timeout`            | int (ms)                          | `2000`     | How long the pills you drive (volume, microphone, brightness) stay up before hiding; announcements that only report a state get a fraction of it — layout 30%, lock keys 60% |
| `timeout_volume`     | int (ms)                          | derived    | Pin the volume pill's duration instead of deriving it from `timeout`                                                                                                         |
| `timeout_microphone` | int (ms)                          | derived    | Same, for the microphone pill                                                                                                                                                |
| `timeout_brightness` | int (ms)                          | derived    | Same, for the brightness pill                                                                                                                                                |
| `timeout_layout`     | int (ms)                          | derived    | Same, for layout-change announcements                                                                                                                                        |
| `timeout_lock_keys`  | int (ms)                          | derived    | Same, for lock-key announcements                                                                                                                                             |
| `volume`             | bool                              | `true`     | Show a pill when the volume changes                                                                                                                                          |
| `microphone`         | bool                              | `true`     | Show a pill when the microphone is muted/unmuted                                                                                                                             |
| `brightness`         | bool                              | `true`     | Show a pill when the brightness changes                                                                                                                                      |
| `layout`             | bool                              | `true`     | Show a pill when the keyboard layout changes                                                                                                                                 |
| `lock_keys`          | bool                              | `true`     | Show a pill when Caps Lock / Num Lock toggle                                                                                                                                 |
| `feedback`           | bool                              | `true`     | Play the sound theme's short "volume changed" click whenever the volume pill appears, so a keyboard-driven level change can be heard as well as seen                         |
| `feedback_volume`    | float (0–6)                       | `4.0`      | Loudness multiplier for that click; 4.0 is four times the amplitude (+12 dB). The theme click peaks around −17 dBFS, so even the 6.0 max stays clear of clipping             |

Muting shows the crossed icon and a "Muted" label with no level bar;
unmuting brings the bar back at the real level.

The feedback click plays through the default sink at the stream's own
volume, so it scales with the level being set — raising the volume
audibly ramps. `feedback_volume` multiplies the decoded audio itself
(4.0 = four times the amplitude); the theme click peaks around −17 dBFS,
so even the 6.0 maximum stays clear of clipping. It follows the
`volume` toggle
(`volume = false` silences it too) and stays silent while muted. It
needs `pw-play` or
`paplay` plus the freedesktop sound theme (preferred: they start
sounding ~70 ms after spawn, which a tick lives on), falling back to
`canberra-gtk-play` (theme-aware, but a GTK app that needs ~150 ms
before its first sample) or `ffplay`; without any of them it is simply
silent.
