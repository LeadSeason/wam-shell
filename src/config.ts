import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { parse as parseTomlText } from "smol-toml"
import { createState } from "gnim"
import { execAsync } from "ags/process"
import { readFile } from "ags/file"
import { isFile } from "./lib/utils"
import { createReader, numberList } from "./lib/configSchema"
import type { TimeFormat } from "./lib/timerInput"

// scss/theme/script paths resolve against the repo root. Launching from
// another cwd breaks that; WAM_SHELL_DIR overrides when needed.
const instanceSrcDir = GLib.getenv("WAM_SHELL_DIR") || GLib.get_current_dir()
const userHomeDir = GLib.getenv("HOME")
const xdgConfigHomeDir = GLib.getenv("XDG_CONFIG_HOME")

// Locate and load config
const configFile = findConfigFile()
if (configFile) {
    console.log("Found config file:", configFile)
}
const configData = parseToml(readRawFile(configFile))

function findConfigFile(): string | undefined {
    // Candidates ordered by priority (highest first)
    const candidates = [
        `${xdgConfigHomeDir}/wam-shell/config.toml`,
        `${userHomeDir}/.config/wam-shell/config.toml`,
        `${instanceSrcDir}/config-override.toml`,
        `${instanceSrcDir}/config.toml`,
    ]

    for (const candidate of candidates) {
        if (isFile(candidate)) return candidate
    }
    return undefined
}

function readRawFile(path?: string): string {
    if (!path) return ""
    try {
        return readFile(path) || ""
    } catch (err) {
        console.error(`Failed reading ${path}:`, err)
        return ""
    }
}

// smol-toml, not the `toml` package: that one implements TOML 0.4 and
// was last published in 2018, so a DOTTED KEY (`tray.spacing = 3` — a
// 0.5 feature, and the spelling anyone who has written TOML this decade
// reaches for) was a parse ERROR: "Expected "=" ... but "." found".
//
// Which matters more than it sounds, because of what happens next: the
// throw is caught here and the whole document becomes {}. One dotted key
// anywhere in the file therefore discarded the user's ENTIRE config and
// ran the shell on defaults, with a single line in a log to say so.
//
// smol-toml is TOML 1.0.0 compliant, has no dependencies, and is
// maintained. It still rejects genuinely invalid documents (a redefined
// key is still an error) — it just does not reject valid ones.
function parseToml(raw: string): Record<string, any> {
    if (!raw) return {}
    try {
        return parseTomlText(raw) as Record<string, any>
    } catch (err) {
        console.error("Failed parsing TOML:", err)
    }
    return {}
}

function getOsIcon(): string {
    const configured = topLevel.str("os_icon", "")
    if (configured) return configured

    // Get OsIcon from /etc/os-release
    try {
        const content = readFile("/etc/os-release") || ""
        const match = content.match(/^LOGO=(.+)$/m)?.[1] ?? ""
        return match.replace(/^"|"$/g, "")
    } catch (err) {
        console.error("Failed to parse /etc/os-release for LOGO=\n", err)
    }

    return ""
}

function getDesktopSession(): string {
    // an override of "" is indistinguishable from an absent key here,
    // and both mean the same thing: use the environment
    const override = topLevel.str("desktop_session_override", "")
    const desktop = override || GLib.getenv("DESKTOP_SESSION")

    // Preflight checks for i3/sway (both speak the i3 IPC protocol)
    if (desktop === "sway" || desktop === "i3") {
        if (typeof GLib.getenv("I3SOCK") !== "string") {
            console.error(`i3/sway ipc I3SOCK Socket ENV missing`)
            return "" // Fallback
        }

        return desktop
    }

    // Preflight for hyprland, matching what sway/i3 get above: a session
    // that says "hyprland" without a compositor to talk to would send
    // every `hyprctl` call and every AstalHyprland lookup into a socket
    // that is not there. HYPRLAND_INSTANCE_SIGNATURE is what names that
    // socket, so its absence is the same class of answer as a missing
    // I3SOCK — fall back to the compositor-agnostic paths instead.
    if (desktop === "hyprland") {
        if (typeof GLib.getenv("HYPRLAND_INSTANCE_SIGNATURE") !== "string") {
            console.error("hyprland ipc HYPRLAND_INSTANCE_SIGNATURE env missing")
            return "" // Fallback
        }
        return "hyprland"
    }

    // Default fallback
    if (desktop !== null) {
        console.warn(`${desktop} is unsupported desktop session`)
        return desktop
    }

    // Default fallback
    console.warn(`DESKTOP_SESSION env is ${desktop}`)
    return ""
}

