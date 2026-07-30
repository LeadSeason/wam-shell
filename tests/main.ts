// Test entry point. The bundler needs static imports, so every new
// tests/*.test.ts must be registered here.
import "./utils.test"
import "./kbLayout.test"
import "./sysstats.test"
import "./trayPinned.test"
import "./config.test"
import "./metrics.test"
import "./harvestTimeline.test"

import { summary } from "./framework"

summary()
