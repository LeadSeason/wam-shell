// Test entry point. The bundler needs static imports, so every new
// tests/*.test.ts must be registered here.
import "./framework.test"
import "./utils.test"
import "./relTime.test"
import "./feed.test"
import "./notifdPopups.test"
import "./rowData.test"
import "./timerInput.test"
import "./kbLayout.test"
import "./sysstats.test"
import "./netTotals.test"
import "./trayPinned.test"
import "./config.test"
import "./configSchema.test"
import "./commandRegistry.test"
import "./exclusivePopups.test"
import "./lifecycle.test"
import "./providerCore.test"
import "./seenStore.test"
import "./cache.test"
import "./metrics.test"
import "./atomicWrite.test"
import "./harvestTimeline.test"
import "./gcal.test"
import "./github.test"
import "./youtube.test"
import "./coverArt.test"
import "./browserArt.test"
import "./googleAuth.test"
import "./credentials.test"
import "./todoist.test"
import "./protonmail.test"
import "./sleepTimerState.test"
import "./vpn.test"
import "./vpn-nm.test"
import "./vpn-proton.test"
import "./hyprDispatch.test"
// summary() must come after every suite has registered. This one used to
// sit BELOW the call, which worked only because ES imports hoist — a
// move to a dynamic import, or a reader "fixing" the order the other
// way, would have dropped it from the tally and from the exit code
// without so much as a warning
import "./bluetooth.test"
import { summary } from "./framework"

summary()
