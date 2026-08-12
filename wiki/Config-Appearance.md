# Appearance

Which themes the Dark Style toggle switches between, and how much
spacing the shell gets.

Section: `[appearance]`

| Key | Type | Default | What it does |
|---|---|---|---|
| `dark_theme` | string | `"catppuccin-mocha"` | Theme applied when the Dark Style quick settings toggle turns on |
| `light_theme` | string | `"catppuccin-latte"` | Theme applied when the Dark Style toggle turns off |
| `follow_system` | bool | `true` | Also follow the system color scheme at startup, so Dark Style survives a shell restart |
| `density` | `"compact"` / `"comfortable"` / `"relaxed"` | `"comfortable"` | How much air the shell gets; scales spacing only (padding and gaps) — text and icons stay the same size. `"compact"` is for small screens, not small type |

- Dark Style changes are live only; the top-level `theme` key wins
  again on restart unless `follow_system` is on.
- A `density` change recompiles the stylesheet on next start; run
  `ags request -i wam-shell style` to apply it immediately.
