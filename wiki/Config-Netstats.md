# Net stats

Cumulative bandwidth totals: how much you have downloaded and uploaded
per day, kept for 90 days. Shown as "today" / "this month" tiles in the
quick settings power-mode pane and, optionally, as a bar module. The
live ↓/↑ rate is a separate thing — see `[quicksettings]` `show_stats`
/ `stats_on_panel`.

Section: `[netstats]`. These keys are section-only; they cannot be set
flat at the top level.

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | bool | `true` | Track totals at all; `false` also hides the quick settings tiles and empties the bar module |
| `on_panel` | bool | `false` | Show today's ↓/↑ totals on the panel (classic layout; with `[[panel]]` lists, add `netstats` to a list instead) |

- Totals are collected around the clock (one `/proc/net/dev` read every
  15 s) and stored in `~/.cache/<instance>/netstats.json`, pruned to
  the newest 90 day buckets.
- Traffic moved while the shell is not running is not counted; after a
  reboot the counters restart at zero and only traffic since boot is.
- Loopback, docker, bridge and veth interfaces are excluded.
