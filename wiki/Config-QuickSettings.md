# Quick Settings

The quick settings popup (audio, network, power, bluetooth panes) and
the bits of it that also show on the panel.

Section: `[quicksettings]`

| Key | Type | Default | What it does |
|---|---|---|---|
| `width` | int (px) | `440` | Popup content width |
| `show_battery_percentage` | bool | `true` | Percentage next to the battery icon on the panel |
| `battery_blink` | bool | `true` | Blink the panel battery icon while the battery is discharging |
| `show_device_names` | bool | `false` | Overlay the active input/output device name on the volume sliders |
| `show_stats` | bool | `false` | Performance stats tiles (cpu/ram+swap/gpu/network/disk/uptime) in the power mode pane; collected only while the pane is open |
| `stats_on_panel` | bool | `false` | Resource utilization monitor (cpu/ram/gpu percentages) on the panel |
| `stats_interval` | int (ms) | `1000` | Time between stat updates; lower is smoother graphs at higher cpu cost |
| `power_profile_on_panel` | bool | `true` | Active power profile icon in the bar's quicksettings label |
| `hide_on_media_play` | bool | `true` | Close the popup when a player starts playing; pausing leaves it open |
| `audio_meter` | bool | `true` | Playback level bar under the default output device in the audio pane; runs a capture pipeline only while that pane is open |
| `mic_meter` | bool | `true` | Same level bar under the default input device; opens the microphone while the Input pane is on screen (and only then) — set `false` to keep the output meter without the shell ever listening |
| `min_height` | int (px) | `0` | The popup never shrinks below this when switching to a short pane (vpn, wired); `0` holds a short pane at the main pane's height; set a number only to hold short panes taller; never pads the main pane itself |
| `show_avatar` | bool | `true` | Avatar in the popup header |
| `avatar` | string (path) | `""` | Absolute path to the avatar image, square crop ~96x96 recommended (`scripts/prepare-avatar.sh` resizes); empty uses the login avatar from AccountsService, falling back to the OS icon |
| `battery_full_at` | int (percent) | auto | Charge cap the header ring treats as full; auto-detected from sysfs (`charge_control_end_threshold`) when exposed, else 100; set explicitly to override. At the cap the battery UI shows "on AC"/"charge limit" only while the adapter holds it there — a battery discharging at the cap shows the drain and time left |

The power mode pane also shows a memory-pressure warning (yellow, red
when severe) whenever the kernel's PSI reports tasks stalled on memory
for a sustained share of the last minute — the state behind "everything
feels sluggish". The warning names the three biggest memory residents
at that moment, so the culprit is visible at a glance. Not
config-gated; it only exists while there is pressure to report, and
needs a kernel with PSI on (the default).

A second warning covers GPU memory: VRAM fill from the amdgpu sysfs
(`mem_info_vram_*`) or the nvidia-smi stream, plus amdgpu GTT fill —
there is no PSI for GPU memory, so these are plain used/total
percentages with thresholds fixed at 85% (yellow) / 95% (red). It
appears only on machines with one of those GPUs and only under
pressure, and names the three biggest VRAM consumers at that moment.
The same amdgpu fill levels also get a stats tile in the pane's System
section (`show_stats`): VRAM used/total, with GTT used/total in the
subtitle.

Section: `[bluetooth]` — the bluetooth pane.

| Key | Type | Default | What it does |
|---|---|---|---|
| `notifications` | bool | `true` | Notification when a device connects/disconnects or reports low battery (<= 20%) |
