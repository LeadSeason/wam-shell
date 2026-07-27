# wam-shell conventions

## Widgets must be CSS-targetable

Every new widget (bar module, quick settings section, etc.) must carry
a stable CSS class so users can style it from scss — spacing, colors,
per-panel overrides (`window.Bar.<panel-class>`), and per-widget margin
tweaks. Name classes after the widget (`.sysStats`, `.keyboardLayout`,
`.swayNC`) and add it to the widget-class list comment in
`scss/widgets/bar/bar.scss`.

## Config

- User-facing options live in `config.toml` (all commented, with
  defaults documented) and are parsed in `src/config.ts`.
- After any config change, regenerate `config-override.toml`: copy of
  `config.toml` plus the user's active values appended.

## Styling

- Colors come from the active theme (`scss/theme/*.scss`, selected via
  the `theme` config key) — never hardcode hex in widget styles.
- Shared spacing/radius values live in `scss/conf.scss`.

## Commits

- One logical change per commit; split unrelated changes into separate
  commits when asked.
- Verify the shell starts clean before committing:
  `ags quit -i wam-shell; timeout 8 ags run app.tsx` (no Gjs-CRITICAL /
  JS ERROR output).
