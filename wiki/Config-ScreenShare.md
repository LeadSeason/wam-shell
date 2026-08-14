# Screen share

The privacy mask behind `hide_when_screen_sharing` in
[[media|Config-Media]] and [[harvest|Config-Harvest]]. Any PipeWire
video-input stream (portal screencast, camera grab) counts as sharing;
while one lasts, the media player hides and the Harvest pill masks
entry details.

Section: `[screen_share]`. Keys are section-only (no flat top-level
spelling).

| Key | Type | Default | What it does |
|---|---|---|---|
| `ignore_apps` | list of strings | `[]` | Apps whose grabs never count as sharing, matched case-insensitively against the stream's `application.name` and `node.name`. For ambient screen consumers without an audience (a Hue light sync), not for hiding real casts from yourself. `huenicorn` is always ignored, built in |
