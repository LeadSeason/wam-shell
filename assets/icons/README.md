# Bundled fallback icons

The SVG icons under `hicolor/` are copied from
[adwaita-icon-theme](https://gitlab.gnome.org/GNOME/adwaita-icon-theme)
(GNOME Project), licensed CC-BY-SA-3.0 OR LGPL-3.0-only. Exceptions:
`protonvpn-symbolic.svg` is the simple-icons Proton VPN mark (CC0), and
`mullvad-symbolic.svg` is the secured frame of Mullvad's own menubar
lock (mullvadvpn-app, GPL-3.0), both recoloured to `#2e3436`.

They exist so the shell's core UI icons (toggles, battery, wifi,
volume, media controls, …) resolve even on systems whose icon theme
predates or lacks these names (older Adwaita, minimal/custom themes).
The directory is registered as an icon-theme search path at startup
(`app.tsx`); system themes always take precedence — these are only a
fallback.

When adding new `-symbolic` icon names to the code, copy the matching
SVGs here (keep the category dirs + `index.theme` in sync — contexts
must be standard: actions, status, devices, apps, categories,
mimetypes, places, emblems; non-standard ones like Adwaita's
`legacy`/`ui` do not resolve — `pan-start`/`pan-end` live in Adwaita's
`ui` and are filed under `actions` here).

## Which names belong here: reachability, not grep

A name belongs in this directory if the shell can ever **ask** for it,
which is not the same as it appearing as a literal in `src/`. Four
sources produce names no grep will find, and everything they can emit
has to be bundled:

| source                                         | family                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `AstalBattery.batteryIconName`                 | `battery-*` (36 of them)                                                      |
| `AstalNetwork` `wifi`/`wired`/`ap` `.iconName` | `network-wireless-*`, `network-wired-*`, `network-offline`                    |
| `AstalWp` `volumeIcon`                         | `audio-volume-*`, `microphone-sensitivity-*`                                  |
| BlueZ `device.icon` (device class)             | `phone`, `printer`, `camera-photo`, `input-*`, `audio-headset`, `computer`, … |

Two more that grep misses for different reasons: `power-profile-*` is
built by interpolation (`power-profile-${v}-symbolic`), and the SCSS
reaches icons through `-gtk-icontheme()`, so `scss/` counts as a
reference site alongside `src/`.

Verify both directions rather than eyeballing it. The useful check is
whether the bundle covers everything **on its own** — build a
`Gtk.IconTheme` whose search path is only this directory, set the theme
name to `hicolor`, and `has_icon` every referenced name. With the system
theme on the search path a gap is invisible, because Adwaita quietly
fills it on your machine and not on someone else's.

That check found eleven core names referenced and never bundled —
`battery`, `dialog-warning`, `network-wireless`, `network-transmit-receive`,
`video-display`, the three `audio-*` device icons, `open-menu`,
`pan-start` and `pan-end`. Going the other way, seven had no producer at
all and were removed: `avatar-default` (the header falls back to
`os_icon`, not this), `starred`, `non-starred`, `folder`,
`media-playlist-consecutive`, and `weather-clear-night` and
`dialog-information`, both orphaned when the toggles that used them got
better icons.

`image-missing-symbolic` stays despite having no reference: GTK draws it
when a lookup fails, which is exactly when this directory is doing its
job.

`harvest-symbolic.svg` is an exception: an original drawing (the
Harvest "H" mark), not an Adwaita copy.

`todoist-symbolic.svg` is an original drawing too (the brand's three
stripes in a rounded-square frame): the simpleicons Todoist mark is a
solid square that collapses into an illegible blob at 16px monochrome,
and the stripes alone alias into moiré at that size.

`mail-inbox-symbolic.svg` is also an original drawing (inbox tray):
current Adwaita dropped the name, and the notification center's empty
state fell back to image-missing.

Bundled icons must be FILL-only (fill="currentColor", no stroke
attributes): GTK4's built-in SVG renderer (4.22+) renders strokes as
fills, which turns stroked glyphs into solid blobs.