// Keys can be set in a [workspaces] section or flat at the top level;
// the section takes precedence. Same for [tray], [quicksettings],
// [bluetooth], [media], [appearance], [hyprsunset], [sleep_timer],
// [harvest], [notifications] and [osd] below — the service sections
// pass sectionOnly instead (see lib/configSchema).
function getWorkspacesConfig() {
    const r = createReader(configData, "workspaces")
    return {
        // sectionOnly: "enabled" is the most generic name in the file and
        // five sections read it. A bare top-level `enabled` (anything
        // written above the first [table] header is top-level in TOML)
        // would otherwise reach all of them at once, so someone disabling
        // one widget silently disabled four more with no diagnostic — a
        // valid boolean is never reported. Same collision class as
        // bluetooth.notifications and tray.on_panel below
        enabled: r.bool("enabled", true, { sectionOnly: true }),
        // NB this reads a bare top-level "position" too, which is the
        // historical behaviour and is kept deliberately — the tray is
        // the one that had to move aside (tray_position). Changing it
        // now would silently relocate a working config's workspaces
        position: r.oneOf("position", ["left", "right"] as const, "left"),
        showIcons: r.bool("show_icons", true),
        showLabels: r.bool("show_labels", true),
        hideEmpty: r.bool("hide_empty", false),
        collapseIcons: r.bool("collapse_icons", false),
        playingIndicator: r.bool("playing_indicator", true),
        // min: below ~200ms the pulse stops reading as "breathing" and
        // starts reading as a strobe
        playingPulseMs: r.num("playing_pulse_ms", 650, { min: 200 }),
    }
}

function getTrayConfig() {
    const r = createReader(configData, "tray")
    return {
        onPanel: r.bool("on_panel", false),
        spacing: r.num("spacing", 0, { min: 0 }),
        // the top-level spelling is "tray_position": a bare "position"
        // key would collide with workspaces.position
        position: r.oneOf("position", ["left", "right"] as const, "left", {
            flatKey: "tray_position",
        }),
        alwaysOnPanel: r.strList("always_on_panel", []),
        // type-guarded like spacing/width: a non-number (popup_icon_size
        // = "22") reaches Gtk.Image.pixelSize / pill CSS at startup
        popupIconSize: r.num("popup_icon_size", 22, { positive: true }),
    }
}

function getQSettingsConfig() {
    const r = createReader(configData, "quicksettings")
    return {
        showBatteryPercentage: r.bool("show_battery_percentage", true),
        showDeviceNames: r.bool("show_device_names", false),
        showStats: r.bool("show_stats", false),
        statsOnPanel: r.bool("stats_on_panel", false),
        statsInterval: r.num("stats_interval", 1000, { positive: true }),
        // popup content width in px (the scroll view clamps it)
        width: r.num("width", 440, { positive: true }),
        // the power profile icon in the bar's quicksettings label
        powerProfileOnPanel: r.bool("power_profile_on_panel", true),
        // close the popup when a player starts playing: pressing play
        // here (or a video starting elsewhere) means the user wants to
        // watch, not to keep reading the popup
        hideOnMediaPlay: r.bool("hide_on_media_play", true),
        // draw a playback level bar under the default output device in
        // the audio pane. Reading a level means capturing the sink's
        // monitor, so this runs a gstreamer pipeline — only while that
        // pane is open, and never at all when this is false
        audioMeter: r.bool("audio_meter", true),
        // the same bar under the default input device. Separate from
        // audio_meter because it is a different bargain: reading an
        // input level means opening the microphone (only while the
        // Input pane is on screen, but still opening it)
        micMeter: r.bool("mic_meter", true),
        // floor for the pane area, in px. 0 = derive it from the
        // smallest monitor, which is what keeps the popup sane on a
        // short or heavily-scaled screen
        minHeight: r.num("min_height", 0, { min: 0 }),
        // header avatar: absolute path to an image; empty = the login
        // avatar from AccountsService, else the OS icon. Type-guarded:
        // a non-string (avatar = 5) would crash GLib.file_test at
        // startup
        avatar: r.str("avatar", ""),
        showAvatar: r.bool("show_avatar", true),
        // charge cap in percent: the header ring treats this as full.
        // Lazy (see batteryFullAt below) — the sysfs probe behind it is
        // three blocking reads that nothing needs before the first frame
        get batteryFullAt(): number {
            return batteryFullAt()
        },
    }
}

// The battery charge cap, resolved once on first use.
//
// Explicit config wins; otherwise auto-detect from sysfs
// (charge_control_end_threshold, e.g. Lenovo/ASUS limits); 100 when
// neither is available.
//
// Deferred rather than computed at import: the fallback path stats and
// reads up to three sysfs files, and the only consumer is the quick
// settings header ring — which does not exist until the user opens the
// popup. Nothing should read the battery cap to draw the first frame.
let batteryFullAtCache: number | null = null

