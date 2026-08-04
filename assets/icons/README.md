# Bundled fallback icons

The SVG icons under `hicolor/` are copied from
[adwaita-icon-theme](https://gitlab.gnome.org/GNOME/adwaita-icon-theme)
(GNOME Project), licensed CC-BY-SA-3.0 OR LGPL-3.0-only.

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
`legacy`/`ui` do not resolve).

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

`cpu-symbolic.svg`, `memory-symbolic.svg`, `sensors-fan-symbolic.svg`,
`freon-temperature-symbolic.svg` and `freon-gpu-temperature-symbolic.svg`,
`hourglass-symbolic.svg`
are from the [Papirus icon theme](https://github.com/PapirusDevelopmentTeam/papirus-icon-theme)
(GPL-3.0), bundled for the power pane's stat tiles.

`speedometer-symbolic.svg` is the Papirus gauge (GPL-3.0), bundled
because some themes don't inherit Breeze (a breeze-only name fell
back to image-missing); the Papirus stroke matches the other bundled
symbols at tile size.
