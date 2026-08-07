import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Soup from "gi://Soup?version=3.0"
import { createState } from "gnim"
import Config from "../config"
import { isFile } from "./utils"
import { writeFileAtomic } from "./atomicWrite"
import { timeoutAdd, timeoutAddSeconds, sourceRemove, trackHttp } from "./metrics"
import { Provider, ProviderItem, registerProvider } from "./notificationProviders"
import { GoogleAccount, Reply, createGoogleAuth, googleRequest } from "./googleAuth"
import { addProviderPopup } from "./notifd"

// YouTube notifications provider: new uploads from the user's
// subscriptions. YouTube has no bell-notifications endpoint, and the
// activities "home feed" is empty for many accounts (verified), so the
// provider walks each subscribed channel's uploads playlist:
//   subscriptions.list (paginated) -> channels.list (batched, cached
//   24h) -> playlistItems.list per channel per poll. Each poll costs
//   ~1 quota unit per subscription (~6.6k/10k daily for ~275 subs
//   hourly); the effective interval is raised when the count would
//   exceed the quota. Read-only scope, one sign-in per Google account
//   via the shared Google OAuth stack. YouTube has no read/done state
//   either, so dismissing is LOCAL only: seen ids persist across
//   restarts, which is also what keeps banners from replaying.

const API = "https://www.googleapis.com/youtube/v3"
// how fresh the channel list must be before re-discovery
const CHANNELS_TTL_MS = 24 * 3_600_000
const MAX_SUB_PAGES = 10 // 500 subscriptions is plenty
const SWEEP_CONCURRENCY = 8 // 275 channels in flight would churn sockets
const QUOTA_PER_DAY = 9500 // leave headroom under the 10k default

const configHome = `${GLib.getenv("XDG_CONFIG_HOME") || `${GLib.getenv("HOME")}/.config`}/wam-shell`
const seenPath = `${Config.instanceCacheDir}/youtube-seen.json`
const channelsPath = `${Config.instanceCacheDir}/youtube-channels.json`
const thumbsDir = `${Config.instanceCacheDir}/youtube-thumbs`

const auth = createGoogleAuth({
    scope: "https://www.googleapis.com/auth/youtube.readonly",
    tokensPath: `${configHome}/youtube-tokens.json`,
    logTag: "YouTube",
    enabled: Config.youtube.enabled,
    // the channel's own title is the identity label (no extra scope)
    identify: (accessToken, cb) => {
        googleRequest(
            "GET",
            `${API}/channels?part=snippet&mine=true`,
            { bearer: accessToken },
            r => {
                if (!r.ok || !Array.isArray(r.json?.items) || r.json.items.length === 0)
                    return cb(null)
                cb(r.json.items[0].snippet?.title ?? null)
            },
        )
    },
})
export const active = auth.active

// ------------------------------------------------- pure mapping (tests)

interface YtChannel {
    id: string
    title: string
    uploads: string // the channel's uploads playlist id
}

// one playlistItems entry -> provider item data. The video id is the
// natural unique id: it dedupes the same upload across accounts. A
// channel's "latest 3 uploads" can be years old for quiet channels —
// list and banners bound themselves by time instead (below)
export function playlistVideoData(raw: any):
    | (Omit<ProviderItem, "dismiss" | "activate" | "hide"> & {
          imageUrl: string | null
          videoId: string
      })
    | null {
    const s = raw?.snippet
    const videoId = s?.resourceId?.videoId
    const title = s?.title
    const channel = s?.channelTitle
    const published = Date.parse(s?.publishedAt ?? "")
    if (!videoId || !title || !channel || Number.isNaN(published)) return null
    if (!/^[A-Za-z0-9_-]+$/.test(videoId)) return null // also the thumb filename
    return {
        id: `youtube:${videoId}`,
        provider: "youtube",
        time: published / 1000,
        appName: channel,
        // channel is the primary line, the title wraps beneath it
        summary: channel,
        body: title,
        iconName: "youtube-symbolic",
        url: `https://www.youtube.com/watch?v=${videoId}`,
        imageUrl:
            s?.thumbnails?.standard?.url ??
            s?.thumbnails?.high?.url ??
            s?.thumbnails?.medium?.url ??
            s?.thumbnails?.default?.url ??
            null,
        videoId,
    }
}