function batteryFullAt(): number {
    if (batteryFullAtCache !== null) return batteryFullAtCache
    const explicit = createReader(configData, "quicksettings").raw("battery_full_at")
    if (typeof explicit === "number" && explicit > 0 && explicit <= 100) {
        return (batteryFullAtCache = explicit)
    }
    for (const bat of ["BAT0", "BAT1", "BAT2"]) {
        const p = `/sys/class/power_supply/${bat}/charge_control_end_threshold`
        try {
            if (isFile(p)) {
                const v = Number(readFile(p).trim())
                if (v > 0 && v <= 100) return (batteryFullAtCache = v)
            }
        } catch {}
    }
    return (batteryFullAtCache = 100)
}

function getBluetoothConfig() {
    const r = createReader(configData, "bluetooth")
    return {
        // sectionOnly, and it has to be: the flat fallback for this key
        // is the top-level `notifications` name, which is a SECTION —
        // so any config with a [notifications] table handed this a table
        // where a boolean belongs. It went unnoticed because a table is
        // truthy and the default is true, so the wrong value and the
        // right one behaved identically. This is the collision class the
        // flat fallback exists to create; here it is, found by a type
        // check the old untyped `get()` never performed
        notifications: r.bool("notifications", true, { sectionOnly: true }),
    }
}

function getIdleInhibitConfig() {
    const r = createReader(configData, "idle_inhibit", { sectionOnly: true })
    return {
        // Run this instead of taking a logind inhibitor lock, for
        // sessions whose idle daemon ignores logind (swayidle does).
        // Held for as long as keep-awake is on and killed when it goes
        // off, so the command must BLOCK — `wlinhibit`, or
        // `["systemd-inhibit", "--what=idle", "sleep", "infinity"]`.
        // Empty (the default) uses the built-in lock.
        command: r.strList("command", []),
    }
}

function getNetstatsConfig() {
    const r = createReader(configData, "netstats", { sectionOnly: true })
    return {
        // track cumulative rx/tx per day (lib/netTotals); off = no poll,
        // no store, and the QS tiles + bar module show nothing
        enabled: r.bool("enabled", true),
        // legacy non-[[panel]] bar layout only; panel lists name the
        // widget directly ("netstats")
        onPanel: r.bool("on_panel", false),
    }
}

function getMediaConfig() {
    const r = createReader(configData, "media")
    return {
        // sectionOnly — see the note on workspaces.enabled
        enabled: r.bool("enabled", false, { sectionOnly: true }),
        showControls: r.bool("show_controls", true),
        maxWidth: r.num("max_width", 20, { positive: true }),
        // while screen sharing, hide the quick-settings player entirely
        // (title/artist/cover are visible to viewers otherwise)
        hideWhenScreenSharing: r.bool("hide_when_screen_sharing", false),
        // treat browsers' scrubbed private-session titles as no track
        hidePrivateSessions: r.bool("hide_private_sessions", true),
        // look a chromium browser's 150px mpris art back up in its own
        // history db to find the full-size one (lib/browserArt). Reads
        // browsing history, so it is worth a switch even though the
        // query is a title match against youtube rows only
        recoverBrowserArt: r.bool("recover_browser_art", true),
        // the non-youtube half of the recovery: find the playing page
        // in history by the track title slugged into its url, fetch it
        // and take its og:image. Only runs when recover_browser_art is
        // on, and only for tracks the youtube tiers cannot resolve
        recoverSiteArt: r.bool("recover_site_art", true),
    }
}

function getScreenShareConfig() {
    // sectionOnly section-wide, like the service sections: a new key has
    // no historical flat spelling to keep alive
    const r = createReader(configData, "screen_share", { sectionOnly: true })
    return {
        // apps whose video-input streams never count as sharing (ambient
        // screen grabs like a Hue light sync), matched case-insensitively
        // against application.name and node.name
        ignoreApps: r.strList("ignore_apps", []).map(a => a.toLowerCase()),
    }
}

// The spacing multiplier behind `[appearance] density`, applied to the
// scss space scale (`space()` in scss/conf.scss). Named rather than
// numeric on purpose: a free-form multiplier invites 0.3, which compiles
// perfectly and produces a shell with no padding anywhere.
const DENSITY = { compact: 0.8, comfortable: 1, relaxed: 1.2 } as const