## Drawing a name Adwaita does not have

`cpu-symbolic.svg`, `memory-symbolic.svg`, `temperature-symbolic.svg`,
`gpu-symbolic.svg`, `hourglass-symbolic.svg`, `speedometer-symbolic.svg`,
`fan-symbolic.svg` (the power pane's stat tiles) and
`dark-mode-symbolic.svg` (the Dark Style toggle) are original drawings.
Adwaita ships none of these names, so nothing upstream can be copied
for them.

They used to be **Papirus** copies, and that was the whole problem: two
icon sets drawn to different grids and different optical weights, sitting
next to each other in one FlowBox. Papirus reads denser and rounder than
Adwaita at 16px, so the power pane looked like it had been assembled from
two shells. The replacements are drawn on Adwaita's own terms:

- 16×16 viewBox, content inset ~1px from the edges
- filled geometry only, `fill="#2e3436"` (GTK recolors by name; the
  literal is Adwaita's own and is never what renders)
- 2px frames, drawn as an outer shape with an `evenodd` counter — never
  a stroke
- checked at true 16px, not just scaled up: a 1px gap between two shapes
  disappears at icon size, which is what merged the speedometer's needle
  into its own dial on the first attempt

`fan-symbolic.svg` (the chassis-fan stat tile) is a three-blade
impeller: hub disc plus three swept blades, no housing ring. Adwaita has
no fan name at all and the near misses all say something else —
`weather-windy` reads as weather, `view-refresh` as reload, and
`temperature-symbolic` is already the thermometer sitting two cells
away. Three blades, not four or five: rendered at true 16px, five go
mushy as the gaps between them close up and four read busier without
saying anything three does not. The blades are SWEPT
(tip rotated ~55° off its root) rather than drawn as symmetric lobes —
the first attempts were radial petals and read as a flower, not a fan.
Their roots start inside the hub radius on purpose: rooted at exactly
the hub edge, antialiasing opens a white ring at 16px and the hub
floats free of its blades.

`caffeine-symbolic.svg` (the Keep Awake toggle and its bar indicator) is
an original drawing too — a mug with two steam ticks. Adwaita has no
name for idle inhibition at all, and the near misses all say something
else: `alarm-symbolic` is the sleep timer's own metaphor sitting in the
same grid, and the padlock pair (`changes-prevent`/`changes-allow`)
reads as locked, not as awake. The steam is two straight ticks rather
than wisps because a curve that thin aliases into grey mush at 16px.

`protonvpn-symbolic.svg` (the VPN pills, `apps/`) is the simple-icons
brand mark (CC0) resized onto the 16px grid: the layered triangle
survives as-is. `mullvad-symbolic.svg` is Mullvad's own TRAY padlock
(the secured frame of their menubar lock) rather than the mole: the
brand mark is the mole knocked out of a filled disc, and every attempt
to make it work at 16px failed — the disc reads as a coin with a bite,
the extracted mole keeps the diagonal pose the disc dictated and reads
as a brush stroke, and a simplified redraw had too much detail for the
size. Mullvad already solved this problem for their own tray; the lock
is their answer, taken verbatim. `mullvad-open-symbolic.svg` is the
same lock with the shackle redrawn open (lifted right leg, relative
arcs) for the down state — Mullvad's own tray signals unsecured by
recolour, which a symbolic icon cannot do.

One renderer lesson the mole hunt bought, recorded so it is not paid
for twice: **GTK 4.22's built-in SVG renderer mangles ABSOLUTE arc
commands (`A`) in symbolic icons** — the same geometry with relative
arcs (`a`) or cubics renders correctly, with absolute arcs the glyph
collapses into a small misshapen blob. rsvg renders both forms
identically, so check icons in the shell, not just in an image viewer.

`dark-mode-symbolic` is a half-filled disc rather than a crescent on
purpose. It sits beside Night Light in the toggle grid, and Adwaita's
`night-light-symbolic` is already a moon — two moons in one grid say
nothing about which is which.