// ids in next but neither in prev nor in the seen store — and
// published within the banner horizon. The horizon is what makes
// banners safe: a quiet channel's years-old backlog entering the list
// (first sweep, a partial failure healing) is never a banner
const BANNER_HORIZON_SEC = 48 * 3600

export function bannerCandidates(
    prev: { id: string }[],
    next: { id: string; time: number }[],
    seen: Set<string>,
    nowSec: number,
): string[] {
    const prevIds = new Set(prev.map(i => i.id))
    return next
        .filter(i => !prevIds.has(i.id) && !seen.has(i.id))
        .filter(i => i.time >= nowSec - BANNER_HORIZON_SEC)
        .map(i => i.id)
}

// the center is a notification list, not a subscriptions digest: a
// quiet channel's ancient "latest upload" is not a notification
const LIST_HORIZON_SEC = 30 * 86_400

// ---------------------------------------------------------------- state

const [items, setItems] = createState<ProviderItem[]>([])
export { items }

// id -> account email: needed to drop a removed account's rows
const itemAccounts = new Map<string, string>()

// dismissed/activated ids, persisted (cap 200) so restarts neither
// resurface rows nor replay banners
const seen = new Set<string>()
// right-click "dismiss": session-only hide, no persistence — filtered
// out of sweeps so it doesn't reappear before the shell restarts
const sessionHidden = new Set<string>()

function loadSeen() {
    if (!isFile(seenPath)) return
    try {
        const contents = GLib.file_get_contents(seenPath)[1]
        const data = JSON.parse(new TextDecoder().decode(contents))
        if (Array.isArray(data?.seen)) for (const id of data.seen) seen.add(String(id))
    } catch (e) {
        console.warn("YouTube: failed reading seen store:", e)
    }
}

function storeSeen() {
    writeFileAtomic(seenPath, JSON.stringify({ seen: [...seen].slice(-200) })).catch(e =>
        console.warn("YouTube: failed writing seen store:", e),
    )
}

function markSeen(id: string) {
    if (seen.has(id)) return
    seen.add(id)
    storeSeen()
    itemAccounts.delete(id)
    setItems(items.get().filter(i => i.id !== id))
}

// ------------------------------------------------------- channel cache

// account email -> channels with uploads playlists; refreshed daily
let channelsByAccount = new Map<string, YtChannel[]>()
let channelsFetchedAt = 0

function loadChannelsCache() {
    if (!isFile(channelsPath)) return
    try {
        const contents = GLib.file_get_contents(channelsPath)[1]
        const data = JSON.parse(new TextDecoder().decode(contents))
        channelsFetchedAt = Number(data?.fetchedAt) || 0
        for (const [email, chs] of Object.entries(data?.byAccount ?? {})) {
            if (Array.isArray(chs)) channelsByAccount.set(email, chs as YtChannel[])
        }
    } catch (e) {
        console.warn("YouTube: failed reading channel cache:", e)
    }
}

function storeChannelsCache() {
    writeFileAtomic(
        channelsPath,
        JSON.stringify({
            fetchedAt: channelsFetchedAt,
            byAccount: Object.fromEntries(channelsByAccount),
        }),
    ).catch(e => console.warn("YouTube: failed writing channel cache:", e))
}

function channelsStale(): boolean {
    return channelsByAccount.size === 0 || Date.now() - channelsFetchedAt > CHANNELS_TTL_MS
}

// ------------------------------------------------------------ thumbnails

const thumbSession = new Soup.Session({ timeout: 15 })

function thumbPath(videoId: string): string {
    return `${thumbsDir}/${videoId}.jpg`
}

// Thumbnails are keyed by video id and nothing ever revisits them: a
// video leaves the displayed list within days and its file stays
// forever. Left alone this was the shell's only unbounded on-disk
// growth — a few hundred subscriptions swept hourly, ~30-80 KB apiece.
// `wam update --force` does not help either, and must not: the cache
// dir's other tenants are state, not artefacts.
//
// So the same one-shot TTL sweep coverArt.ts does, for the same reason.
// A month is generous next to LIST_HORIZON_SEC (30 days, the point past
// which an upload stops being listable at all) — anything older than
// that cannot be on screen, and a re-listed video simply re-downloads.
const THUMB_TTL_SEC = 30 * 86_400