function getAppearanceConfig(data: Record<string, any> = configData) {
    const r = createReader(data, "appearance")
    // a theme name is only valid if the stylesheet exists: a typo must
    // land on the documented default rather than compiling to nothing
    const themeOr = (key: string, fallback: string) => {
        const t = r.str(key, fallback)
        return isFile(`${instanceSrcDir}/scss/theme/${t}.scss`) ? t : fallback
    }
    return {
        // themes applied when Dark Style toggles on/off
        darkTheme: themeOr("dark_theme", "catppuccin-mocha"),
        lightTheme: themeOr("light_theme", "catppuccin-latte"),
        // also follow the system color scheme at startup
        followSystem: r.bool("follow_system", true),
        // how much air the whole shell gets. Spacing only — radii, type
        // and icon sizes stay put, because scaling those as well stops
        // being "tighter" and becomes "smaller"
        density: DENSITY[r.oneOf("density", ["compact", "comfortable", "relaxed"], "comfortable")],
    }
}

// resolve the theme, following the system color scheme when enabled:
// Dark Style left off must survive a shell restart
function resolveTheme(data: Record<string, any>): string {
    const theme = getTheme(data)
    // from the SAME document as getTheme, not the one captured at import:
    // reloadTheme re-parses the file so a theme change applies without a
    // restart, and with follow_system on (the default) the answer comes
    // from dark_theme/light_theme rather than from `theme` — so reading
    // those off the stale copy meant editing them did nothing until a
    // full restart, while editing the bare `theme` key appeared to work
    const appearance = getAppearanceConfig(data)
    if (!appearance.followSystem) return theme
    // new Gio.Settings({schema_id}) on a missing schema aborts the
    // process (a g_error, not a catchable exception) — look it up first
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(
        "org.gnome.desktop.interface",
        true,
    )
    // schema not installed — keep the configured theme
    if (!schema) return theme
    const s = new Gio.Settings({ settings_schema: schema })
    return s.get_string("color-scheme").includes("prefer-dark")
        ? appearance.darkTheme
        : appearance.lightTheme
}

function getHyprsunsetConfig() {
    const r = createReader(configData, "hyprsunset")
    return {
        // temperature used normally (night light off, gamma <= 100%)
        temperatureDefault: r.num("temperature_default", 6000, { positive: true }),
        // temperature applied in outdoor mode (gamma > 100%).
        // falls back to temperature_default when omitted, so the absent
        // case has to stay distinguishable from a configured value
        temperatureOutdoor:
            r.raw("temperature_outdoor") === undefined
                ? null
                : r.num("temperature_outdoor", 6000, { positive: true }),
        nightTemp: r.num("night_temp", 4000, { positive: true }),
        // gamma in outdoor mode, in percent (may exceed 100)
        gammaOutdoor: r.num("gamma_outdoor", 150, { positive: true }),
    }
}

function getBarMonitors(): string[] {
    // connectors (e.g. "eDP-1") that get a panel; empty = all monitors
    return createReader(configData, "").strList("bar_monitors", [])
}

function getSleepTimerConfig() {
    const r = createReader(configData, "sleep_timer")

    // 1..100 percent, stored as a fraction
    const percent = (key: string, fallbackPercent: number) =>
        r.num(key, fallbackPercent, { min: 1, max: 100 }) / 100

    return {
        presets: numberList("sleep_timer.presets", r.raw("presets"), [10, 15, 20, 30, 45, 60]),
        // how the entry reads and writes clock times. 24h is the default
        // rather than the locale's choice: the shell's own strings are
        // English and its clock is already numeric, so following the
        // locale here would be the only place it did. "auto" opts into it
        timeFormat: r.oneOf("time_format", ["24h", "12h", "auto"] as const, "24h") as TimeFormat,
        // show the sleep timer toggle in quick settings.
        // sectionOnly — see the note on workspaces.enabled
        enabled: r.bool("enabled", true, { sectionOnly: true }),
        // show the countdown on the panel while a timer runs.
        // Section-only, NOT the usual top-level fallback: the tray's
        // top-level on_panel key would leak in otherwise
        onPanel: r.bool("on_panel", true, { sectionOnly: true }),
        // dim the screen on fire: dim_level as a fraction of the current
        // brightness (default 0.4), never below the dim_floor minimum
        dim: r.bool("dim", true),
        dimLevel: r.num("dim_level", 0.4, { min: 0, max: 1 }),
        dimFloor: r.num("dim_floor", 0.15, { min: 0, max: 1 }),
        // play a soothing chime in a loop when the timer reaches 0,
        // until stopped from the pill
        alarm: r.bool("alarm", false),
        // the volume the sink is raised to while the alarm rings
        alarmVolume: percent("alarm_volume", 80),
        // restore the pre-dim brightness when media starts playing
        // after a fire (the mute lift on play always happens)
        restoreOnPlay: r.bool("restore_on_play", false),
        // an alarm is a reminder: when it rings, nothing is paused,
        // muted or dimmed. false = ring AND do the sleep actions
        alarmOnly: r.bool("alarm_only", true),
    }
}

