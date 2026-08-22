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
| `show_stats` | bool | `false` | Performance stats tiles in the power mode pane: ram+swap/disk/uptime under System, cpu utilization + load average in the CPU section, a GPU section, and network rates; collected only while the pane is open. Does not gate the chassis-fan tile (see below) |
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

Every card's VRAM, plus amdgpu's GTT, is a separate pool, and the
warning reports the pool that is actually over the line — naming the
card (`GeForce RTX 4070 Laptop VRAM 7404/8188 MiB`) whenever there is
more than one to confuse it with. The GTT figure is listed only when
GTT itself is over threshold, not alongside every VRAM warning.

When **more than one card** is over, the warning becomes a carousel:
one page per saturated card, worst first, with the same left-edge
segment strip and the same gestures as the GPU tiles (scroll, up/down
arrows while hovered, click a segment). The heading carries the count
(`Severe GPU memory pressure · 2 cards`) — the detail line has no width
to spare for a second card's figures, and without the count the trouble
would look confined to whichever card happened to be on screen. Each
page carries its own severity, so a critical card and a merely-high one
are coloured separately as you page between them.

The consumer list is per page, so each card names its own processes —
a different card's process list is worse than none, and both scans run
once per tick for all saturated cards rather than once per card.

amdgpu clients come from `/proc/<pid>/fdinfo`, filtered to that card's
PCI slot so two AMD cards are not summed together, and counted as
`drm-resident-vram` minus
`drm-shared-vram` — the memory a client holds *on its own*. A buffer
mapped by two clients is reported in full by both, so the plain total
blames each of them for the other's memory; on a normal desktop that
had small clients showing ~90 MB of a compositor's scanout buffers they
did not own and could not release. Subtracting the shared portion does
not end the overcount (per-client views cannot be summed into device
usage — measured, 3.1x over actual becomes 2.4x), so read the line as a
ranking, not as totals. Drivers that publish no resident/shared
breakdown fall back to the older `drm-memory-vram` total.

The proprietary nvidia driver publishes nothing in
fdinfo at all, so nvidia consumers come from
`nvidia-smi --query-compute-apps` instead. That query covers compute
contexts only — nvidia-smi has no graphics-app equivalent — so a
process holding nvidia VRAM purely through a graphics context (a game,
the compositor) will not be named.
The same amdgpu fill levels also get a stats tile in the pane's GPU
section (`show_stats`): VRAM used/total, with GTT used/total in the
subtitle.

The pane's sections run Battery, System, CPU, GPU, Network. CPU and
GPU are adjacent and share a shape — utilization, then thermals and
clock, then power — so the two read as a pair.

System also carries a **chassis fan** tile (RPM) on laptops whose
vendor exposes one through hwmon — ThinkPad, ASUS, Dell, Apple, HP and
Lenovo modules are recognised; GPU fans are deliberately skipped. It is
a chassis fan rather than a CPU one, which is why it sits under System
and not CPU, and it is **not** gated by `show_stats`: it rides the same
poll as the rest of the power details, which runs whenever the pane is
open. The CPU section's temperature tile is the k10temp/coretemp
package sensor, falling back to `thermal_zone0`.

The GPU section (`show_stats`) shows **one card at a time**. Every GPU
the shell can read gets an entry — each amdgpu DRM card, each nvidia
index — and the eyebrow names the one on screen (`GPU · GeForce RTX
4070 Laptop`). AMD cards are named from `hwdata`'s `pci.ids` when that
package is installed, and by DRM node otherwise.

With more than one GPU, a segment strip appears down the left edge and
the tiles page between cards, exactly like the media card's player
switcher: **scroll** anywhere over the tiles, **up/down arrows** while
the pointer is on them, or **click a segment**. The pane opens on the
discrete card — on a hybrid laptop that is the one you are usually
asking about.

Each card gets three tiles:

- **Load** — `gpu_busy_percent` on amdgpu, `utilization.gpu` on nvidia,
  with temperature and shader clock in the subtitle. Either half of the
  subtitle is dropped when its sensor is not exposed.
- **Power** — the hwmon PPT sensor on amdgpu, `power.draw` on nvidia.
  The amdgpu one is labelled "package", not "GPU power", on purpose: on
  an APU, PPT is the budget for the WHOLE SoC, CPU cores included, so it
  is not the iGPU's own draw. nvidia's really is the board, and says so.
- **VRAM** — fill percentage, with used/total GB underneath.
- **GTT** — the same, amdgpu only (nvidia has no GTT). A separate tile
  rather than a line under VRAM: combined, the tile outgrows the pane's
  per-column width and drops the whole grid to a single column.

Cards are never merged into one set of tiles: they have separate
sensors, separate memory pools and separate per-process accounting, and
side-by-side tiles invite reading one card's number as another's.
`mem_busy_percent` (VRAM bandwidth) is deliberately absent: amdgpu does
not expose it on current APUs.

Section: `[bluetooth]` — the bluetooth pane.

| Key | Type | Default | What it does |
|---|---|---|---|
| `notifications` | bool | `true` | Notification when a device connects/disconnects or reports low battery (<= 20%) |
