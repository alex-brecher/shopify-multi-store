import { type GoogleLogin } from "./google.js";
import type { Principal, PolicySource } from "./policy.js";
import type { OAuthStore } from "./store.js";
import type { AuditLog, AuthAuditEntry } from "./audit.js";
import { RedirectPolicy, isLoopbackRedirect, type RedirectClass } from "./known-clients.js";
export { isLoopbackRedirect };
export declare const SCOPE = "mcp";
/** Built-in redirect URIs. See known-clients.ts. */
export declare const DEFAULT_REDIRECT_URIS: readonly string[];
export declare const DEFAULT_CIMD_HOSTS: string[];
declare const AUTH_METHODS: readonly ["none", "client_secret_post", "client_secret_basic"];
type AuthMethod = (typeof AUTH_METHODS)[number];
export interface AuthServerOptions {
    /** Public base URL, for example https://shopify-mcp.example.com. Also the OAuth issuer. */
    issuer: string;
    /** Protected resource identifier, the MCP endpoint URL. */
    resource: string;
    google: GoogleLogin;
    allowedDomains: string[];
    policy: PolicySource;
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
     * Maximum lifetime of a sign-in session (a refresh token family), counted from the Google
     * sign-in. Refresh fails with invalid_grant after this, so the user signs in with Google
     * again and the domain and policy checks run again. Defaults to 7 days.
     */
    sessionMaxAgeSeconds?: number;
    maxRegisteredClients?: number;
    now?: () => number;
    log?: (message: string) => void;
    /** Receives sign-in and token events. Tokens and codes are never passed. */
    audit?: AuditLog;
    /** Name shown on the consent page and in resource metadata. */
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
export interface AccessRecord {
    clientId: string;
    email: string;
    scope: string;
    resource: string;
    familyId: string;
    /** When the Google sign-in that started this token family happened (ms since epoch). */
    familyStartedAt: number;
    expiresAt: number;
}
export declare function sha256(value: string): string;
export declare function errorPage(status: number, message: string): Response;
export declare class AuthorizationServer {
    private readonly options;
    readonly issuer: string;
    readonly resource: string;
    readonly googleRedirectUri: string;
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
    private clientRedirect;
    googleCallback(url: URL): Promise<Response>;
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
    resolvePrincipal(email: string): Principal | null;
}
/** True for an IP address a client metadata fetch must not connect to. Non-IP input is refused. */
export declare function isForbiddenAddress(address: string): boolean;
/**
 * Fetch a Client ID Metadata Document: HTTPS only, no redirects, 5-second limit, small body.
 * With restrictAddresses, the host must resolve only to public addresses (checked at connect time,
 * so a DNS answer cannot change between the check and the connection).
 */
export declare function fetchMetadataDocument(url: string, { restrictAddresses }?: {
    restrictAddresses?: boolean;
}): Promise<unknown>;