function getHarvestConfig() {
    const r = createReader(configData, "harvest")

    // both keys must hold "HH:MM" or the window is disabled
    const hhmm = (v: string) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(v)
    let workStart = r.str("work_start", "")
    let workEnd = r.str("work_end", "")
    if (!hhmm(workStart) || !hhmm(workEnd)) {
        if (workStart !== "" || workEnd !== "") {
            console.error(
                `Config "harvest.work_start"/"harvest.work_end" must both be "HH:MM", got "${workStart}"/"${workEnd}"; disabling the window`,
            )
        }
        workStart = ""
        workEnd = ""
    }

    const workDaysRaw = r.str("work_days", "")
    const parsedDays = parseWorkDays(workDaysRaw)
    if (parsedDays === null) {
        console.error(
            `Config "harvest.work_days" has an invalid range, got "${workDaysRaw}" (expected e.g. "1-5" or "6,0"; 0=Sunday); treating as every day`,
        )
    }

    return {
        // sectionOnly — see the note on workspaces.enabled
        enabled: r.bool("enabled", false, { sectionOnly: true }),
        // section-only, NOT the usual top-level fallback: the tray's
        // top-level on_panel key would leak in otherwise
        onPanel: r.bool("on_panel", true, { sectionOnly: true }),
        // floor: a config typo must not throttle the Harvest account
        pollInterval: r.num("poll_interval", 10, { positive: true, floor: 5 }),
        recents: r.num("recents", 5, { positive: true }),
        workStart,
        workEnd,
        workDays: parsedDays ?? [],
        // off work_days, shrink to a bare icon instead of hiding
        collapseOffDays: r.bool("collapse_off_days", false),
        // while screen sharing, mask entry details on the panel
        hideWhenScreenSharing: r.bool("hide_when_screen_sharing", true),
        // banner every timer start/pause, wherever it happened (this
        // shell, the web app, the phone). Critical urgency: it waits
        // to be dismissed
        notify: r.bool("notify", true),
    }
}

// "1-5" / "5-1" / "6,0" -> weekday numbers matching Date.getDay()
// (0=Sunday); ranges walk forward modulo the week, so they may wrap
// ("5-1" = Fri,Sat,Sun,Mon). null = malformed
function parseWorkDays(raw: string): number[] | null {
    if (raw.trim() === "") return []
    const out = new Set<number>()
    for (const part of raw.split(",")) {
        const m = part.trim().match(/^(\d)(?:-(\d))?$/)
        if (!m) return null
        const a = Number(m[1])
        const b = m[2] !== undefined ? Number(m[2]) : a
        if (a > 6 || b > 6) return null
        for (let d = a; ; d = (d + 1) % 7) {
            out.add(d)
            if (d === b) break
        }
    }
    return [...out].sort((x, y) => x - y)
}

// The service providers. Every one of these sections is sectionOnly:
// their key names (enabled, poll_minutes, port) are generic enough that
// a top-level spelling would leak across all five at once, and none of
// them ever had one to be compatible with.

// Google Calendar in the clock popover
function getCalendarConfig() {
    const r = createReader(configData, "calendar", { sectionOnly: true })
    return {
        enabled: r.bool("enabled", true),
        // floor: a config typo must not burn the Calendar API quota
        pollMinutes: r.num("poll_minutes", 15, { positive: true, floor: 5 }),
        hiddenCalendars: r.strList("hidden_calendars", []),
        // ISO-8601 week numbers down the month grid's left edge
        weekNumbers: r.bool("week_numbers", true),
    }
}

// GitHub notifications in the notification center
function getGitHubConfig() {
    const r = createReader(configData, "github", { sectionOnly: true })
    return {
        enabled: r.bool("enabled", true),
        // floor: a config typo must not burn the GitHub API rate limit
        pollMinutes: r.num("poll_minutes", 5, { positive: true, floor: 1 }),
    }
}

// Todoist tasks (due today/tomorrow) in the notification center
function getTodoistConfig() {
    const r = createReader(configData, "todoist", { sectionOnly: true })
    return {
        enabled: r.bool("enabled", true),
        // floor: a config typo must not burn the Todoist API rate limit
        pollMinutes: r.num("poll_minutes", 5, { positive: true, floor: 1 }),
        // proactive banners before a scheduled (timed) task is due
        reminders: r.bool("reminders", true),
        remindBeforeMinutes: r.num("remind_before_minutes", 5, { min: 0 }),
        // the banner's Postpone button: local snooze length (capped at
        // the task's due time)
        snoozeMinutes: r.num("snooze_minutes", 30, { positive: true }),
    }
}