// Batched, and async all the way down. enumerate_children_async only
// defers opening the directory — a next_file() loop after it still stats
// every entry and unlinks synchronously, on the main loop, at startup.
// That is worst exactly where this sweep matters: the multi-thousand-file
// cache it exists to bound. next_files_async yields between batches, so
// a large prune costs frames nobody sees instead of one long stall.
const THUMB_PRUNE_BATCH = 64

function pruneThumbs() {
    const dir = Gio.File.new_for_path(thumbsDir)
    dir.enumerate_children_async(
        "standard::name,time::modified",
        Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_LOW,
        null,
        (_d, res) => {
            let iter: Gio.FileEnumerator
            try {
                iter = dir.enumerate_children_finish(res)
            } catch {
                return // no thumbs dir yet: nothing to prune
            }
            const cutoff = GLib.get_real_time() / 1_000_000 - THUMB_TTL_SEC
            let removed = 0
            const step = () => {
                iter.next_files_async(THUMB_PRUNE_BATCH, GLib.PRIORITY_LOW, null, (_i, r) => {
                    let batch: Gio.FileInfo[]
                    try {
                        batch = iter.next_files_finish(r)
                    } catch (e) {
                        console.warn("YouTube: thumbnail prune failed:", e)
                        return
                    }
                    if (batch.length === 0) {
                        iter.close_async(GLib.PRIORITY_LOW, null, null)
                        if (removed > 0) console.log(`YouTube: pruned ${removed} stale thumbnail(s)`)
                        return
                    }
                    for (const info of batch) {
                        if (info.get_attribute_uint64("time::modified") > cutoff) continue
                        if (GLib.unlink(`${thumbsDir}/${info.get_name()}`) === 0) removed++
                    }
                    step()
                })
            }
            step()
        },
    )
}

// binary fetch (the shared googleRequest is JSON-shaped); best-effort
function fetchThumb(videoId: string, url: string, done: () => void) {
    const path = thumbPath(videoId)
    if (isFile(path)) return done()
    const msg = Soup.Message.new("GET", url)
    if (!msg) return done()
    thumbSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_s, res) => {
        try {
            const bytes = thumbSession.send_and_read_finish(res)
            if (msg.get_status() === 200 && bytes) {
                trackHttp(url, bytes.get_size())
                // done waits for the write to land: the caller isFile-
                // checks the thumb before pointing the row at it
                writeFileAtomic(path, bytes.get_data() ?? new Uint8Array()).then(done, done)
                return
            }
        } catch {} // a missing thumb is not a failure worth logging
        done()
    })
}

// ---------------------------------------------------------------- http

// bounded fan-out over async tasks; allDone fires once even for an
// empty list
function runPool<T>(
    list: T[],
    limit: number,
    work: (item: T, done: () => void) => void,
    allDone: () => void,
) {
    let i = 0
    let inFlight = 0
    let finished = false
    const kick = () => {
        if (finished) return
        while (inFlight < limit && i < list.length) {
            const item = list[i++]
            inFlight++
            work(item, () => {
                inFlight--
                kick()
            })
        }
        if (i >= list.length && inFlight === 0) {
            finished = true
            allDone()
        }
    }
    kick()
}

// -------------------------------------------------- channel discovery

// quietStatuses: statuses that mean "absence, not failure" for this
// call (404 = dead uploads playlist, 403 per-channel = summarized
// later) — never logged individually
function apiGet(
    account: GoogleAccount,
    path: string,
    cb: (r: Reply) => void,
    quietStatuses: number[] = [],
) {
    auth.ensureAccessToken(account, token => {
        if (!token) return cb({ ok: false, status: 401, json: null })
        googleRequest("GET", `${API}${path}`, { bearer: token }, r => {
            if (!r.ok && !quietStatuses.includes(r.status)) {
                console.warn(
                    `YouTube: GET ${API}${path.split("?")[0]} -> ${r.status || "network error"}`,
                )
            }
            cb(r)
        })
    })
}

// subscriptions -> [{id, title}] (paginated)
function fetchSubscriptions(
    account: GoogleAccount,
    pageToken: string,
    acc: any[],
    cb: (subs: any[] | null) => void,
    page = 0,
) {
    if (page >= MAX_SUB_PAGES) return cb(acc)
    const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""
    apiGet(account, `/subscriptions?part=snippet&mine=true&maxResults=50${tokenParam}`, r => {
        if (!r.ok || !r.json) return cb(r.ok ? acc : null)
        const items = acc.concat(r.json.items ?? [])
        const next: string | null = r.json.nextPageToken ?? null
        if (next) fetchSubscriptions(account, next, items, cb, page + 1)
        else cb(items)
    })
}

