import { test, eq } from "./framework"
import {
    buildAuthUrl,
    generateCodeVerifier,
    generateState,
    parseRedirectParams,
    pkceChallenge,
    requestTarget,
    stateMatches,
} from "../src/lib/googleAuth"

// googleAuth's pure, network-free parts: PKCE + state generation, the
// consent URL shape, and the redirect parsing/validation the accept
// loop gates on. No live OAuth flow here.

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

test("googleAuth parseRedirectParams: code/error/state from the target", () => {
    eq(parseRedirectParams("/?code=4%2F0Af-x&state=st-1&scope=sc"), {
        code: "4/0Af-x",
        error: null,
        state: "st-1",
    })
    eq(parseRedirectParams("/?error=access_denied&state=st-1"), {
        code: null,
        error: "access_denied",
        state: "st-1",
    })
    // favicon and bare hits carry nothing
    eq(parseRedirectParams("/favicon.ico"), { code: null, error: null, state: null })
    eq(parseRedirectParams("/"), { code: null, error: null, state: null })
    // empty values are junk, not a redirect
    eq(parseRedirectParams("/?code=&state=st-1"), { code: null, error: null, state: "st-1" })
    // malformed percent-encoding drops just that param
    eq(parseRedirectParams("/?code=%E0%A4%A&state=st-1"), {
        code: null,
        error: null,
        state: "st-1",
    })
})

test("googleAuth requestTarget: GET request line only", () => {
    eq(requestTarget("GET /?code=x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"), "/?code=x")
    eq(requestTarget("GET /favicon.ico HTTP/1.1\r\n\r\n"), "/favicon.ico")
    eq(requestTarget("POST / HTTP/1.1\r\n\r\n"), null)
    eq(requestTarget("garbage with no structure"), null)
    eq(requestTarget(""), null)
})