// ProtonMail unread mail in the notification center, via ProtonMail
// Bridge's local IMAP
function getProtonmailConfig() {
    const r = createReader(configData, "protonmail", { sectionOnly: true })
    return {
        enabled: r.bool("enabled", true),
        // floor: a config typo must not hammer the bridge
        pollMinutes: r.num("poll_minutes", 2, { positive: true, floor: 1 }),
        host: r.str("host", "127.0.0.1", { nonEmpty: true }),
        port: r.num("port", 1143, { positive: true }),
        // IMAP LOGIN sends the bridge password in the clear. On loopback
        // that is a hop between two processes owned by the same user and
        // is how the bridge is meant to be used; off it, it is a password
        // on the wire. So `host` alone no longer decides: a non-loopback
        // host REQUIRES tls, and lib/protonmail refuses to start
        // otherwise rather than quietly transmitting it
        tls: r.bool("tls", false),
        // the bridge presents a self-signed certificate, so a strict
        // handshake against a remote one fails. This accepts it anyway:
        // still defeats passive sniffing, does NOT defeat an active MITM.
        // Deliberately its own key so opting out of verification is a
        // thing the user wrote down
        tlsInsecure: r.bool("tls_insecure", false),
    }
}

// YouTube notifications in the notification center
function getYouTubeConfig() {
    const r = createReader(configData, "youtube", { sectionOnly: true })
    return {
        enabled: r.bool("enabled", true),
        // floor: a config typo must not burn the YouTube API quota (each
        // poll costs ~1 unit per subscription; see config.toml)
        pollMinutes: r.num("poll_minutes", 60, { positive: true, floor: 15 }),
    }
}

function getNotificationsConfig() {
    const r = createReader(configData, "notifications")
    return {
        // transient banners for incoming notifications
        popups: r.bool("popups", true),
        // provider names ("github", "youtube", ...) whose items may
        // also raise transient banners. opt-in: empty = center only
        popupProviders: r.strList("popup_providers", []),
        // ms before a popup auto-hides (critical stays until dismissed,
        // low urgency drains in half the time)
        popupTimeout: r.num("popup_timeout", 5000, { positive: true }),
        position: r.oneOf("position", ["topRight", "topCenter"] as const, "topRight", {
            // a bare top-level "position" belongs to the workspaces
            sectionOnly: true,
        }),
        // fixed banner width in px: the stack must not resize as
        // notifications arrive and expire
        popupWidth: r.num("popup_width", 460, { positive: true }),
        // whose notification daemon is used: auto = the system's if one
        // is running, ours otherwise
        daemon: r.oneOf("daemon", ["auto", "wam-shell", "system"] as const, "auto"),
        // app names whose notifications are popup-only: shown as banners
        // but excluded from the center's history. Lowercased once here,
        // so every comparison site can match without repeating it
        transientApps: r.strList("transient_apps", []).map(a => a.toLowerCase()),
    }
}

function getOsdConfig() {
    const r = createReader(configData, "osd")
    const position = r.oneOf("position", ["bottom", "center", "top"] as const, "bottom", {
        // a bare top-level "position" belongs to the workspaces
        sectionOnly: true,
    })
    const timeout = r.num("timeout", 2000, { positive: true })

    // How long a pill stays up depends on what it is telling you.
    //
    // Volume and brightness are DRIVEN: you hold the key and watch the
    // bar, and every step restarts the timer anyway — the timeout is
    // only how long it lingers after you stop, so it can afford to be
    // generous. A layout or lock-key pill is an ANNOUNCEMENT: one word,
    // read in a glance, already known by the time it fades. Leaving
    // those up for the same two seconds is just an obstacle over the
    // window you just switched language to type into.
    //
    // Expressed as fractions of `timeout` rather than fixed values, so
    // a user who raises the base still gets the shorter ones shorter —
    // and any kind can be pinned outright with its own key.
    const scale: Record<string, number> = {
        volume: 1,
        microphone: 1,
        brightness: 1,
        layout: 0.3,
        lockKeys: 0.6,
    }
    // the scaled duration, unless the user pinned this kind outright
    const perKind = (kind: keyof typeof scale, key: string) =>
        r.num(`timeout_${key}`, Math.round(timeout * scale[kind]), { positive: true })

    return {
        // sectionOnly — see the note on workspaces.enabled
        enabled: r.bool("enabled", true, { sectionOnly: true }),
        position,
        // distance from the anchored edge. 140 clears the message
        // composer of a bottom-docked chat app (slack, discord), which a
        // 60px pill sat right on top of; "center" ignores it
        margin: r.num("margin", 140, { min: 0 }),
        timeout,
        // per-trigger durations, keyed by OSD kind (see the note above)
        timeouts: {
            volume: perKind("volume", "volume"),
            microphone: perKind("microphone", "microphone"),
            brightness: perKind("brightness", "brightness"),
            layout: perKind("layout", "layout"),
            lockKeys: perKind("lockKeys", "lock_keys"),
        },
        // per-trigger toggles
        volume: r.bool("volume", true),
        microphone: r.bool("microphone", true),
        brightness: r.bool("brightness", true),
        layout: r.bool("layout", true),
        lockKeys: r.bool("lock_keys", true),
    }
}

