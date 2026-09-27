/**
 * Redirect URI policy for the hosted connector.
 *
 * The hosted server is meant to work with any MCP client that speaks OAuth, on any plan.
 * By default it accepts the exact callbacks below, plus loopback redirects (RFC 8252 section 7.3)
 * used by command-line and desktop clients. Operators can add more with OAUTH_REDIRECT_URIS,
 * or accept any safe redirect with OAUTH_ALLOW_ANY_REDIRECT=1 (the consent screen is then
 * mandatory for redirects that are not on a list).
 */
export interface KnownClientRedirect {
    uri: string;
    client: string;
}
/** Exact redirect URIs of known MCP clients. Menu paths and URLs are vendor-controlled and may change. */
export declare const KNOWN_CLIENT_REDIRECTS: readonly KnownClientRedirect[];
/** The exact URIs from KNOWN_CLIENT_REDIRECTS. */
export declare const KNOWN_REDIRECT_URIS: readonly string[];
/** Loopback redirect per RFC 8252 section 7.3: http, a loopback host, any port and path. Claude Code, Codex, Gemini CLI and desktop apps. */
export declare function isLoopbackRedirect(uri: string): boolean;
/**
 * A private-use (custom scheme) redirect such as cursor://host/path or com.example.app:/cb.
 * The scheme must not be a web scheme or look like one (httpx, https.evil, ...), and the URI
 * must carry no credentials or fragment.
 */
export declare function isSafePrivateUseRedirect(uri: string): boolean;
/** An https redirect with a host and no credentials or fragment. */
export declare function isSafeHttpsRedirect(uri: string): boolean;
/**
 * How a redirect URI is admitted:
 * "listed" (built-in or configured exact match), "loopback", "open" (admitted only by
 * OAUTH_ALLOW_ANY_REDIRECT; always needs consent), or null (refused).
 */
export type RedirectClass = "listed" | "loopback" | "open";
export interface RedirectPolicyOptions {
    /** Exact URIs accepted. Defaults to KNOWN_REDIRECT_URIS. */
    exact?: readonly string[];
    allowLoopback?: boolean;
    allowAny?: boolean;
}
export declare class RedirectPolicy {
    readonly exact: readonly string[];
    readonly allowLoopback: boolean;
    readonly allowAny: boolean;
    constructor(options?: RedirectPolicyOptions);
    classify(uri: string): RedirectClass | null;
    allowed(uri: string): boolean;
}
/** Build the exact list from OAUTH_REDIRECT_URIS: additive to the built-ins unless replace is set. */
export declare function redirectListFromEnv(configured: string[] | undefined, replace: boolean): string[];
/** A short label for a redirect target: the host for web URIs, scheme://host for custom schemes. */
export declare function redirectDisplayHost(uri: string): string;
