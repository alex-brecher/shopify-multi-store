import { type JsonWebKey } from "node:crypto";
export declare const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export declare const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export declare const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
/** Claims from a Google id_token whose signature, issuer, audience, expiry, and nonce were verified. */
export interface GoogleClaims {
    sub: string;
    email?: string;
    email_verified?: boolean;
    hd?: string;
    name?: string;
    [claim: string]: unknown;
}
/**
 * The part of Google sign-in the authorization server depends on. Tests inject a fake;
 * production uses googleLogin(), which talks to accounts.google.com.
 */
export interface GoogleLogin {
    authorizationUrl(params: {
        state: string;
        nonce: string;
        codeChallenge: string;
        redirectUri: string;
        loginHint?: string;
    }): string;
    /** Exchange the code and return verified id_token claims. Throws on any failure. */
    exchange(params: {
        code: string;
        codeVerifier: string;
        redirectUri: string;
        nonce: string;
    }): Promise<GoogleClaims>;
}
export interface GoogleLoginOptions {
    clientId: string;
    clientSecret: string;
    /** Restricts Google's account chooser to one Workspace domain. Only a UI hint; the hd claim is still verified. */
    hostedDomainHint?: string;
    fetch?: typeof fetch;
    now?: () => number;
}
export declare function googleLogin(options: GoogleLoginOptions): GoogleLogin;
export interface KeyProvider {
    key(kid: string): Promise<JsonWebKey | undefined>;
}
/** Caches Google's signing keys and refetches when an unknown key id appears (key rotation). */
export declare class JwksCache implements KeyProvider {
    private readonly url;
    private readonly fetcher;
    private readonly now;
    private keys;
    private fetchedAt;
    private maxAgeMs;
    constructor(url: string, fetcher?: typeof fetch, now?: () => number);
    key(kid: string): Promise<JsonWebKey | undefined>;
    private refresh;
}
/** Verify an RS256 Google id_token: signature against Google's keys, iss, aud, exp, iat, and nonce. */
export declare function verifyGoogleIdToken(idToken: string, options: {
    clientId: string;
    nonce: string;
    keys: KeyProvider;
    now?: () => number;
}): Promise<GoogleClaims>;
/**
 * Decide whether a verified Google identity may sign in.
 * Requires a verified email, a Workspace hosted-domain (hd) claim, and both hd and the
 * email domain in the allowlist. Requiring hd rejects consumer Google accounts that were
 * registered with a company email address but are not managed by the company's Workspace.
 */
export declare function checkGoogleIdentity(claims: GoogleClaims, allowedDomains: readonly string[]): {
    email: string;
} | {
    error: string;
};
