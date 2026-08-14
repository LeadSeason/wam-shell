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
| `recover_site_art` | bool | `true` | Non-YouTube half of the above: find the playing page in history by the track title slugged into its URL, fetch it, use its `og:image`. Only runs when `recover_browser_art` is on |
| `enrich_titles` | bool | `true` | A browser track with no artist metadata gets the series name from the playing page's tab title. A bare "Episode 1" title is replaced by the series name (episode label becomes the subtitle); a real title keeps the title line and the series replaces the app name on the subtitle line |

- `recover_browser_art` reads the browser's history database read-only,
  and only YouTube rows. Set it to `false` to leave your history
  untouched (this also disables `recover_site_art`).
- When no history row carries the track title (e.g. an extension like
  DeArrow rewrites titles), the recovery falls back to pixel-matching
  the small cover against the thumbnails of recently visited watch
  pages. Title-rewriting extensions leave the artwork untouched.
- `recover_site_art` works on server-rendered pages (the track title,
  slugged, has to appear in the watch URL, and the page has to carry
  an `og:image`). A JS-rendered shell with no meta tags still falls
  back to the 150px thumb. It re-fetches a page you just visited, at
  most once per unrecognized track.
