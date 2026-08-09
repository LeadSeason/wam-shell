import GLib from "gi://GLib?version=2.0"
import { createState } from "gnim"
import Config from "../config"
import { loadToken } from "./credentials"
import { configHome } from "./paths"
import { createJsonClient, USER_AGENT } from "./httpJson"
import { timeoutAddSeconds, sourceRemove } from "./metrics"
import { Provider, ProviderItem, registerProvider } from "./notificationProviders"
import { addProviderPopup } from "./notifd"
import { createSeenStore } from "./seenStore"
import {
    bannerCandidates,
    createRefreshGate,
    formatWait,
    isBackoffStatus,
    newArrivals,
    openUrl,
    retryAfterSeconds,
} from "./providerCore"
import { registerDispose } from "./lifecycle"

// re-exported so the unit suite can pin these against GitHub's own
// shapes; the implementations are shared (lib/providerCore)
export { newArrivals, bannerCandidates }

// GitHub notifications provider for the notification center (REST API).
// The unread inbox merges into the center's list: click opens the
// thread in the browser and marks it read, dismiss marks it done on
// GitHub. Re-polls are conditional (If-Modified-Since → 304), which
// GitHub does not charge against the rate limit. Read-only + thread
// state endpoints only; nothing here creates content.

const API = "https://api.github.com"
const MAX_PAGES = 3 // 150 threads is plenty for an unread inbox

// ---------------------------------------------------------- credentials

const envPath = `${configHome}/github.env`

const token = Config.github.enabled ? loadToken("GitHub", "GITHUB_TOKEN", envPath) : null
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
export function threadData(raw: any): Omit<ProviderItem, "dismiss" | "activate" | "hide"> | null {
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

// ---------------------------------------------------------------- http

// 304 counts as a successful poll: a conditional request answering
// "nothing changed" is the good case, and GitHub does not charge it
// against the rate limit
const request = createJsonClient({
    baseUrl: API,
    logTag: "GitHub",
    okStatuses: [304],
    headers: () => ({
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
    }),
})

// whether github threads may raise transient banners: the unified
// opt-in list in [notifications]
const popupsEnabled = () => Config.notifications.popupProviders.includes("github")

// ---------------------------------------------------------------- state

const [items, setItems] = createState<ProviderItem[]>([])
export { items }

let lastModified = ""
let pollInFlight = false
let authFailed = false
let pollTimer = 0
// Banners have to survive restarts. A per-process baseline (what this
// used to be) swallowed every thread that arrived while the shell was
// down, and between a 15-minute poll and a shell that restarts on
// updates or logout, that is nearly all of them — the provider filled
// the center and never once banged the screen. The memory is a
// persisted seen store instead (lib/seenStore, shared with YouTube):
// the first run ever absorbs the inbox silently, and after that any
// thread the store has not seen banners, as long as it is recent
// enough that an inbox healing after an outage cannot replay history
const seen = createSeenStore(`${Config.instanceCacheDir}/github-seen.json`, "GitHub")

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
            openUrl(data.url, "GitHub")
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
    const fresh = bannerCandidates(mapped, seen.ids(), Date.now() / 1000)
    // remember everything on screen, bannered or not: a thread that
    // aged out of the horizon must not banner if it is touched later
    seen.remember(mapped.map(i => i.id))
    if (seen.firstEverRun) {
        seen.firstEverRun = false
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
            // previous failed poll. A 304 is a SUCCESSFUL poll, so it
            // resets the backoff history too — otherwise a rate limit
            // followed by quiet 304s left the counter high and the next
            // 429 waited as if the limits had never stopped
            if (r.status === 304) {
                backoffs = 0
                gate.clearBackoff()
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
            // rate limited or overloaded: the server said how long to
            // stop for, and re-asking on schedule is what turns a short
            // limit into a long one
            if (isBackoffStatus(r.status)) {
                backoffs++
                const wait = retryAfterSeconds(r.header("Retry-After"), backoffs)
                gate.backOff(wait)
                setStatus(`GitHub is rate limiting — retrying in ${formatWait(wait)}`)
                console.warn(`GitHub: ${r.status}; backing off ${wait}s`)
                return // keep stale items
            }
            if (!r.ok || !Array.isArray(r.json)) {
                setStatus("Couldn't sync GitHub — retrying next poll")
                return // keep stale items
            }
            backoffs = 0
            gate.clearBackoff()
            setStatus(null)
            const modified = r.header("Last-Modified")
            if (modified) lastModified = modified
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
        page === 1 && lastModified ? { "If-Modified-Since": lastModified } : {},
    )
}

// consecutive 429/503s, for the doubling fallback when the server sends
// no Retry-After. Reset by the first clean poll
let backoffs = 0

export function poll() {
    if (!active || authFailed || pollInFlight) return
    // a backoff the SCHEDULED poll must respect too: gating only
    // refresh() would let the timer walk straight past it
    if (gate.blocked()) return
    pollInFlight = true
    gate.touch()
    fetchPage(1, [])
}

// stale-while-revalidate when the center opens; age-gated so fidgety
// toggling doesn't burn requests
const gate = createRefreshGate(60_000, poll)
export const refresh = gate.refresh

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

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("github", dispose)
