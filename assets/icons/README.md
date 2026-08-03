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

`todoist-symbolic.svg` is the Todoist brand mark from
[simpleicons.org](https://simpleicons.org) (CC0-1.0), bundled for the
same fallback reason.

`cpu-symbolic.svg`, `memory-symbolic.svg`, `sensors-fan-symbolic.svg`,
`freon-temperature-symbolic.svg` and `freon-gpu-temperature-symbolic.svg`,
`hourglass-symbolic.svg`
are from the [Papirus icon theme](https://github.com/PapirusDevelopmentTeam/papirus-icon-theme)
(GPL-3.0), bundled for the power pane's stat tiles.

`speedometer-symbolic.svg` is the Papirus gauge (GPL-3.0), bundled
because some themes don't inherit Breeze (a breeze-only name fell
back to image-missing); the Papirus stroke matches the other bundled
symbols at tile size.
