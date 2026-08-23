import { test, eq } from "./framework"
import {
    reasonLabel,
    typeLabel,
    webUrl,
    threadData,
    newArrivals,
    bannerCandidates,
    isActionableReason,
} from "../src/lib/github"

test("github reasonLabel: known reasons and fallback", () => {
    eq(reasonLabel("mention"), "Mentioned")
    eq(reasonLabel("review_requested"), "Review requested")
    eq(reasonLabel("brand_new_reason"), "Brand new reason")
})

test("github typeLabel: known types and passthrough", () => {
    eq(typeLabel("PullRequest"), "Pull request")
    eq(typeLabel("Issue"), "Issue")
    eq(typeLabel("SomethingNew"), "SomethingNew")
})

test("github webUrl: api URLs map to web URLs", () => {
    eq(
        webUrl(
            "https://api.github.com/repos/owner/repo/issues/42",
            "https://github.com/owner/repo",
        ),
        "https://github.com/owner/repo/issues/42",
    )
    eq(
        webUrl("https://api.github.com/repos/owner/repo/pulls/7", "https://github.com/owner/repo"),
        "https://github.com/owner/repo/pulls/7",
    )
})

test("github webUrl: missing or unmappable subject falls back to the repo", () => {
    eq(webUrl(null, "https://github.com/owner/repo"), "https://github.com/owner/repo")
    eq(
        webUrl("https://api.github.com/users/someone", "https://github.com/owner/repo"),
        "https://github.com/owner/repo",
    )
})

const thread = (over: any = {}) => ({
    id: "123456",
    reason: "mention",
    updated_at: "2026-07-31T12:00:00Z",
    subject: {
        title: "Fix the thing",
        type: "PullRequest",
        url: "https://api.github.com/repos/LeadSeason/wam-shell/pulls/36",
    },
    repository: {
        full_name: "LeadSeason/wam-shell",
        html_url: "https://github.com/LeadSeason/wam-shell",
    },
    ...over,
})

test("github threadData: maps a thread to provider item data", () => {
    const d = threadData(thread())!
    eq(d.id, "github:123456")
    eq(d.provider, "github")
    eq(d.appName, "LeadSeason/wam-shell")
    eq(d.summary, "Fix the thing")
    eq(d.body, "Mentioned · Pull request")
    eq(d.iconName, "github-symbolic")
    eq(d.url, "https://github.com/LeadSeason/wam-shell/pulls/36")
    eq(d.time, Date.parse("2026-07-31T12:00:00Z") / 1000)
})

test("github threadData: incomplete threads are dropped", () => {
    eq(threadData({}), null)
    eq(threadData(thread({ id: "" })), null)
    eq(threadData(thread({ subject: { title: "" } })), null)
    eq(threadData(thread({ updated_at: "not a date" })), null)
})

test("github newArrivals: only ids absent from the previous list", () => {
    const prev = [{ id: "github:1" }, { id: "github:2" }]
    const next = [{ id: "github:2" }, { id: "github:3" }]
    eq(newArrivals(prev, next), ["github:3"])
    eq(newArrivals(prev, prev), [])
    eq(newArrivals([], next).length, 2)
})

test("github bannerCandidates: unseen and recent only", () => {
    const now = 1_700_000_000
    const fresh = { id: "github:1", time: now - 60 }
    const old = { id: "github:2", time: now - 72 * 3600 }
    const known = { id: "github:3", time: now - 60 }
    const seen = new Set(["github:3"])
    eq(
        bannerCandidates([fresh, old, known], seen, now).map(i => i.id),
        ["github:1"],
    )
    // a restart is not a baseline any more: an empty store still
    // banners what is recent (only the first run ever absorbs, and
    // that is decided by the store's absence, not by this helper)
    eq(
        bannerCandidates([fresh, old], new Set(), now).map(i => i.id),
        ["github:1"],
    )
    // everything seen: silence
    eq(bannerCandidates([fresh], new Set(["github:1"]), now).length, 0)
})

test("github isActionableReason: waiting on you vs. keeping you informed", () => {
    eq(isActionableReason("review_requested"), true)
    eq(isActionableReason("assign"), true)
    eq(isActionableReason("mention"), true)
    eq(isActionableReason("security_alert"), true)
    // the loud ones stay in the feed: every comment on your own PR
    // arrives as "author", and subscribed threads are pure firehose
    eq(isActionableReason("author"), false)
    eq(isActionableReason("subscribed"), false)
    eq(isActionableReason("comment"), false)
    eq(isActionableReason("ci_activity"), false)
    eq(isActionableReason(""), false)
})

test("github threadData: carries the actionable flag", () => {
    const raw = (reason: string) => ({
        id: "1",
        reason,
        updated_at: "2026-08-06T12:00:00Z",
        repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
        subject: { title: "t", type: "PullRequest", url: null },
    })
    eq(threadData(raw("review_requested"))?.actionable, true)
    eq(threadData(raw("author"))?.actionable, false)
})
