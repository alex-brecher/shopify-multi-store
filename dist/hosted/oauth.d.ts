import { type GoogleLogin } from "./google.js";
import type { Principal, PolicySource } from "./policy.js";
import type { OAuthStore } from "./store.js";
export declare const SCOPE = "mcp";
export declare const DEFAULT_REDIRECT_URIS: string[];
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
    redirectAllowlist?: string[];
    allowLoopbackRedirects?: boolean;
    /** Hosts allowed to serve Client ID Metadata Documents. "*" allows any HTTPS host. */
    cimdAllowedHosts?: string[];
    /** Fetches a Client ID Metadata Document. Injected by tests; defaults to a bounded HTTPS fetch. */
    fetchClientMetadata?: (url: string) => Promise<unknown>;
    accessTokenTtlSeconds?: number;
    refreshTokenTtlSeconds?: number;
    maxRegisteredClients?: number;
    now?: () => number;
    log?: (message: string) => void;
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
    expiresAt: number;
}
export declare function sha256(value: string): string;
export declare function errorPage(status: number, message: string): Response;
/** Loopback redirect per RFC 8252 section 7.3: http, a loopback host, any port and path. */
export declare function isLoopbackRedirect(uri: string): boolean;
export declare class AuthorizationServer {
    private readonly options;
    readonly issuer: string;
    readonly resource: string;
    readonly googleRedirectUri: string;
    private readonly redirectAllowlist;
    private readonly allowLoopback;
    private readonly cimdHosts;
    private readonly accessTtlMs;
    private readonly refreshTtlMs;
    private readonly maxClients;
    private readonly now;
    private readonly log;
    private readonly cimdCache;
    constructor(options: AuthServerOptions);
    get resourceMetadataUrl(): string;
    protectedResourceMetadata(): Record<string, unknown>;
    authorizationServerMetadata(): Record<string, unknown>;
    redirectUriAllowed(uri: string): boolean;
    private resourceMatches;
    register(request: Request): Promise<Response>;
    private resolveClient;
    private resolveMetadataDocument;
    authorize(url: URL): Promise<Response>;
    private clientRedirect;
    googleCallback(url: URL): Promise<Response>;
    token(request: Request): Promise<Response>;
    private authenticateClient;
    private authorizationCodeGrant;
    private refreshTokenGrant;
    private revokeFamily;
    private issueTokens;
    /** Look up a bearer token. Returns the record only if it is live and bound to this resource. */
    verifyAccessToken(token: string): Promise<AccessRecord | undefined>;
    resolvePrincipal(email: string): Principal | null;
}
export {};
