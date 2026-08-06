import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Soup from "gi://Soup?version=3.0"
import { createState } from "gnim"
import Config from "../config"
import { loadCredentials } from "./credentials"
import { timeoutAddSeconds, sourceRemove, trackHttp } from "./metrics"
import { Provider, ProviderItem, registerProvider } from "./notificationProviders"
import { addProviderPopup } from "./notifd"
import { writeFileAtomic } from "./atomicWrite"
import { isFile } from "./utils"

// GitHub notifications provider for the notification center (REST API).
// The unread inbox merges into the center's list: click opens the
// thread in the browser and marks it read, dismiss marks it done on
// GitHub. Re-polls are conditional (If-Modified-Since → 304), which
// GitHub does not charge against the rate limit. Read-only + thread
// state endpoints only; nothing here creates content.

const API = "https://api.github.com"
// GitHub 403s requests without a User-Agent
const UA = "wam-shell (https://github.com/LeadSeason/wam-shell)"
const MAX_PAGES = 3 // 150 threads is plenty for an unread inbox

// ---------------------------------------------------------- credentials

const configHome = `${GLib.getenv("XDG_CONFIG_HOME") || `${GLib.getenv("HOME")}/.config`}/wam-shell`
const envPath = `${configHome}/github.env`

function loadToken(): string | null {
    const creds = loadCredentials("GitHub", ["GITHUB_TOKEN"], envPath)
    return creds ? creds.GITHUB_TOKEN : null
}

const token = Config.github.enabled ? loadToken() : null
// the center gates on the registry; this gates the registry
export const active = Config.github.enabled && token !== null
if (Config.github.enabled && !token) {
    console.log(
        "GitHub: enabled but no token (env GITHUB_TOKEN or ~/.config/wam-shell/github.env); provider disabled",
    )
}

// ------------------------------------------------- pure mapping (tests)

const REASONS: Record<string, string> = {
    assign: "Assigned to you",
    author: "Authored",
    comment: "Commented",
    invitation: "Invitation",
    manual: "Manual",
    mention: "Mentioned",
    review_requested: "Review requested",
    security_alert: "Security alert",
    state_change: "State change",
    subscribed: "Subscribed",
    team_mention: "Team mention",
    ci_activity: "CI activity",
}

export function reasonLabel(reason: string): string {
    return REASONS[reason] ?? reason.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase())
}

// Reasons where a person (or a scanner) is waiting on you, as opposed to
// keeping you informed. The center lifts these out of the feed.
// "author" and "subscribed" are the loud ones and deliberately absent:
// every comment on your own PR carries reason "author", so treating it
// as actionable would leave the zone permanently full and useless.
const ACTIONABLE_REASONS = new Set([
    "assign",
    "invitation",
    "mention",
    "review_requested",
    "security_alert",
    "team_mention",
])

export function isActionableReason(reason: string): boolean {
    return ACTIONABLE_REASONS.has(reason)
}

const TYPES: Record<string, string> = {
    PullRequest: "Pull request",
    Issue: "Issue",
    Release: "Release",
    Commit: "Commit",
    Discussion: "Discussion",
    RepositoryInvitation: "Repository invitation",
    CheckSuite: "Check suite",
    RepositoryVulnerabilityAlert: "Vulnerability alert",
}

export function typeLabel(type: string): string {
    return TYPES[type] ?? type
}

// subject.url is an API URL; the browser wants the web one. The repo
// path maps 1:1 once "api." and "/repos" are dropped (issues, pulls,
// commits); anything unusual falls back to the repository page
export function webUrl(subjectUrl: string | null, repoHtmlUrl: string): string {
    if (!subjectUrl) return repoHtmlUrl
    const mapped = subjectUrl.replace("https://api.github.com/repos/", "https://github.com/")
    return mapped !== subjectUrl && mapped.startsWith("https://github.com/") ? mapped : repoHtmlUrl
}

// the data half of a ProviderItem; actions are attached by the module
// (they close over the poll state). null = unusable thread shape
export function threadData(raw: any): Omit<ProviderItem, "dismiss" | "activate"> | null {
    const id = raw?.id
    const repo = raw?.repository?.full_name
    const title = raw?.subject?.title
    const updated = Date.parse(raw?.updated_at ?? "")
    if (!id || !repo || !title || Number.isNaN(updated)) return null
    return {
        id: `github:${id}`,
        provider: "github",
        time: updated / 1000,
        appName: repo,
        summary: title,
        body: `${reasonLabel(raw.reason ?? "")} · ${typeLabel(raw.subject?.type ?? "")}`,
        iconName: "github-symbolic",
        actionable: isActionableReason(raw.reason ?? ""),
        url: webUrl(
            raw.subject?.url ?? null,
            raw.repository?.html_url ?? "https://github.com/notifications",
        ),
    }
}

