# Hyprsunset

Night light via hyprsunset (hyprland only) — the temperatures and
gamma the shell applies when night light is off, on, or boosted for
outdoor use.

Section: `[hyprsunset]`

| Key                   | Type    | Default                             | What it does                                                              |
| --------------------- | ------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `temperature_default` | kelvin  | `6000`                              | Color temperature used normally (night light off, gamma at or below 100%) |
| `temperature_outdoor` | kelvin  | falls back to `temperature_default` | Temperature applied in outdoor mode (gamma above 100%)                    |
| `night_temp`          | kelvin  | `4000`                              | Temperature when night light is on                                        |
| `gamma_outdoor`       | percent | `150`                               | Gamma in outdoor mode; may exceed 100                                     |
