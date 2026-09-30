# Screen share

The privacy mask behind `hide_when_screen_sharing` in
[[media|Config-Media]] and [[harvest|Config-Harvest]]. Any PipeWire
video-input stream (portal screencast, camera grab) counts as sharing;
while one lasts, the media player hides and the Harvest pill masks
entry details.

Section: `[screen_share]`. Keys are section-only (no flat top-level
spelling).

| Key           | Type            | Default | What it does                                                                                                                                                                                                                                                                       |
| ------------- | --------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignore_apps` | list of strings | `[]`    | Apps whose grabs never count as sharing, matched case-insensitively against the stream's `application.name` and `node.name`. For ambient screen consumers without an audience (a Hue light sync), not for hiding real casts from yourself. `huenicorn` is always ignored, built in |

- Finding the name to ignore: `wam screen-share` lists the streams the
  mask sees right now and what it recently masked on, with the exact
  value to add for each.
- Changes apply on restart: `wam restart`.

The PipeWire watcher behind this mask also drives the bar's two other
privacy indicators: the camera dot (steady red while an app is grabbing
a real camera — a call with video on) and the microphone blink (the
panel's mic icon blinks red while an app records a microphone, muted
included). `ignore_apps` silences the camera dot the same way it
silences the mask; portal screencasts light the mask but deliberately
not the camera dot, which only answers to a device-backed camera being
grabbed. See [[quicksettings|Config-QuickSettings]] for the indicator
descriptions.
