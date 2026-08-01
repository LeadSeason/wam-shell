// Prints Config's resolved statics as JSON (last stdout line) so
// config.test.ts can assert per-scenario results. Config is an import-time
// singleton that reads env and files, so each scenario runs this entry in
// its own gjs process with its own env.
import Config from "../src/config"

const dump = {
    instanceName: Config.instanceName,
    desktopSession: Config.desktopSession,
    instanceCacheDir: Config.instanceCacheDir,
    osIcon: Config.osIcon,
    swayGaps: Config.swayGaps,
    updatesThreshold: Config.updatesThreshold,
    theme: Config.theme,
    workspaces: Config.workspaces,
    tray: Config.tray,
    quicksettings: Config.quicksettings,
    bluetooth: Config.bluetooth,
    media: Config.media,
    hyprsunset: Config.hyprsunset,
    barMonitors: Config.barMonitors,
    panels: Config.panels,
    appearance: Config.appearance,
    osd: Config.osd,
    notifications: Config.notifications,
    sleepTimer: Config.sleepTimer,
    harvest: Config.harvest,
    calendar: Config.calendar,
    github: Config.github,
    youtube: Config.youtube,
}

// must stay the last stdout line — config.test.ts parses it
print(JSON.stringify(dump))