// ids in next but not in prev. Brand-new threads only: new activity on
// an already-unread thread keeps its id and stays quiet
export function newArrivals(prev: { id: string }[], next: { id: string }[]): string[] {
    const prevIds = new Set(prev.map(i => i.id))
    return next.filter(i => !prevIds.has(i.id)).map(i => i.id)
}

const BANNER_HORIZON_SEC = 48 * 3600

/** threads the seen store has never carried, still inside the banner
 *  horizon. The horizon is what keeps a healing inbox quiet: threads
 *  that resurface after an outage (or a token finally working again)
 *  are old, and old threads never banner */
export function bannerCandidates<T extends { id: string; time: number }>(
    next: T[],
    seenIds: Set<string>,
    nowSec: number,
    horizonSec = BANNER_HORIZON_SEC,
): T[] {
    return next.filter(i => !seenIds.has(i.id) && i.time >= nowSec - horizonSec)
}

// ---------------------------------------------------------------- http

const session = new Soup.Session({ timeout: 20 })

interface Reply {
    ok: boolean // 2xx (or 304 when allowed)
    status: number
    json: any
    lastModified: string
}

// never log anything beyond method + path + status: the token is a secret
function request(method: string, path: string, cb: (r: Reply) => void, ifModifiedSince = "") {
    const url = `${API}${path}`
    const msg = Soup.Message.new(method, url)
    if (!msg) {
        cb({ ok: false, status: 0, json: null, lastModified: "" })
        return
    }
    const h = msg.get_request_headers()
    h.append("Authorization", `Bearer ${token}`)
    h.append("Accept", "application/vnd.github+json")
    h.append("X-GitHub-Api-Version", "2022-11-28")
    h.append("User-Agent", UA)
    if (ifModifiedSince) h.append("If-Modified-Since", ifModifiedSince)
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_s, res) => {
        let reply: Reply
        try {
            const bytes = session.send_and_read_finish(res)
            if (bytes) trackHttp(url, bytes.get_size())
            const text = bytes ? new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()) : ""
            let json: any = null
            try {
                json = text ? JSON.parse(text) : null
            } catch {}
            const status = msg.get_status()
            reply = {
                ok: (status >= 200 && status < 300) || status === 304,
                status,
                json,
                lastModified: msg.get_response_headers().get_one("Last-Modified") ?? "",
            }
        } catch (e) {
            reply = { ok: false, status: 0, json: null, lastModified: "" }
        }
        if (!reply.ok)
            console.warn(
                `GitHub: ${method} ${path.split("?")[0]} -> ${reply.status || "network error"}`,
            )
        cb(reply)
    })
}

// whether github threads may raise transient banners: the unified
// opt-in list in [notifications]
const popupsEnabled = () => Config.notifications.popupProviders.includes("github")

// ---------------------------------------------------------------- state

const [items, setItems] = createState<ProviderItem[]>([])
export { items }

let lastModified = ""
let pollInFlight = false
let lastPollAttempt = 0
let authFailed = false
let pollTimer = 0
// stays false until the first successful fetch lands: that fetch is the
// baseline and never banners
// Banners have to survive restarts. A per-process baseline (what this
// used to be) swallowed every thread that arrived while the shell was
// down, and between a 15-minute poll and a shell that restarts on
// updates or logout, that is nearly all of them — the provider filled
// the center and never once banged the screen. The memory is a
// persisted seen store instead (same shape as youtube's, cap 200):
// the first run ever absorbs the inbox silently, and after that any
// thread the store has not seen banners, as long as it is recent
// enough that an inbox healing after an outage cannot replay history
const seenPath = `${Config.instanceCacheDir}/github-seen.json`
const seen = new Set<string>()
// no store on disk = never ran before: absorb, don't banner
let firstEverRun = true

function loadSeen() {
    if (!isFile(seenPath)) return
    firstEverRun = false
    try {
        const data = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(seenPath)[1]))
        if (Array.isArray(data?.seen)) for (const id of data.seen) seen.add(String(id))
    } catch (e) {
        console.warn("GitHub: failed reading seen store:", e)
    }
}
loadSeen()

function remember(ids: string[]) {
    for (const id of ids) seen.add(id)
    try {
        GLib.mkdir_with_parents(Config.instanceCacheDir, 0o755)
    } catch (e) {
        console.warn("GitHub: failed writing seen store:", e)
        return
    }
    writeFileAtomic(seenPath, JSON.stringify({ seen: [...seen].slice(-200) })).catch(e =>
        console.warn("GitHub: failed writing seen store:", e),
    )
}

// locally hidden threads (right-click "dismiss"): session-only, no
// service call — filtered out of every poll so they don't reappear
// before the shell restarts
const hiddenIds = new Set<string>()