function getTheme(data: Record<string, any>): string {
    const fallback = "catppuccin-mocha"
    const t = data.theme
    if (t === undefined) return fallback
    if (typeof t !== "string" || !isFile(`${instanceSrcDir}/scss/theme/${t}.scss`)) {
        console.error(`Config "theme": no scss/theme/${t}.scss, falling back to ${fallback}`)
        return fallback
    }
    return t
}

export interface PanelConfig {
    monitors: string[]
    position: "top" | "bottom"
    class: string
    height: number
    floating: boolean
    left: string[]
    center: string[]
    right: string[]
}

const PANEL_WIDGETS = [
    "osicon",
    "workspaces",
    "clock",
    "stats",
    "tray",
    "quicksettings",
    "language",
    "notifications",
    "media",
    "sleeptimer",
    "harvest",
    "windowtitle",
    "netstats",
]

function getPanelsConfig(): PanelConfig[] {
    const p = configData.panel
    if (p === undefined) return []
    if (!Array.isArray(p)) {
        console.error(`Config "panel" must be a list of [[panel]] tables`)
        return []
    }

    const strList = (v: any, fallback: string[]) =>
        Array.isArray(v) ? v.filter(x => typeof x === "string") : fallback

    return p.map((entry: any, i: number) => {
        // hand-rolled rather than a SectionReader: these are anonymous
        // tables in a list, and the useful label is the INDEX
        // ("panel[1].position"), which a section name cannot carry
        let position = entry.position ?? "top"
        if (position !== "top" && position !== "bottom") {
            console.error(
                `Config "panel[${i}].position" must be "top" or "bottom", got "${position}"`,
            )
            position = "top"
        }

        const checkWidgets = (names: string[]) =>
            names.filter(n => {
                if (PANEL_WIDGETS.includes(n)) return true
                console.error(`Config "panel[${i}]": unknown widget "${n}", skipping`)
                return false
            })

        // geometry falls back to the top-level keys, so a machine with
        // one floating panel and one docked one says so per panel, and
        // one with the same everywhere says it once
        const height = typeof entry.height === "number" && entry.height > 0 ? entry.height : null
        if (entry.height !== undefined && height === null)
            console.error(`Config "panel[${i}].height" must be a positive number`)

        return {
            monitors: strList(entry.monitors, []),
            position: position as "top" | "bottom",
            class: typeof entry.class === "string" ? entry.class : "",
            height: height ?? barHeight,
            floating: typeof entry.floating === "boolean" ? entry.floating : barFloating,
            left: checkWidgets(strList(entry.left, ["osicon", "workspaces"])),
            center: checkWidgets(strList(entry.center, ["clock"])),
            right: checkWidgets(
                strList(entry.right, [
                    "stats",
                    "tray",
                    "quicksettings",
                    "language",
                    "notifications",
                ]),
            ),
        }
    })
}

/**
 * Where the pending-updates daemon (extra/pending-updates-daemon) writes
 * its package list. Never /tmp — a predictable world-writable path is a
 * symlink/planted-content hazard.
 *
 * Derived from instanceCacheDir rather than recomposing
 * GLib.get_user_cache_dir() again: two independent definitions of the
 * same path drift, and the one that drifts here monitors a file nothing
 * writes, with no error anywhere to say so.
 */
function pendingUpdatesPath(cacheDir: string): string {
    return `${cacheDir}/system_updates`
}

// the top-level keys that belong to no section
const topLevel = createReader(configData, "")

// Panel geometry. Read here rather than in the class body because
// `getPanelsConfig` needs them as its per-panel defaults, and a
// [[panel]] table is parsed before any static is assigned.
//
// The height is the widget strip's own; a floating panel's margin is
// ADDED to the window on top of it (src/widgets/bar/index.tsx), so
// detaching a panel never quietly shortens it. The same margin reaches
// scss through active-tuning.scss — one config key, two consumers, no
// second literal.
const barHeight = topLevel.num("bar_height", 30, { min: 1 })
const barFloating = topLevel.bool("bar_floating", false)
const barFloatMargin = topLevel.num("bar_float_margin", 6, { min: 0 })

export default class Config {
    // a truthy non-string (e.g. instance_name = 5) would poison the bus
    // name and every path derived from it
    static instanceName = topLevel.str("instance_name", "wam-shell", { nonEmpty: true })

