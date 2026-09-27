import type { OAuthStore } from "./store.js";
import type { AuditLog, AuthAuditEntry } from "./audit.js";
import { RedirectPolicy, isLoopbackRedirect, type RedirectClass } from "./known-clients.js";
export { isLoopbackRedirect };
export declare const SCOPE = "mcp";
export declare const DEFAULT_DISPLAY_NAME = "Shopify Multi-Store";
/** Built-in redirect URIs. See known-clients.ts. */
export declare const DEFAULT_REDIRECT_URIS: readonly string[];
/** Client ID Metadata Document hosts. "*" allows any HTTPS host; every fetch is limited to public addresses. */
export declare const DEFAULT_CIMD_HOSTS: string[];
declare const AUTH_METHODS: readonly ["none", "client_secret_post", "client_secret_basic"];
type AuthMethod = (typeof AUTH_METHODS)[number];
export interface AuthServerOptions {
    /** Public base URL, for example https://shopify-mcp.example.com. Also the OAuth issuer. */
    issuer: string;
    /** Protected resource identifier, the MCP endpoint URL. */
    resource: string;
    store: OAuthStore;
    /** Exact redirect URIs accepted. Defaults to the built-in known clients (known-clients.ts). */
    redirectAllowlist?: readonly string[];
    allowLoopbackRedirects?: boolean;
    /**
     * Accept any https or private-use-scheme redirect a client registers (DCR or CIMD).
     * Redirects admitted only by this always show the consent screen.
     */
    allowAnyRedirect?: boolean;
    /** Hosts allowed to serve Client ID Metadata Documents. "*" allows any HTTPS host. */
    cimdAllowedHosts?: string[];
    /** Fetches a Client ID Metadata Document. Injected by tests; defaults to a bounded HTTPS fetch. */
    fetchClientMetadata?: (url: string) => Promise<unknown>;
    accessTokenTtlSeconds?: number;
    refreshTokenTtlSeconds?: number;
    /**
     * Maximum lifetime of a sign-in session (a refresh token family), counted from the Shopify
     * sign-in. Refresh fails with invalid_grant after this, so the user signs in with Shopify
     * again, which proves again that they are staff on a configured store. Defaults to 7 days.
     */
    sessionMaxAgeSeconds?: number;
    maxRegisteredClients?: number;
    now?: () => number;
    log?: (message: string) => void;
    /** Receives sign-in and token events. Tokens and codes are never passed. */
    audit?: AuditLog;
    /** Name shown on the consent page, the tokens page, resource metadata and serverInfo.title. */
    displayName?: string;
}
export interface ClientRecord {
    client_id: string;
    redirect_uris: string[];
    token_endpoint_auth_method: AuthMethod;
    grant_types: string[];
    client_name?: string;
    client_secret_sha256?: string;
    client_id_issued_at?: number;
}
interface PendingRecord {
    clientId: string;
    clientName?: string;
    redirectUri: string;
    redirectUriExplicit: boolean;
    clientState?: string;
    codeChallenge: string;
    resource: string;
    scope: string;
    /** sha256 of the login binding cookie set on the browser that started the sign-in. */
    bindingSha256: string;
    /** The store the person signs in through, once chosen. */
    loginStore?: string;
    /** When this pending sign-in expires (ms since epoch). */
    expiresAt: number;
}
/** A sign-in started by a page on this server rather than an OAuth client. */
interface PageSignInRecord {
    purpose: PageSignInPurpose;
    bindingSha256: string;
    loginStore?: string;
    expiresAt: number;
}
/** A pending sign-in: for an OAuth client, or for a page on this server. */
export type LoginRecord = PendingRecord | PageSignInRecord;
/**
 * Server pages that start their own sign-in: the /stores page, and /stores/reconnect, which
 * goes on to reconnect every expired or unconnected store right after signing in.
 */