// ids -> uploads playlist ids (batched 50 ids per channels.list call)
function discoverChannels(account: GoogleAccount, cb: (ok: boolean) => void) {
    fetchSubscriptions(account, "", [], subs => {
        if (!subs) return cb(false)
        const entries: [string, string][] = subs
            .map((s: any) => [s.snippet?.resourceId?.channelId, s.snippet?.title])
            .filter((e): e is [string, string] => !!e[0] && !!e[1])
        const groups: string[][] = []
        for (let i = 0; i < entries.length; i += 50)
            groups.push(entries.slice(i, i + 50).map(e => e[0]))
        const titleOf = new Map(entries)
        const out: YtChannel[] = []
        runPool(
            groups,
            4,
            (ids, done) => {
                const idParam = ids.map(encodeURIComponent).join(",")
                apiGet(account, `/channels?part=contentDetails&id=${idParam}&maxResults=50`, r => {
                    // a failed group degrades to fewer channels, not a
                    // failed discovery
                    for (const c of r.json?.items ?? []) {
                        const uploads = c.contentDetails?.relatedPlaylists?.uploads
                        if (uploads) {
                            out.push({
                                id: c.id,
                                title: titleOf.get(c.id) ?? c.id,
                                uploads,
                            })
                        }
                    }
                    done()
                })
            },
            () => {
                channelsByAccount.set(account.email, out)
                channelsFetchedAt = Date.now()
                storeChannelsCache()
                console.log(`YouTube: ${account.email}: ${out.length} channels discovered`)
                cb(true)
            },
        )
    })
}

// ---------------------------------------------------------------- poll

let pollInFlight = false
let lastPollAttempt = 0
let pollTimer = 0
// stays false until the first successful sweep lands: that sweep is
// the baseline and never banners
let baselineDone = false

// id -> thumbnail source: fetching is deferred until the item makes
// the displayed list (a sweep maps ~800 videos, ~50 show)
const thumbInfo = new Map<string, { videoId: string; imageUrl: string }>()

function attachActions(
    data: Omit<ProviderItem, "dismiss" | "activate" | "hide"> & {
        imageUrl: string | null
        videoId: string
    },
    account: string,
): ProviderItem {
    const { imageUrl, videoId, ...rest } = data
    const item: ProviderItem = {
        ...rest,
        hide: () => {
            sessionHidden.add(data.id)
            itemAccounts.delete(data.id)
            setItems(items.get().filter(i => i.id !== data.id))
        },
        dismiss: () => markSeen(data.id),
        activate: () => {
            Gio.AppInfo.launch_default_for_uri_async(data.url, null, null, (_s, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res)
                } catch (e) {
                    console.warn("YouTube: could not open the browser:", e)
                }
            })
            markSeen(data.id)
        },
    }
    itemAccounts.set(item.id, account)
    if (imageUrl) {
        thumbInfo.set(item.id, { videoId, imageUrl })
        // cache hit: the row is born with its thumbnail (a late fetch
        // lands via fetchDisplayedThumbs + the center's key change)
        if (isFile(thumbPath(videoId))) item.imagePath = thumbPath(videoId)
    }
    return item
}

// fetch thumbnails for the items that made the list. imagePath points
// at the cache file only once it exists, so the card never tries to
// render a partial download
let thumbFlush = 0
function fetchDisplayedThumbs() {
    for (const item of items.get()) {
        const info = thumbInfo.get(item.id)
        if (!info || item.imagePath) continue
        fetchThumb(info.videoId, info.imageUrl, () => {
            if (!isFile(thumbPath(info.videoId))) return
            item.imagePath = thumbPath(info.videoId)
            // one state write per burst, not per completed download:
            // every write re-runs the center's merged list over all
            // providers (up to ~50 recomputes for a fresh sweep)
            if (thumbFlush) return
            thumbFlush = timeoutAdd("youtube:thumbFlush", GLib.PRIORITY_DEFAULT, 150, () => {
                thumbFlush = 0
                setItems([...items.get()])
                return GLib.SOURCE_REMOVE
            })
        })
    }
}

