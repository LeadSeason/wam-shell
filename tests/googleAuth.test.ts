import { test, eq } from "./framework"
import {
    buildAuthUrl,
    generateCodeVerifier,
    generateState,
    encodeForm,
    parseRedirectParams,
    pkceChallenge,
    stateMatches,
} from "../src/lib/googleAuth"

// googleAuth's pure, network-free parts: PKCE + state generation, the
// consent URL shape, and the redirect parsing/validation the redirect
// server gates on. No live OAuth flow here.

test("googleAuth code verifier: 43 base64url chars (32 random bytes)", () => {
    const v = generateCodeVerifier()
    eq(v.length, 43)
    eq(/^[A-Za-z0-9_-]+$/.test(v), true)
    // CSPRNG: two generations never collide
    eq(generateCodeVerifier() !== v, true)
})

test("googleAuth PKCE challenge matches RFC 7636 appendix B", () => {
    eq(
        pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    )
})

test("googleAuth state nonce: base64url charset, unique per flow", () => {
    const s = generateState()
    eq(/^[A-Za-z0-9_-]+$/.test(s), true)
    eq(s.length >= 22, true)
    eq(generateState() !== s, true)
})

test("googleAuth auth URL carries state + PKCE S256 params", () => {
    const url = buildAuthUrl({
        clientId: "client-1",
        redirectUri: "http://127.0.0.1:12345",
        scope: "https://example.invalid/auth/scope.readonly",
        state: "state-abc",
        codeChallenge: "challenge-xyz",
    })
    eq(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"), true)
    eq(url.includes("state=state-abc"), true)
    eq(url.includes("code_challenge=challenge-xyz"), true)
    eq(url.includes("code_challenge_method=S256"), true)
    eq(url.includes("response_type=code"), true)
    eq(url.includes("access_type=offline"), true)
    eq(url.includes("client_id=client-1"), true)
    eq(url.includes(`redirect_uri=${encodeURIComponent("http://127.0.0.1:12345")}`), true)
    eq(
        url.includes(`scope=${encodeURIComponent("https://example.invalid/auth/scope.readonly")}`),
        true,
    )
})

test("googleAuth stateMatches: exact match, missing or foreign rejected", () => {
    eq(stateMatches("nonce-1", "nonce-1"), true)
    eq(stateMatches("nonce-1", "nonce-2"), false)
    eq(stateMatches("nonce-1", null), false)
    eq(stateMatches("nonce-1", ""), false)
})

test("googleAuth parseRedirectParams: code/error/state out of a query string", () => {
    // takes the QUERY only, without "?" -- Soup.Server hands us
    // msg.get_uri().get_query(), so nothing has to find it in a raw
    // request line any more
    eq(parseRedirectParams("code=4%2F0Af-x&state=st-1&scope=sc"), {
        code: "4/0Af-x",
        error: null,
        state: "st-1",
    })
    eq(parseRedirectParams("error=access_denied&state=st-1"), {
        code: null,
        error: "access_denied",
        state: "st-1",
    })
    // favicon and bare hits carry no query at all
    eq(parseRedirectParams(""), { code: null, error: null, state: null })
    // empty values are junk, not a redirect
    eq(parseRedirectParams("code=&state=st-1"), { code: null, error: null, state: "st-1" })
})

test("googleAuth parseRedirectParams: malformed encoding yields nothing at all", () => {
    // GLib.Uri.parse_params rejects the whole string rather than the one
    // bad pair, so state comes back null too -- a deliberate difference
    // from the hand-rolled parser this replaced. The outcome is
    // unchanged: with no code and no error the handler answers 404 and
    // keeps listening either way, and a query we cannot decode is not
    // our redirect. Strict is the right side to err on here -- the
    // relaxed flag would hand back a MANGLED code to exchange.
    eq(parseRedirectParams("code=%E0%A4%A&state=st-1"), {
        code: null,
        error: null,
        state: null,
    })
})

test("googleAuth encodeForm: form-urlencoded body, + for space", () => {
    // Soup's rules, not ours: `+` for space is correct for
    // application/x-www-form-urlencoded, which is what the token
    // endpoint takes. Order is NOT pinned -- form_encode_hash takes a
    // GHashTable and returns the pairs in whatever order it iterates,
    // which is why buildAuthUrl does not use it
    eq(encodeForm({ a: "x y" }), "a=x+y")
    eq(encodeForm({ "k/1": "v&2" }), "k%2F1=v%262")
})