function attachActions(data: Omit<ProviderItem, "dismiss" | "activate" | "hide">): ProviderItem {
    return {
        ...data,
        hide: () => {
            hiddenIds.add(data.id)
            setItems(items.get().filter(i => i.id !== data.id))
        },
        dismiss: () => mutate(data, "DELETE"),
        activate: () => {
            Gio.AppInfo.launch_default_for_uri_async(data.url, null, null, (_s, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res)
                } catch (e) {
                    console.warn("GitHub: could not open the browser:", e)
                }
            })
            mutate(data, "PATCH")
        },
    }
}

// mark done (DELETE) or read (PATCH); both leave the unread inbox, so a
// successful mutation removes the item locally instead of waiting for
// the next poll. Server-side idempotent: a double click is harmless
function mutate(data: Omit<ProviderItem, "dismiss" | "activate" | "hide">, method: string) {
    const threadId = data.id.slice("github:".length)
    request(method, `/notifications/threads/${threadId}`, r => {
        if (r.ok) setItems(items.get().filter(i => i.id !== data.id))
        else console.warn(`GitHub: thread ${method} failed (status ${r.status})`)
    })
}

function applyThreads(rawList: any[]) {
    const mapped: ProviderItem[] = []
    for (const raw of rawList) {
        const data = threadData(raw)
        if (data && !hiddenIds.has(data.id)) mapped.push(attachActions(data))
    }
    // newest first, same as the center's desktop list
    mapped.sort((a, b) => b.time - a.time)
    setItems(mapped)
    const fresh = bannerCandidates(mapped, seen, Date.now() / 1000)
    // remember everything on screen, bannered or not: a thread that
    // aged out of the horizon must not banner if it is touched later
    remember(mapped.map(i => i.id))
    if (firstEverRun) {
        firstEverRun = false
        return
    }
    if (!popupsEnabled()) return
    for (const item of fresh) addProviderPopup(item)
}

// surfaced in the center's empty state while unhealthy
const [status, setStatus] = createState<string | null>(null)

function fetchPage(page: number, acc: any[]) {
    request(
        "GET",
        `/notifications?per_page=50&page=${page}`,
        r => {
            pollInFlight = false
            // unchanged; keep current items, and clear any error from a
            // previous failed poll
            if (r.status === 304) {
                setStatus(null)
                return
            }
            if (r.status === 401) {
                authFailed = true
                setStatus("GitHub token rejected — check ~/.config/wam-shell/github.env")
                if (pollTimer) {
                    sourceRemove(pollTimer)
                    pollTimer = 0
                }
                console.warn(
                    "GitHub: token rejected (401); provider disabled until the shell restarts",
                )
                return
            }
            if (!r.ok || !Array.isArray(r.json)) {
                setStatus("Couldn't sync GitHub — retrying next poll")
                return // keep stale items
            }
            setStatus(null)
            if (r.lastModified) lastModified = r.lastModified
            const merged = acc.concat(r.json)
            // GitHub paginates at 50; a full page means there may be more
            if (r.json.length === 50 && page < MAX_PAGES) {
                pollInFlight = true
                fetchPage(page + 1, merged)
                return
            }
            applyThreads(merged)
        },
        // only the first page is conditional: a 304 means nothing
        // changed anywhere in the inbox
        page === 1 ? lastModified : "",
    )
}

export function poll() {
    if (!active || authFailed || pollInFlight) return
    pollInFlight = true
    lastPollAttempt = Date.now()
    fetchPage(1, [])
}

// stale-while-revalidate when the center opens; age-gated so fidgety
// toggling doesn't burn requests
export function refresh() {
    if (Date.now() - lastPollAttempt < 60_000) return
    poll()
}

export function dispose() {
    if (pollTimer) {
        sourceRemove(pollTimer)
        pollTimer = 0
    }
}

// -------------------------------------------------------------- startup

// registry presence must not depend on network: the provider registers
// at import (the center reads it whenever its lazy window is built),
// network only starts in init() from app.tsx. Enabled-but-unconfigured
// registers too — the center shows setupHint when its filter is picked
if (Config.github.enabled) {
    registerProvider({
        name: "github",
        iconName: "github-symbolic",
        displayName: "GitHub",
        items,
        refresh,
        dispose,
        status,
        setupHint: active
            ? null
            : "GitHub needs a token: create a personal access token (notifications scope) at github.com/settings/tokens and put it in ~/.config/wam-shell/github.env as GITHUB_TOKEN=<token>",
    } satisfies Provider)
}

export function init() {
    if (!active) return
    poll()
    pollTimer = timeoutAddSeconds(
        "github:poll",
        GLib.PRIORITY_DEFAULT,
        Config.github.pollMinutes * 60,
        () => {
            poll()
            return GLib.SOURCE_CONTINUE
        },
    )
}