// every subscribed channel's latest uploads, merged
function sweepAccount(account: GoogleAccount, cb: (videos: ProviderItem[] | null) => void) {
    const chs = channelsByAccount.get(account.email) ?? []
    const out: ProviderItem[] = []
    let anyFailure = false
    let failures = 0
    let lastFailStatus = 0
    runPool(
        chs,
        SWEEP_CONCURRENCY,
        (ch, done) => {
            apiGet(
                account,
                `/playlistItems?part=snippet&playlistId=${encodeURIComponent(ch.uploads)}&maxResults=3`,
                r => {
                    if (r.status === 404) {
                        // the uploads playlist is gone (deleted/private
                        // channel): an absence, not a sweep failure —
                        // and not worth an hourly log line
                    } else if (!r.ok) {
                        // summarized once at sweep end: hundreds of
                        // identical warnings (e.g. a quota day) are spam
                        anyFailure = true
                        failures++
                        lastFailStatus = r.status
                    } else {
                        for (const raw of r.json?.items ?? []) {
                            const data = playlistVideoData(raw)
                            if (
                                data &&
                                data.time >= Date.now() / 1000 - LIST_HORIZON_SEC &&
                                !seen.has(data.id) &&
                                !sessionHidden.has(data.id)
                            )
                                out.push(attachActions(data, account.email))
                        }
                    }
                    done()
                },
                // silence per-channel failures; the summary reports them
                [403, 404],
            )
        },
        () => {
            if (failures > 0) {
                lastHttp = lastFailStatus
                console.warn(
                    `YouTube: ${account.email}: ${failures}/${chs.length} channel fetches failed (last status ${lastFailStatus || "network"})`,
                )
            }
            cb(out.length > 0 || !anyFailure ? out : null)
        },
    )
}

// consecutive sweeps where every account failed; drives the backoff in
// effectivePollMinutes. Reset by any successful channel fetch
let failStreak = 0
// the last sweep's failing HTTP status (0 = network error), shown in
// the center's status line as a debugging hint
let lastHttp = 0
// surfaced in the center's empty state while unhealthy
const [status, setStatus] = createState<string | null>(null)

function effectivePollMinutes(): number {
    const channels = [...channelsByAccount.values()].reduce((n, c) => n + c.length, 0)
    if (channels === 0) return Config.youtube.pollMinutes
    // each sweep costs ~1 unit per channel; keep the daily total under
    // the quota headroom: polls/day = 1440/minutes, so
    // minutes >= channels * 1440 / QUOTA_PER_DAY
    const floor = Math.ceil((channels * 1440) / QUOTA_PER_DAY)
    // consecutive total failures (quota day, outage): back off instead
    // of hammering — 1h, 2h, 4h, capped at 8h
    const backoff = Math.min(Config.youtube.pollMinutes * 2 ** failStreak, 8 * 60)
    return Math.max(Config.youtube.pollMinutes, floor, failStreak > 0 ? backoff : 0)
}

function scheduleNext() {
    if (pollTimer) sourceRemove(pollTimer)
    const minutes = effectivePollMinutes()
    if (minutes > Config.youtube.pollMinutes) {
        const channels = [...channelsByAccount.values()].reduce((n, c) => n + c.length, 0)
        console.log(
            `YouTube: next poll in ${minutes}m (${channels} channels, consecutive failed sweeps: ${failStreak})`,
        )
    }
    pollTimer = timeoutAddSeconds("youtube:poll", GLib.PRIORITY_DEFAULT, minutes * 60, () => {
        pollTimer = 0
        poll()
        return GLib.SOURCE_REMOVE
    })
}