    static instanceSrcDir = instanceSrcDir
    static osIcon = getOsIcon()
    static desktopSession = getDesktopSession()
    static updatesThreshold = topLevel.num("arch_updates_threshold", 50, { min: 0 })

    static swayGaps = topLevel.bool("sway_gaps", true)
    static swayGapsSizeDefault = 10

    static workspaces = getWorkspacesConfig()
    static tray = getTrayConfig()
    static quicksettings = getQSettingsConfig()
    static bluetooth = getBluetoothConfig()
    static media = getMediaConfig()
    static screenShare = getScreenShareConfig()
    static idleInhibit = getIdleInhibitConfig()
    static hyprsunset = getHyprsunsetConfig()
    static barMonitors = getBarMonitors()
    static barHeight = barHeight
    static barFloating = barFloating
    static barFloatMargin = barFloatMargin
    static panels = getPanelsConfig()
    static theme = resolveTheme(configData)
    static appearance = getAppearanceConfig()
    static osd = getOsdConfig()
    static notifications = getNotificationsConfig()
    static sleepTimer = getSleepTimerConfig()
    static netstats = getNetstatsConfig()
    static harvest = getHarvestConfig()
    static calendar = getCalendarConfig()
    static github = getGitHubConfig()
    static youtube = getYouTubeConfig()
    static todoist = getTodoistConfig()
    static protonmail = getProtonmailConfig()
    static instanceCacheDir = `${GLib.get_user_cache_dir()}/${this.instanceName}`
    // where the daemon writes, whether or not it exists yet: the widget
    // monitors this path, so a daemon that starts after the shell is
    // picked up rather than needing a restart
    static pendingUpdatesPath = pendingUpdatesPath(this.instanceCacheDir)
    static cacheFile = `${this.instanceCacheDir}/cache.json`

    static cssPath = `${this.instanceCacheDir}/style.css`
    static scssPath = `${this.instanceSrcDir}/scss/style.scss`
}

/**
 * Whether the updates widget should exist: is the pending-updates daemon
 * the thing producing that list?
 *
 * THREE states, and each one is load-bearing:
 *
 * - `null` — the probe has not answered. Render nothing. Seeding this
 *   from the file's existence instead meant a machine with a stale list
 *   and a stopped daemon built the widget, revealed a wrong count, and
 *   then tore it down when the probe landed: a wrong number flashing
 *   onto the bar at every login.
 * - `true` — show it. Note this does NOT require the file to exist yet.
 *   That is the whole point: the daemon and the shell start together and
 *   the daemon's first `checkupdates` takes seconds, so gating on the
 *   file meant the widget was never built, its file monitor never
 *   installed, and a machine with pending updates showed nothing for the
 *   entire session.
 * - `false` — a daemon that is genuinely not running. Its leftover list
 *   is stale and must not be advertised.
 */
const [pendingUpdates, setPendingUpdates] = createState<boolean | null>(null)
export { pendingUpdates }

/**
 * `systemctl is-active` exits non-zero for "inactive", so execAsync's
 * rejection covers two very different answers and we have to tell them
 * apart: it rejects with STDERR, which is empty when systemctl ran and
 * simply reported the unit down, and non-empty when systemctl itself
 * could not answer (no user bus, no service manager).
 *
 * That distinction matters because treating every rejection as "not
 * running" hides a working pill on any session without a systemd user
 * manager — a TTY/greeter exec, a container, or a list refreshed by cron
 * instead of the unit. When we cannot ask, the file on disk is the best
 * evidence there is, so trust it.
 */
function probeUpdatesDaemon() {
    let probe: Promise<string>
    try {
        probe = execAsync(["systemctl", "--user", "is-active", "pending-updates-daemon.service"])
    } catch (e) {
        // no systemctl at all: Gio.Subprocess.new throws rather than
        // rejecting, so this never reaches the .catch below
        setPendingUpdates(isFile(Config.pendingUpdatesPath))
        return
    }
    probe
        .then(() => setPendingUpdates(true))
        .catch((e: unknown) => {
            const stderr = String((e as { message?: string })?.message ?? "").trim()
            if (stderr === "") return setPendingUpdates(false) // answered: not running
            console.warn(`Updates: could not ask systemd (${stderr}); trusting the list on disk`)
            setPendingUpdates(isFile(Config.pendingUpdatesPath))
        })
}
probeUpdatesDaemon()

// Re-read the theme key from the config file so theme changes apply
// on reloadStyle without a restart.
export function reloadTheme(): string {
    const data = parseToml(readRawFile(findConfigFile()))
    Config.theme = resolveTheme(data)
    return Config.theme
}