export type PageSignInPurpose = "stores" | "reconnect";
/** Audit label for sign-ins to server pages. */
export declare const PAGE_SIGN_IN_CLIENT = "stores-page";
export interface AccessRecord {
    clientId: string;
    email: string;
    scope: string;
    resource: string;
    familyId: string;
    /** When the Shopify sign-in that started this token family happened (ms since epoch). */
    familyStartedAt: number;
    expiresAt: number;
}
export declare function sha256(value: string): string;
export declare function errorPage(status: number, message: string): Response;
/** Add a Set-Cookie header to a response, keeping any it already has. */
export declare function appendSetCookie(response: Response, value: string): Response;
export declare class AuthorizationServer {
    private readonly options;
    readonly issuer: string;
    readonly resource: string;
    readonly redirects: RedirectPolicy;
    readonly displayName: string;
    private readonly cimdHosts;
    private readonly accessTtlMs;
    private readonly refreshTtlMs;
    private readonly sessionMaxAgeMs;
    private readonly maxClients;
    private readonly now;
    private readonly log;
    private readonly cimdCache;
    /** Per refresh-token lock chain, so concurrent uses of one token are handled one at a time. */
    private readonly refreshLocks;
    constructor(options: AuthServerOptions);
    /** Record a sign-in, token, or authorization event. Never throws. */
    auditAuth(entry: Omit<AuthAuditEntry, "timestamp">): Promise<void>;
    get resourceMetadataUrl(): string;
    protectedResourceMetadata(): Record<string, unknown>;
    authorizationServerMetadata(): Record<string, unknown>;
    redirectUriAllowed(uri: string): boolean;
    redirectUriClass(uri: string): RedirectClass | null;
    private resourceMatches;
    register(request: Request): Promise<Response>;
    private resolveClient;
    private resolveMetadataDocument;
    authorize(url: URL): Promise<Response>;
    /**
     * Store a pending sign-in and hand the browser to the login step (the store chooser, or
     * Shopify directly when one store is configured). The browser also gets a binding cookie;
     * only its sha256 is stored, and the chooser and the Shopify callback must present it, so a
     * sign-in link forwarded to another browser cannot complete there (login CSRF).
     */
    private beginLogin;
    /**
     * Starts the login step for a stored pending sign-in: returns the store chooser page or a
     * redirect to Shopify. Set by the Shopify connection handler.
     */
    startLogin?: (loginState: string) => Promise<Response>;
    /** Whether a login state names a pending sign-in (as opposed to a store connection). */
    isLogin(loginState: string): Promise<boolean>;
    /**
     * Read a pending sign-in without consuming it, after checking that this browser holds its
     * binding cookie. Used by the store chooser.
     */
    peekLogin(request: Request, loginState: string): Promise<{
        record: LoginRecord;
    } | {
        response: Response;
    }>;
    /** Record which store a pending sign-in goes through. */
    setLoginStore(loginState: string, alias: string): Promise<void>;
    /**
     * Consume a pending sign-in at the Shopify callback. The binding cookie is checked before the
     * state is consumed, so a callback without the matching cookie (for example a callback URL
     * forwarded from another browser) is refused and leaves the state unconsumed: it can neither
     * create a session nor burn the real sign-in. Once the check passes, the state is taken
     * (single use). Wrap every response that follows in clearLogin().
     */
    takeLogin(request: Request, loginState: string): Promise<{
        record: LoginRecord;
    } | {
        response: Response;
    }>;
    /** Clear the binding cookie of a finished (or failed) sign-in. */
    clearLogin(response: Response, loginState: string): Response;
    private bound;
    private refuseUnbound;
    /**
     * Refuse a sign-in: OAuth sign-ins report the failure to the client's redirect URI, page
     * sign-ins show it here.
     */
    denyLogin(record: LoginRecord, description: string, user?: string): Promise<Response>;
    private clientRedirect;
    /** Start a sign-in for a page on this server rather than for an OAuth client. */
    startPageSignIn(purpose: PageSignInPurpose): Promise<Response>;
    /** Receives page sign-ins (see startPageSignIn) once Shopify has verified the person. */
    onPageSignIn?: (purpose: PageSignInPurpose, email: string) => Promise<Response>;
    /**
     * Finish a sign-in for a verified Shopify staff email: page sign-ins go to onPageSignIn;
     * OAuth sign-ins get an authorization code (remembered approval) or the consent page.
     */
    completeLogin(record: LoginRecord, email: string): Promise<Response>;
    private issueCode;
    private consentPage;
    /** POST /consent: the user's Approve or Deny decision. */
    consent(request: Request): Promise<Response>;
    token(request: Request): Promise<Response>;
    private authenticateClient;
    private authorizationCodeGrant;
    private refreshTokenGrant;
    private refreshTokenGrantLocked;
    private revokeFamily;
    private issueTokens;
    /** Look up a bearer token. Returns the record only if it is live and bound to this resource. */
    verifyAccessToken(token: string): Promise<AccessRecord | undefined>;
}
/** True for an IP address a client metadata fetch must not connect to. Non-IP input is refused. */
export declare function isForbiddenAddress(address: string): boolean;
/**
 * Fetch a Client ID Metadata Document: HTTPS only, no redirects, 5-second limit, 16 KB body.
 * The host, named or wildcard-admitted, must resolve only to public addresses (checked at
 * connect time, so a DNS answer cannot change between the check and the connection).
 */
export declare function fetchMetadataDocument(url: string): Promise<unknown>;