export function poll() {
    if (!active || pollInFlight) return
    const accounts = auth.getAccounts()
    // signed out: the chain stops here (no timer at all) — the first
    // sign-in restarts it via onAccountAdded
    if (accounts.length === 0) return
    pollInFlight = true
    lastPollAttempt = Date.now()
    const startSweep = () => {
        const prev = items.get()
        const merged: ProviderItem[] = []
        const seenIds = new Set<string>()
        let pending = accounts.length
        let failedAccounts = 0
        const onAccountDone = (
            account: (typeof accounts)[number],
            videos: ProviderItem[] | null,
        ) => {
            // a totally failed sweep keeps that account's previous
            // rows (transient errors must not blank the center);
            // a successful one is authoritative, even when smaller
            if (videos === null) failedAccounts++
            for (const v of videos ?? prev.filter(p => itemAccounts.get(p.id) === account.email)) {
                if (seenIds.has(v.id)) continue
                seenIds.add(v.id)
                merged.push(v)
            }
            if (--pending > 0) return
            // quota day / outage: every account failed -> lengthen
            // the next interval (1h, 2h, 4h, cap 8h); any success
            // resets
            failStreak = failedAccounts === accounts.length ? failStreak + 1 : 0
            setStatus(
                failStreak > 0
                    ? `Couldn't sync YouTube (HTTP ${lastHttp || "network error"}) — retrying in ${effectivePollMinutes()}m`
                    : null,
            )
            merged.sort((a, b) => b.time - a.time)
            // prune the session maps to the surviving ids: a sweep maps
            // ~800 videos but only ~50 are displayed
            const shown = merged.slice(0, 50)
            const keep = new Set(shown.map(i => i.id))
            for (const id of itemAccounts.keys()) if (!keep.has(id)) itemAccounts.delete(id)
            for (const id of thumbInfo.keys()) if (!keep.has(id)) thumbInfo.delete(id)
            setItems(shown)
            fetchDisplayedThumbs()
            pollInFlight = false
            scheduleNext()
            if (!baselineDone) {
                baselineDone = true
                return
            }
            if (!Config.notifications.popupProviders.includes("youtube")) return
            for (const id of bannerCandidates(prev, merged, seen, Date.now() / 1000)) {
                const item = merged.find(i => i.id === id)
                if (item) addProviderPopup(item)
            }
        }
        for (const account of accounts) {
            // discovery failed with no cache for this account: its sweep
            // can't run — treat it as a failed account, not an
            // authoritative empty success (an outage would look healthy)
            if (failedDiscovery.has(account.email)) onAccountDone(account, null)
            else sweepAccount(account, videos => onAccountDone(account, videos))
        }
    }
    const failedDiscovery = new Set<string>()
    if (channelsStale()) {
        let pending = accounts.length
        for (const account of accounts) {
            discoverChannels(account, ok => {
                if (!ok && (channelsByAccount.get(account.email)?.length ?? 0) === 0)
                    failedDiscovery.add(account.email)
                if (--pending === 0) startSweep()
            })
        }
    } else {
        startSweep()
    }
}

// stale-while-revalidate when the center opens; age-gated hard: a
// sweep costs ~1 unit per subscription
export function refresh() {
    if (Date.now() - lastPollAttempt < 600_000) return
    poll()
}

export function dispose() {
    if (pollTimer) {
        sourceRemove(pollTimer)
        pollTimer = 0
    }
    if (thumbFlush) {
        sourceRemove(thumbFlush)
        thumbFlush = 0
    }
    auth.dispose()
}

// -------------------------------------------------------------- startup

auth.onAccountRemoved(email => {
    // filter first (the map still knows the account), then drop the
    // mapping — otherwise a failed sweep's keep-stale branch
    // resurrects the removed account's rows
    setItems(items.get().filter(i => itemAccounts.get(i.id) !== email))
    for (const [id, acc] of itemAccounts) if (acc === email) itemAccounts.delete(id)
    channelsByAccount.delete(email)
})

// registry presence must not depend on network: the provider registers
// at import, network only starts in init() from app.tsx
if (active) {
    registerProvider({
        name: "youtube",
        iconName: "youtube-symbolic",
        displayName: "YouTube",
        items,
        refresh,
        dispose,
        status,
        signIn: () => auth.authenticate(),
        signInVisible: auth.accounts.as(a => a.length === 0),
    } satisfies Provider)
}

export function init() {
    if (!active) return
    loadSeen()
    loadChannelsCache()
    GLib.mkdir_with_parents(thumbsDir, 0o755)
    pruneThumbs()
    // registered unconditionally: a user who started signed in, lost
    // the account mid-session (chain stopped at zero accounts), and
    // signs back in must resume polling too
    auth.onAccountAdded(() => {
        poll()
        scheduleNext()
    })
    // no poll timer while signed out: the hook above starts it
    if (auth.getAccounts().length > 0) {
        poll()
        scheduleNext()
    }
}
