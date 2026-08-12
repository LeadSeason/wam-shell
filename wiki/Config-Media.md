# Media

MPRIS media controls: the now-playing widget on the panel and the
player in quick settings.

Section: `[media]`.

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | bool | `false` | Show the widget at all (classic layout only — a `[[panel]]` list always renders it) |
| `show_controls` | bool | `true` | Prev/play/next buttons on the panel |
| `max_width` | int | `20` | Maximum length of the track label, in characters |
| `hide_when_screen_sharing` | bool | `false` | "Streaming mode": hide the quick-settings player entirely while screen sharing, so viewers don't see the title, artist or cover |
| `hide_private_sessions` | bool | `true` | Hide browser private/incognito playback (such tracks count as no track) |
| `recover_browser_art` | bool | `true` | Chromium downscales cover art to 150px; with this on, the track title is looked up in the browser's history to find the full-size thumbnail |

- `recover_browser_art` reads the browser's history database read-only,
  and only YouTube rows. Set it to `false` to leave your history
  untouched.
