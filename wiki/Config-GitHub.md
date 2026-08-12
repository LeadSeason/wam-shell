# GitHub

Unread GitHub notifications inside the notification center: the inbox
merges into the center's list, and a GitHub icon in the header filters
to just them. Clicking an item opens the thread in the browser and marks
it read; dismissing marks it done on GitHub (recoverable via the Done
filter on github.com).

Section: `[github]`

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | bool | `true` | Master toggle (requires a token, see below) |
| `poll_minutes` | int | `5` | Minutes between inbox syncs (minimum `1`); the center also refreshes when opened, at most once a minute |

Auth — the token is never read from `config.toml`:

- Create a personal access token at github.com/settings/tokens:
  fine-grained with Notifications read access, or classic with the
  `notifications` scope.
- Put it in `~/.config/wam-shell/github.env` as `GITHUB_TOKEN=...` and
  `chmod 600` the file. The `GITHUB_TOKEN` environment variable works
  too and takes precedence.
- Without a token the center shows desktop notifications only, even
  when `enabled` is `true`.

Re-polls are conditional (`If-Modified-Since`) and do not count against
the GitHub rate limit.
