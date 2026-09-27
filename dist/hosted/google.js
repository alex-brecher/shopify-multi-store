import { createPublicKey, verify } from "node:crypto";
export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 60;
export function googleLogin(options) {
    const fetcher = options.fetch ?? fetch;
    const jwks = new JwksCache(GOOGLE_JWKS_URL, fetcher, options.now);
    return {
        authorizationUrl({ state, nonce, codeChallenge, redirectUri, loginHint }) {
            const url = new URL(GOOGLE_AUTHORIZE_URL);
            url.search = new URLSearchParams({
                client_id: options.clientId,
                redirect_uri: redirectUri,
                response_type: "code",
                scope: "openid email profile",
                state,
                nonce,
                code_challenge: codeChallenge,
                code_challenge_method: "S256",
                prompt: "select_account",
                ...(options.hostedDomainHint ? { hd: options.hostedDomainHint } : {}),
                ...(loginHint ? { login_hint: loginHint } : {})
            }).toString();
            return url.toString();
        },
        async exchange({ code, codeVerifier, redirectUri, nonce }) {
            const response = await fetcher(GOOGLE_TOKEN_URL, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
                body: new URLSearchParams({
                    grant_type: "authorization_code",
                    code,
                    code_verifier: codeVerifier,
                    redirect_uri: redirectUri,
                    client_id: options.clientId,
                    client_secret: options.clientSecret
                }),
                redirect: "error",
                signal: AbortSignal.timeout(15_000)
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || typeof payload.id_token !== "string") {
                throw new Error(`Google token exchange failed (HTTP ${response.status}${typeof payload.error === "string" ? `: ${payload.error}` : ""}).`);
            }
            return verifyGoogleIdToken(payload.id_token, { clientId: options.clientId, nonce, keys: jwks, now: options.now });
        }
    };
}
/** Caches Google's signing keys and refetches when an unknown key id appears (key rotation). */
export class JwksCache {
    url;
    fetcher;
    now;
    keys = new Map();
    fetchedAt = 0;
    maxAgeMs = 60 * 60_000;
    constructor(url, fetcher = fetch, now = Date.now) {
        this.url = url;
        this.fetcher = fetcher;
        this.now = now;
    }
    async key(kid) {
        const stale = this.now() - this.fetchedAt > this.maxAgeMs;
        // Refetch on unknown kid at most once a minute to avoid being used as an amplifier.
        if (stale || (!this.keys.has(kid) && this.now() - this.fetchedAt > 60_000))
            await this.refresh();
        return this.keys.get(kid);
    }
    async refresh() {
        const response = await this.fetcher(this.url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!response.ok)
            throw new Error(`Could not fetch Google signing keys (HTTP ${response.status}).`);
        const body = await response.json();
        const keys = new Map();
        for (const key of body.keys ?? [])
            if (typeof key.kid === "string")
                keys.set(key.kid, key);
        this.keys = keys;
        this.fetchedAt = this.now();
        const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1];
        this.maxAgeMs = maxAge ? Math.min(Number(maxAge), 24 * 3600) * 1000 : 60 * 60_000;
    }
}
function decodeSegment(segment) {
    const parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Malformed id_token.");
    return parsed;
}
/** Verify an RS256 Google id_token: signature against Google's keys, iss, aud, exp, iat, and nonce. */
export async function verifyGoogleIdToken(idToken, options) {
    const parts = idToken.split(".");
    if (parts.length !== 3)
        throw new Error("Malformed id_token.");
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = decodeSegment(headerPart);
    if (header.alg !== "RS256" || typeof header.kid !== "string")
        throw new Error("Unsupported id_token signature.");
    const jwk = await options.keys.key(header.kid);
    if (!jwk)
        throw new Error("Unknown id_token signing key.");
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const valid = verify("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), publicKey, Buffer.from(signaturePart, "base64url"));
    if (!valid)
        throw new Error("Invalid id_token signature.");
    const claims = decodeSegment(payloadPart);
    const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
    if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss))
        throw new Error("Unexpected id_token issuer.");
    const audience = claims.aud;
    const audienceOk = Array.isArray(audience) ? audience.includes(options.clientId) && (audience.length === 1 || claims.azp === options.clientId) : audience === options.clientId;
    if (!audienceOk)
        throw new Error("id_token audience does not match.");
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds)
        throw new Error("id_token expired.");
    if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SECONDS > nowSeconds)
        throw new Error("id_token issued in the future.");
    if (claims.nonce !== options.nonce)
        throw new Error("id_token nonce does not match.");
    if (typeof claims.sub !== "string" || !claims.sub)
        throw new Error("id_token has no subject.");
    return claims;
}
/**
 * Decide whether a verified Google identity may sign in.
 * Requires a verified email, a Workspace hosted-domain (hd) claim, and both hd and the
 * email domain in the allowlist. Requiring hd rejects consumer Google accounts that were
 * registered with a company email address but are not managed by the company's Workspace.
 */
export function checkGoogleIdentity(claims, allowedDomains) {
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!email || !email.includes("@"))
        return { error: "Google did not return an email address." };
    if (claims.email_verified !== true)
        return { error: "Google email address is not verified." };
    const allowed = new Set(allowedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean));
    const hd = typeof claims.hd === "string" ? claims.hd.toLowerCase() : "";
    if (!hd)
        return { error: "Sign in with a company Google Workspace account." };
    if (!allowed.has(hd))
        return { error: `Google Workspace domain ${hd} is not allowed.` };
    const emailDomain = email.slice(email.lastIndexOf("@") + 1);
    if (!allowed.has(emailDomain))
        return { error: `Email domain ${emailDomain} is not allowed.` };
    return { email };
}
//# sourceMappingURL=google.js.map