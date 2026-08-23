# YouTube

New uploads from your YouTube subscriptions in the notification center:
they merge into the list with thumbnails, a YouTube icon in the header
filters to them, and clicking one opens the video. Dismissing hides an
item locally only — YouTube has no read/done API.

Section: `[youtube]`

| Key            | Type | Default | What it does                                                                                                                                                                                                                                                                                                |
| -------------- | ---- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`      | bool | `false` | Master toggle for YouTube notifications                                                                                                                                                                                                                                                                     |
| `poll_minutes` | int  | `60`    | Minutes between syncs (clamped to 15 minimum); each sync fetches the uploads playlist of every subscribed channel (~1 quota unit per subscription — the default 10k/day quota fits ~275 subscriptions hourly), and the interval is raised automatically when your subscription count would exceed the quota |

Setup:

- Uses the same Google OAuth client as `[calendar]` — no credentials to
  create or install.
- Sign in once per Google account via the browser consent; the center's
  YouTube filter shows a "Sign in to YouTube" button until then.
- Tokens are stored in `~/.config/wam-shell/youtube-tokens.json` (keep it
  `chmod 600`) — never put credentials in `config.toml`.

Comments and replies are not available via any API, so only new uploads
appear.
