import { createHash } from "node:crypto";
import { fetchMetadataDocumentWithFetch } from "../platform/cimd-fetch.js";
import { constantTimeEqual, randomToken, randomUuid } from "../platform/crypto.js";
import type { Principal } from "./guard.js";
import type { OAuthStore } from "./store.js";
import type { AuditLog, AuthAuditEntry } from "./audit.js";
import { requestSource } from "./request-source.js";
import { KNOWN_REDIRECT_URIS, RedirectPolicy, isLoopbackRedirect, redirectDisplayHost, type RedirectClass } from "./known-clients.js";
import { cookie, escapeHtml, formActionSource, htmlPage, readCookie, sameOrigin } from "./html.js";

export { isLoopbackRedirect };
export const SCOPE = "mcp";
export const DEFAULT_DISPLAY_NAME = "Shopify Multi-Store";
/** Built-in redirect URIs. See known-clients.ts. */
export const DEFAULT_REDIRECT_URIS: readonly string[] = KNOWN_REDIRECT_URIS;
/** Client ID Metadata Document hosts. "*" allows any HTTPS host; every fetch is limited to public addresses. */
export const DEFAULT_CIMD_HOSTS = ["*"];

const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
const CONSENT_TTL_MS = 5 * 60_000;
const APPROVAL_TTL_MS = 30 * 24 * 3600_000;
const CONSENT_COOKIE = "__Host-sms_consent";
/**
 * Browser binding for a Shopify sign-in. One cookie per sign-in, named from its state, so two
 * sign-ins in one browser do not overwrite each other. The store chooser (POST /login/shopify)
 * and the Shopify callback both check it.
 */
const LOGIN_COOKIE_PREFIX = "__Host-sms_login_";
const CIMD_CACHE_MS = 5 * 60_000;
/** A registered client's idle expiry is pushed back at most once a day, so use is not a write per request. */
const CLIENT_TOUCH_MS = 24 * 3600_000;
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
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
  /**
   * Fetches a Client ID Metadata Document. Defaults to a bounded HTTPS fetch with the platform's
   * fetch (Workers). Node's serve passes the DNS-pinned fetcher from platform/cimd-node.ts.
   */
  fetchClientMetadata?: (url: string) => Promise<unknown>;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  /**
   * Maximum lifetime of a sign-in session (a refresh token family), counted from the Shopify
   * sign-in. Refresh fails with invalid_grant after this, so the user signs in with Shopify
   * again, which proves again that they are staff on a configured store. Defaults to 7 days.
   */
  sessionMaxAgeSeconds?: number;
  /** Cap on stored registered (DCR) clients. Default 10,000. */
  maxRegisteredClients?: number;
  /**
   * A registered (DCR) client record expires after this long without use (authorize or token
   * requests push it back). Default 30 days. Client ID Metadata Document clients are never
   * stored, only cached in memory for five minutes.
   */
  clientIdleTtlSeconds?: number;
  /**
   * Registrations allowed per source address per clock hour; 0 turns the limit off. Default 30.
   * The source is the socket peer on Node and CF-Connecting-IP on Workers (request-source.ts).
   */
  maxRegistrationsPerSourcePerHour?: number;
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
  /** ms since epoch; when the idle expiry was last pushed back. */
  last_used_at?: number;
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
export const PAGE_SIGN_IN_CLIENT = "stores-page";

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  redirectUriExplicit: boolean;
  codeChallenge: string;
  resource: string;
  scope: string;
  email: string;
}

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

interface RefreshRecord extends AccessRecord {
  rotated?: boolean;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secret(prefix: string): string {
  return `${prefix}${randomToken(32)}`;
}

const safeEqual = constantTimeEqual;

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...NO_STORE, ...headers } });
}

function oauthError(error: string, description: string, status = 400, headers: Record<string, string> = {}): Response {
  return json({ error, error_description: description }, status, headers);
}

export function errorPage(status: number, message: string): Response {
  return htmlPage({ status, title: "Sign-in problem", body: `<div class="card"><h1>Sign-in problem</h1><p>${escapeHtml(message)}</p></div>` });
}

function redirect(location: string, status = 302, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { location, ...NO_STORE, ...headers } });
}

function loginCookieName(loginState: string): string {
  return `${LOGIN_COOKIE_PREFIX}${sha256(loginState).slice(0, 24)}`;
}

/** HttpOnly, Secure, SameSite=Lax: it must survive the top-level redirect back from Shopify. */
function loginCookie(name: string, value: string, maxAgeSeconds: number): string {
  return cookie(name, value, maxAgeSeconds);
}

/** Add a Set-Cookie header to a response, keeping any it already has. */
export function appendSetCookie(response: Response, value: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** A pending authorization waiting for the signed-in user to approve or deny it. */
interface ConsentRecord {
  pending: PendingRecord;
  email: string;
  csrfSha256: string;
  /** Hash of the consent cookie, which binds the decision to the browser that signed in. */
  bindingSha256: string;
  redirectClass: RedirectClass;
}

function approvalKey(email: string, clientId: string, redirectUri: string): string {
  return sha256(`${email}\n${clientId}\n${redirectUri}`);
}

export class AuthorizationServer {
  readonly issuer: string;
  readonly resource: string;
  readonly redirects: RedirectPolicy;
  readonly displayName: string;
  private readonly cimdHosts: string[];
  private readonly accessTtlMs: number;
  private readonly refreshTtlMs: number;
  private readonly sessionMaxAgeMs: number;
  private readonly maxClients: number;
  private readonly clientIdleTtlMs: number;
  private readonly registrationsPerSourcePerHour: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly cimdCache = new Map<string, { client: ClientRecord; fetchedAt: number }>();

  constructor(private readonly options: AuthServerOptions) {
    this.issuer = trimSlash(options.issuer);
    this.resource = trimSlash(options.resource);
    this.displayName = options.displayName ?? DEFAULT_DISPLAY_NAME;
    this.redirects = new RedirectPolicy({
      exact: options.redirectAllowlist ?? KNOWN_REDIRECT_URIS,
      allowLoopback: options.allowLoopbackRedirects ?? true,
      allowAny: options.allowAnyRedirect ?? false
    });
    this.cimdHosts = (options.cimdAllowedHosts ?? DEFAULT_CIMD_HOSTS).map((host) => host.toLowerCase());
    this.accessTtlMs = (options.accessTokenTtlSeconds ?? 3600) * 1000;
    this.refreshTtlMs = (options.refreshTokenTtlSeconds ?? 30 * 24 * 3600) * 1000;
    this.sessionMaxAgeMs = (options.sessionMaxAgeSeconds ?? 7 * 24 * 3600) * 1000;
    this.maxClients = options.maxRegisteredClients ?? 10_000;
    this.clientIdleTtlMs = (options.clientIdleTtlSeconds ?? 30 * 24 * 3600) * 1000;
    this.registrationsPerSourcePerHour = options.maxRegistrationsPerSourcePerHour ?? 30;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.error(message));
  }

  /** Record a sign-in, token, or authorization event. Never throws. */
  async auditAuth(entry: Omit<AuthAuditEntry, "timestamp">): Promise<void> {
    if (!this.options.audit) return;
    try {
      await this.options.audit.write({ timestamp: new Date(this.now()).toISOString(), ...entry });
    } catch (error) {
      this.log(`Audit log write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get resourceMetadataUrl(): string {
    return `${this.issuer}/.well-known/oauth-protected-resource${new URL(this.resource).pathname}`;
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: this.displayName
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: [...AUTH_METHODS],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true
    };
  }

  redirectUriAllowed(uri: string): boolean {
    return this.redirects.allowed(uri);
  }

  redirectUriClass(uri: string): RedirectClass | null {
    return this.redirects.classify(uri);
  }

  private resourceMatches(value: string): boolean {
    return trimSlash(value) === this.resource;
  }

  // ---------- Dynamic Client Registration (RFC 7591) ----------

  async register(request: Request): Promise<Response> {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return oauthError("invalid_client_metadata", "Send client metadata as application/json.");
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return oauthError("invalid_client_metadata", "Client metadata must be a JSON object.");
    }
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every((uri) => typeof uri === "string")) {
      return oauthError("invalid_redirect_uri", "redirect_uris must list one to ten URIs.");
    }
    const rejected = (redirectUris as string[]).find((uri) => !this.redirectUriAllowed(uri));
    if (rejected !== undefined) return oauthError("invalid_redirect_uri", `Redirect URI is not allowed on this server: ${rejected}`);

    const method = (body.token_endpoint_auth_method ?? "client_secret_basic") as AuthMethod;
    if (!AUTH_METHODS.includes(method)) return oauthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
    const grantTypes = body.grant_types ?? ["authorization_code", "refresh_token"];
    if (!Array.isArray(grantTypes) || grantTypes.length === 0 || !grantTypes.every((grant) => grant === "authorization_code" || grant === "refresh_token") || !grantTypes.includes("authorization_code")) {
      return oauthError("invalid_client_metadata", "grant_types must include authorization_code and may include refresh_token.");
    }
    const responseTypes = body.response_types ?? ["code"];
    if (!Array.isArray(responseTypes) || responseTypes.some((type) => type !== "code")) {
      return oauthError("invalid_client_metadata", "Only the code response type is supported.");
    }
    const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : undefined;
    // The total first (a cheap counter read, never a listing), so a full server does not spend
    // anyone's hourly allowance.
    if (await this.options.store.count("client") >= this.maxClients) {
      return oauthError("temporarily_unavailable", "Client registration limit reached.", 503);
    }
    if (this.registrationsPerSourcePerHour > 0) {
      const hour = Math.floor(this.now() / 3600_000);
      const source = requestSource(request) ?? "unknown";
      const counted = await this.options.store.increment("counter", `register:${hour}:${source}`, {
        max: this.registrationsPerSourcePerHour,
        expiresAt: (hour + 1) * 3600_000
      });
      if (!counted.applied) {
        const retryAfter = Math.max(1, Math.ceil(((hour + 1) * 3600_000 - this.now()) / 1000));
        return oauthError("temporarily_unavailable", "Too many client registrations from this address. Try again later.", 429, { "retry-after": String(retryAfter) });
      }
    }

    const clientId = `sms_client_${randomUuid()}`;
    const clientSecret = method === "none" ? undefined : secret("sms_cs_");
    const issuedAt = Math.floor(this.now() / 1000);
    const record: ClientRecord = {
      client_id: clientId,
      redirect_uris: redirectUris as string[],
      token_endpoint_auth_method: method,
      grant_types: grantTypes as string[],
      ...(clientName ? { client_name: clientName } : {}),
      ...(clientSecret ? { client_secret_sha256: sha256(clientSecret) } : {}),
      client_id_issued_at: issuedAt,
      last_used_at: this.now()
    };
    await this.options.store.put("client", clientId, record, this.now() + this.clientIdleTtlMs);
    return json({
      client_id: clientId,
      client_id_issued_at: issuedAt,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      redirect_uris: record.redirect_uris,
      token_endpoint_auth_method: method,
      grant_types: record.grant_types,
      response_types: ["code"],
      ...(clientName ? { client_name: clientName } : {})
    }, 201);
  }

  // ---------- Client resolution (registered client or Client ID Metadata Document) ----------

  private async resolveClient(clientId: string): Promise<ClientRecord | { error: string }> {
    if (clientId.startsWith("https://")) return this.resolveMetadataDocument(clientId);
    const client = await this.options.store.get<ClientRecord>("client", clientId);
    if (!client) return { error: "Unknown client_id." };
    // In use: push the idle expiry back (at most once a day). Records from before client
    // expiry existed have no last_used_at and get an expiry on their first use.
    if (client.last_used_at === undefined || this.now() - client.last_used_at >= CLIENT_TOUCH_MS) {
      const touched: ClientRecord = { ...client, last_used_at: this.now() };
      await this.options.store.put("client", clientId, touched, this.now() + this.clientIdleTtlMs);
      return touched;
    }
    return client;
  }

  private async resolveMetadataDocument(clientId: string): Promise<ClientRecord | { error: string }> {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return { error: "client_id is not a valid URL." };
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname === "/" || url.pathname === "") {
      return { error: "client_id metadata URL must be HTTPS with a path and no credentials or fragment." };
    }
    const host = url.hostname.toLowerCase();
    const hostAllowed = this.cimdHosts.includes("*") || this.cimdHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    if (!hostAllowed) return { error: `Client metadata host ${host} is not allowed on this server.` };

    const cached = this.cimdCache.get(clientId);
    if (cached && this.now() - cached.fetchedAt < CIMD_CACHE_MS) return cached.client;

    let document: unknown;
    try {
      document = this.options.fetchClientMetadata
        ? await this.options.fetchClientMetadata(clientId)
        : await fetchMetadataDocumentWithFetch(clientId);
    } catch (error) {
      this.log(`Client metadata fetch failed for ${clientId}: ${error instanceof Error ? error.message : String(error)}`);
      return { error: "Client metadata document could not be fetched." };
    }
    if (!document || typeof document !== "object" || Array.isArray(document)) return { error: "Client metadata document is not a JSON object." };
    const doc = document as Record<string, unknown>;
    if (doc.client_id !== clientId) return { error: "Client metadata client_id does not match its URL." };
    if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0 || !doc.redirect_uris.every((uri) => typeof uri === "string")) {
      return { error: "Client metadata must list redirect_uris." };
    }
    // This server only runs public clients. Accept a document that allows "none" in either the
    // singular field or the plural token_endpoint_auth_methods_supported list. ChatGPT's document
    // names private_key_jwt in the singular field and lists ["none", "private_key_jwt"] in the plural.
    const method = doc.token_endpoint_auth_method ?? "none";
    const supported = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : [];
    if (method !== "none" && !supported.includes("none")) {
      return { error: "Client metadata clients must allow token_endpoint_auth_method none." };
    }
    // Keep only redirect URIs this server allows. A document with none left cannot be used.
    const redirectUris = (doc.redirect_uris as string[]).filter((uri) => this.redirectUriAllowed(uri));
    if (redirectUris.length === 0) return { error: "None of the client's redirect URIs are allowed on this server." };
    const grantTypes = Array.isArray(doc.grant_types) ? doc.grant_types.filter((grant): grant is string => typeof grant === "string") : ["authorization_code", "refresh_token"];
    const client: ClientRecord = {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: grantTypes,
      ...(typeof doc.client_name === "string" ? { client_name: doc.client_name.slice(0, 200) } : {})
    };
    if (this.cimdCache.size > 100) this.cimdCache.clear();
    this.cimdCache.set(clientId, { client, fetchedAt: this.now() });
    return client;
  }

  // ---------- Authorization endpoint ----------

  async authorize(url: URL): Promise<Response> {
    const params = url.searchParams;
    for (const name of ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope"]) {
      if (params.getAll(name).length > 1) return errorPage(400, `The ${name} parameter is repeated.`);
    }
    const clientId = params.get("client_id");
    if (!clientId) return errorPage(400, "The client_id parameter is missing.");
    const client = await this.resolveClient(clientId);
    if ("error" in client) return errorPage(400, client.error);

    const requestedRedirect = params.get("redirect_uri");
    const redirectUri = requestedRedirect ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!redirectUri || !client.redirect_uris.includes(redirectUri) || !this.redirectUriAllowed(redirectUri)) {
      // Never redirect to an unverified URI.
      return errorPage(400, "The redirect_uri is not registered for this client or is not allowed on this server.");
    }
    const state = params.get("state") ?? undefined;
    const fail = (error: string, description: string) => redirect(this.clientRedirect(redirectUri, { error, error_description: description, state }));

    if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = params.get("code_challenge");
    if (!challenge || params.get("code_challenge_method") !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request", "code_challenge must be a base64url-encoded SHA-256 hash.");
    const resources = params.getAll("resource");
    if (resources.length > 1 || (resources.length === 1 && !this.resourceMatches(resources[0]!))) {
      return fail("invalid_target", `This server only issues tokens for ${this.resource}.`);
    }

    return this.beginLogin((login) => ({
      clientId,
      ...(client.client_name ? { clientName: client.client_name } : {}),
      redirectUri,
      redirectUriExplicit: requestedRedirect !== null,
      ...(state !== undefined ? { clientState: state } : {}),
      codeChallenge: challenge,
      resource: this.resource,
      scope: SCOPE,
      ...login
    }));
  }

  /**
   * Store a pending sign-in and hand the browser to the login step (the store chooser, or
   * Shopify directly when one store is configured). The browser also gets a binding cookie;
   * only its sha256 is stored, and the chooser and the Shopify callback must present it, so a
   * sign-in link forwarded to another browser cannot complete there (login CSRF).
   */
  private async beginLogin(build: (login: { bindingSha256: string; expiresAt: number }) => LoginRecord): Promise<Response> {
    if (!this.startLogin) return errorPage(503, "Sign-in is not available on this server.");
    const loginState = randomToken(32);
    const binding = randomToken(32);
    const expiresAt = this.now() + PENDING_TTL_MS;
    const record = build({ bindingSha256: sha256(binding), expiresAt });
    await this.options.store.put("pending", sha256(loginState), record, expiresAt);
    const response = await this.startLogin(loginState);
    return appendSetCookie(response, loginCookie(loginCookieName(loginState), binding, PENDING_TTL_MS / 1000));
  }

  /**
   * Starts the login step for a stored pending sign-in: returns the store chooser page or a
   * redirect to Shopify. Set by the Shopify connection handler.
   */
  startLogin?: (loginState: string) => Promise<Response>;

  /** Whether a login state names a pending sign-in (as opposed to a store connection). */
  async isLogin(loginState: string): Promise<boolean> {
    if (!loginState || loginState.length > 200) return false;
    return (await this.options.store.get<LoginRecord>("pending", sha256(loginState))) !== undefined;
  }

  /**
   * Read a pending sign-in without consuming it, after checking that this browser holds its
   * binding cookie. Used by the store chooser.
   */
  async peekLogin(request: Request, loginState: string): Promise<{ record: LoginRecord } | { response: Response }> {
    const expired = () => errorPage(400, "This sign-in link expired or was already used. Start again from your AI app.");
    if (!loginState || loginState.length > 200) return { response: expired() };
    const record = await this.options.store.get<LoginRecord>("pending", sha256(loginState));
    if (!record) return { response: expired() };
    if (!this.bound(request, loginState, record)) return { response: await this.refuseUnbound(record) };
    return { record };
  }

  /** Record which store a pending sign-in goes through. */
  async setLoginStore(loginState: string, alias: string): Promise<void> {
    const key = sha256(loginState);
    const record = await this.options.store.get<LoginRecord>("pending", key);
    if (!record) return;
    await this.options.store.put<LoginRecord>("pending", key, { ...record, loginStore: alias }, record.expiresAt);
  }

  /**
   * Consume a pending sign-in at the Shopify callback. The binding cookie is checked before the
   * state is consumed, so a callback without the matching cookie (for example a callback URL
   * forwarded from another browser) is refused and leaves the state unconsumed: it can neither
   * create a session nor burn the real sign-in. Once the check passes, the state is taken
   * (single use). Wrap every response that follows in clearLogin().
   */
  async takeLogin(request: Request, loginState: string): Promise<{ record: LoginRecord } | { response: Response }> {
    const peeked = await this.peekLogin(request, loginState);
    if ("response" in peeked) return { response: this.clearLogin(peeked.response, loginState) };
    const stored = await this.options.store.take<LoginRecord>("pending", sha256(loginState));
    if (!stored || stored.bindingSha256 !== peeked.record.bindingSha256) {
      return { response: this.clearLogin(errorPage(400, "This sign-in link expired or was already used. Start again from your AI app."), loginState) };
    }
    return { record: stored };
  }

  /** Clear the binding cookie of a finished (or failed) sign-in. */
  clearLogin(response: Response, loginState: string): Response {
    return appendSetCookie(response, loginCookie(loginCookieName(loginState), "", 0));
  }

  private bound(request: Request, loginState: string, record: LoginRecord): boolean {
    const binding = readCookie(request, loginCookieName(loginState));
    return Boolean(binding) && typeof record.bindingSha256 === "string" && safeEqual(sha256(binding!), record.bindingSha256);
  }

  private async refuseUnbound(record: LoginRecord): Promise<Response> {
    const clientId = "purpose" in record ? PAGE_SIGN_IN_CLIENT : record.clientId;
    this.log("Sign-in refused: the request did not come from the browser that started the sign-in.");
    await this.auditAuth({ event: "sign_in_denied", clientId, reason: "sign-in not bound to this browser" });
    return errorPage(403, "This sign-in was started in a different browser. Start again from your AI app, in this browser.");
  }

  /**
   * Refuse a sign-in: OAuth sign-ins report the failure to the client's redirect URI, page
   * sign-ins show it here.
   */
  async denyLogin(record: LoginRecord, description: string, user?: string): Promise<Response> {
    const clientId = "purpose" in record ? PAGE_SIGN_IN_CLIENT : record.clientId;
    this.log(`Sign-in refused: ${description}`);
    await this.auditAuth({ event: "sign_in_denied", clientId, reason: description, ...(user ? { user } : {}) });
    return "purpose" in record
      ? errorPage(403, description)
      : redirect(this.clientRedirect(record.redirectUri, { error: "access_denied", error_description: description, state: record.clientState }));
  }

  private clientRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries({ ...params, iss: this.issuer })) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  // ---------- Completing a sign-in ----------

  /** Start a sign-in for a page on this server rather than for an OAuth client. */
  async startPageSignIn(purpose: PageSignInPurpose): Promise<Response> {
    return this.beginLogin((login) => ({ purpose, ...login }));
  }

  /** Receives page sign-ins (see startPageSignIn) once Shopify has verified the person. */
  onPageSignIn?: (purpose: PageSignInPurpose, email: string) => Promise<Response>;

  /**
   * Finish a sign-in for a verified Shopify staff email: page sign-ins go to onPageSignIn;
   * OAuth sign-ins get an authorization code (remembered approval) or the consent page.
   */
  async completeLogin(record: LoginRecord, email: string): Promise<Response> {
    const page = "purpose" in record ? record : undefined;
    const principal: Principal = { email };
    if (page) {
      if (!this.onPageSignIn) return errorPage(404, "This page is not available.");
      return this.onPageSignIn(page.purpose, email);
    }
    const pending = record as PendingRecord;
    const back = (params: Record<string, string>) => redirect(this.clientRedirect(pending.redirectUri, { ...params, state: pending.clientState }));

    const redirectClass = this.redirectUriClass(pending.redirectUri);
    if (!redirectClass) return back({ error: "access_denied", error_description: "The redirect URI is no longer allowed on this server." });
    // A remembered approval skips the consent screen, except for redirects admitted only by
    // OAUTH_ALLOW_ANY_REDIRECT, which always ask.
    if (redirectClass !== "open" && await this.options.store.get("approval", approvalKey(email, pending.clientId, pending.redirectUri))) {
      return redirect(await this.issueCode(pending, email));
    }
    return this.consentPage(pending, email, principal, redirectClass);
  }

  private async issueCode(pending: PendingRecord, email: string): Promise<string> {
    const authorizationCode = secret("sms_ac_");
    const record: CodeRecord = {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      redirectUriExplicit: pending.redirectUriExplicit,
      codeChallenge: pending.codeChallenge,
      resource: pending.resource,
      scope: pending.scope,
      email
    };
    await this.options.store.put("code", sha256(authorizationCode), record, this.now() + CODE_TTL_MS);
    await this.auditAuth({ event: "sign_in", user: email, clientId: pending.clientId });
    return this.clientRedirect(pending.redirectUri, { code: authorizationCode, state: pending.clientState });
  }

  // ---------- Consent ----------

  private async consentPage(pending: PendingRecord, email: string, principal: Principal, redirectClass: RedirectClass): Promise<Response> {
    const consentId = randomToken(32);
    const csrf = randomToken(32);
    const binding = randomToken(32);
    const record: ConsentRecord = { pending, email, csrfSha256: sha256(csrf), bindingSha256: sha256(binding), redirectClass };
    await this.options.store.put("consent", sha256(consentId), record, this.now() + CONSENT_TTL_MS);

    const server = escapeHtml(this.displayName);
    const clientName = pending.clientName ? escapeHtml(pending.clientName) : "An unnamed app";
    const host = escapeHtml(redirectDisplayHost(pending.redirectUri));
    const open = redirectClass === "open";
    const body = `<div class="card">
<h1>Allow ${clientName} to use ${server}?</h1>
${open ? `<div class="warn"><p>This app's return address is not on this server's list of known apps.</p><p>Approve only if you started this connection yourself, just now, from an app you trust.</p></div>` : ""}
<p class="muted">After you decide, you will be sent to</p>
<p class="target">${host}</p>
<dl>
<dt>App</dt><dd>${clientName}</dd>
<dt>Client ID</dt><dd><code>${escapeHtml(pending.clientId)}</code></dd>
<dt>Redirect</dt><dd><code>${escapeHtml(pending.redirectUri)}</code></dd>
<dt>Signed in as</dt><dd>${escapeHtml(principal.email)}${pending.loginStore ? ` <span class="muted">(Shopify, ${escapeHtml(pending.loginStore)})</span>` : ""}</dd>
</dl>
<p class="muted">The app can call ${server} tools as you. In each store it can do only what your own Shopify staff permissions allow.${open ? "" : " Approval is remembered for 30 days for this app."}</p>
<form method="post" action="/consent">
<input type="hidden" name="consent" value="${consentId}">
<input type="hidden" name="csrf" value="${csrf}">
<div class="actions"><button class="primary" type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></div>
</form></div>`;
    return htmlPage({
      title: `Approve access - ${this.displayName}`,
      body,
      formAction: `'self' ${formActionSource(pending.redirectUri)}`,
      headers: { "set-cookie": cookie(CONSENT_COOKIE, binding, CONSENT_TTL_MS / 1000) }
    });
  }

  /** POST /consent: the user's Approve or Deny decision. */
  async consent(request: Request): Promise<Response> {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return errorPage(400, "Unsupported form submission.");
    }
    if (!sameOrigin(request, this.issuer)) return errorPage(403, "This form was submitted from another site.");
    const form = new URLSearchParams(await request.text());
    const consentId = form.get("consent") ?? "";
    const csrf = form.get("csrf") ?? "";
    const binding = readCookie(request, CONSENT_COOKIE) ?? "";
    const key = sha256(consentId);
    const record = consentId ? await this.options.store.get<ConsentRecord>("consent", key) : undefined;
    const expired = "This approval request expired or was already used. Start again from your AI app.";
    if (!record) return errorPage(400, expired);
    if (!csrf || !binding || !safeEqual(sha256(csrf), record.csrfSha256) || !safeEqual(sha256(binding), record.bindingSha256)) {
      return errorPage(403, "This approval request could not be verified. Start again from your AI app.");
    }
    // Single use: only the request that removes the record may act on it.
    if (!await this.options.store.take<ConsentRecord>("consent", key)) return errorPage(400, expired);
    const { pending, email } = record;
    const clearCookie = { "set-cookie": cookie(CONSENT_COOKIE, "", 0) };
    const back = (params: Record<string, string>) => redirect(this.clientRedirect(pending.redirectUri, { ...params, state: pending.clientState }), 303, clearCookie);

    if (form.get("decision") !== "approve") {
      await this.auditAuth({ event: "consent_denied", user: email, clientId: pending.clientId });
      return back({ error: "access_denied", error_description: "The user denied access." });
    }
    const redirectClass = this.redirectUriClass(pending.redirectUri);
    if (!redirectClass) return back({ error: "access_denied", error_description: "The redirect URI is no longer allowed on this server." });
    if (redirectClass !== "open") {
      await this.options.store.put("approval", approvalKey(email, pending.clientId, pending.redirectUri), { approvedAt: this.now() }, this.now() + APPROVAL_TTL_MS);
    }
    await this.auditAuth({ event: "consent_approved", user: email, clientId: pending.clientId });
    return redirect(await this.issueCode(pending, email), 303, clearCookie);
  }

  // ---------- Token endpoint ----------

  async token(request: Request): Promise<Response> {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return oauthError("invalid_request", "Send token requests as application/x-www-form-urlencoded.");
    }
    const body = new URLSearchParams(await request.text());
    for (const name of ["grant_type", "code", "code_verifier", "redirect_uri", "refresh_token", "client_id", "client_secret", "resource"]) {
      if (body.getAll(name).length > 1) return oauthError("invalid_request", `The ${name} parameter is repeated.`);
    }
    const client = await this.authenticateClient(request, body);
    if ("error" in client) return client.error;

    const grantType = body.get("grant_type");
    if (grantType === "authorization_code") return this.authorizationCodeGrant(client, body);
    if (grantType === "refresh_token") {
      if (!client.grant_types.includes("refresh_token")) return oauthError("unauthorized_client", "This client may not use refresh tokens.");
      return this.refreshTokenGrant(client, body);
    }
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  private async authenticateClient(request: Request, body: URLSearchParams): Promise<ClientRecord | { error: Response }> {
    let clientId = body.get("client_id");
    let clientSecret = body.get("client_secret");
    let usedBasic = false;
    const authorization = request.headers.get("authorization");
    if (authorization?.toLowerCase().startsWith("basic ")) {
      const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      let basicId: string;
      let basicSecret: string;
      try {
        if (colon < 0) throw new Error("no separator");
        basicId = decodeURIComponent(decoded.slice(0, colon));
        basicSecret = decodeURIComponent(decoded.slice(colon + 1));
      } catch {
        return { error: oauthError("invalid_client", "Malformed Basic credentials.", 401, { "www-authenticate": 'Basic realm="token"' }) };
      }
      if (clientId && clientId !== basicId) return { error: oauthError("invalid_request", "client_id does not match the Authorization header.") };
      clientId = basicId;
      clientSecret = basicSecret;
      usedBasic = true;
    }
    const unauthorized = (description: string) => ({
      error: oauthError("invalid_client", description, 401, usedBasic ? { "www-authenticate": 'Basic realm="token"' } : {})
    });
    if (!clientId) return unauthorized("client_id is required.");
    if (clientId.startsWith("https://")) {
      if (clientSecret) return unauthorized("Client metadata document clients are public and must not send a secret.");
      const client = await this.resolveClient(clientId);
      return "error" in client ? unauthorized(client.error) : client;
    }
    const client = await this.options.store.get<ClientRecord>("client", clientId);
    if (!client) return unauthorized("Unknown client.");
    if (client.token_endpoint_auth_method !== "none") {
      if (!clientSecret || !client.client_secret_sha256 || !safeEqual(sha256(clientSecret), client.client_secret_sha256)) {
        return unauthorized("Client authentication failed.");
      }
    }
    return client;
  }

  private async authorizationCodeGrant(client: ClientRecord, body: URLSearchParams): Promise<Response> {
    const code = body.get("code");
    const verifier = body.get("code_verifier");
    if (!code || !verifier) return oauthError("invalid_request", "code and code_verifier are required.");
    // Single use: the code is removed before any other check.
    const record = await this.options.store.take<CodeRecord>("code", sha256(code));
    if (!record || record.clientId !== client.client_id) return oauthError("invalid_grant", "The authorization code is invalid or expired.");
    const redirectUri = body.get("redirect_uri");
    if (redirectUri !== null ? redirectUri !== record.redirectUri : record.redirectUriExplicit) {
      return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError("invalid_grant", "code_verifier is malformed.");
    const computed = createHash("sha256").update(verifier).digest("base64url");
    if (!safeEqual(computed, record.codeChallenge)) return oauthError("invalid_grant", "PKCE verification failed.");
    const resource = body.get("resource");
    if (resource !== null && !this.resourceMatches(resource)) return oauthError("invalid_target", `This server only issues tokens for ${this.resource}.`);
    const issued = await this.issueTokens(client, record.email, record.scope, randomUuid(), this.now());
    await this.auditAuth({ event: "token_issued", user: record.email, clientId: client.client_id });
    return issued;
  }

  /**
   * Refresh with rotation and reuse detection. Every check that can refuse the request runs
   * before the token is spent; the token is then claimed with one atomic store operation
   * (OAuthStore.claim), so of several concurrent uses of one token exactly one wins, in one
   * Node process and on a Durable Object alike. A token that was already claimed is a reuse:
   * the whole token family is revoked.
   */
  private async refreshTokenGrant(client: ClientRecord, body: URLSearchParams): Promise<Response> {
    const token = body.get("refresh_token");
    if (!token) return oauthError("invalid_request", "refresh_token is required.");
    const key = sha256(token);
    const record = await this.options.store.get<RefreshRecord>("refresh", key);
    if (!record || await this.familyRevoked(record.familyId)) return oauthError("invalid_grant", "The refresh token is invalid or expired.");
    if (record.clientId !== client.client_id) return oauthError("invalid_grant", "The refresh token was issued to another client.");
    if (record.rotated) return this.refreshReused(record, client);
    const resource = body.get("resource");
    if (resource !== null && !this.resourceMatches(resource)) return oauthError("invalid_target", `This server only issues tokens for ${this.resource}.`);
    // Sessions do not slide forever: after the family's maximum age the user must sign in with
    // Shopify again, which proves again that they are staff on a configured store.
    if (typeof record.familyStartedAt !== "number" || this.now() - record.familyStartedAt >= this.sessionMaxAgeMs) {
      await this.revokeFamily(record.familyId, record.familyStartedAt);
      this.log(`Session for ${record.email} reached its maximum age; sign-in required.`);
      await this.auditAuth({ event: "refresh_denied", user: record.email, clientId: client.client_id, reason: "session maximum age reached" });
      return oauthError("invalid_grant", "The sign-in session has expired. Sign in again.");
    }
    // Rotation: mark the token used, atomically. The old token stays only as a reuse tripwire
    // until it would have expired.
    const claimed = await this.options.store.claim<RefreshRecord>("refresh", key, "rotated");
    if (!claimed) return oauthError("invalid_grant", "The refresh token is invalid or expired.");
    if (!claimed.claimed) return this.refreshReused(claimed.value, client);
    const refreshed = await this.issueTokens(client, record.email, record.scope, record.familyId, record.familyStartedAt);
    await this.auditAuth({ event: "token_refreshed", user: record.email, clientId: client.client_id });
    return refreshed;
  }

  /** A rotated refresh token came back: assume it leaked and revoke the whole token family. */
  private async refreshReused(record: RefreshRecord, client: ClientRecord): Promise<Response> {
    await this.revokeFamily(record.familyId, record.familyStartedAt);
    this.log(`Refresh token reuse detected for ${record.email}; revoked token family.`);
    await this.auditAuth({ event: "refresh_denied", user: record.email, clientId: client.client_id, reason: "refresh token reuse; token family revoked" });
    return oauthError("invalid_grant", "The refresh token was already used.");
  }

  /**
   * Revoke a token family. A marker is written first and checked wherever a family's tokens
   * are used, so tokens that a concurrent request issues for the family after the deletes
   * below (the winner of a refresh race, say) are dead too. It lives as long as any token of
   * the family could.
   */
  private async revokeFamily(familyId: string, familyStartedAt: number): Promise<void> {
    await this.options.store.put("revoked_family", familyId, { revokedAt: this.now() }, Math.max(familyStartedAt + this.sessionMaxAgeMs, this.now() + 60_000));
    await this.options.store.deleteMatching("access", { familyId });
    await this.options.store.deleteMatching("refresh", { familyId });
  }

  private async familyRevoked(familyId: string): Promise<boolean> {
    return (await this.options.store.get("revoked_family", familyId)) !== undefined;
  }

  private async issueTokens(client: ClientRecord, email: string, scope: string, familyId: string, familyStartedAt: number): Promise<Response> {
    const now = this.now();
    const sessionEnd = familyStartedAt + this.sessionMaxAgeMs;
    const accessToken = secret("sms_at_");
    const access: AccessRecord = { clientId: client.client_id, email, scope, resource: this.resource, familyId, familyStartedAt, expiresAt: Math.min(now + this.accessTtlMs, sessionEnd) };
    await this.options.store.put("access", sha256(accessToken), access, access.expiresAt);
    const issueRefresh = client.grant_types.includes("refresh_token");
    let refreshToken: string | undefined;
    if (issueRefresh) {
      refreshToken = secret("sms_rt_");
      const refresh: RefreshRecord = { ...access, expiresAt: Math.min(now + this.refreshTtlMs, sessionEnd) };
      await this.options.store.put("refresh", sha256(refreshToken), refresh, refresh.expiresAt);
    }
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.floor((access.expiresAt - now) / 1000)),
      scope,
      ...(refreshToken ? { refresh_token: refreshToken } : {})
    });
  }

  // ---------- Resource server side ----------

  /** Look up a bearer token. Returns the record only if it is live and bound to this resource. */
  async verifyAccessToken(token: string): Promise<AccessRecord | undefined> {
    if (!token.startsWith("sms_at_") || token.length > 200) return undefined;
    const record = await this.options.store.get<AccessRecord>("access", sha256(token));
    if (!record || record.expiresAt <= this.now() || !this.resourceMatches(record.resource)) return undefined;
    if (await this.familyRevoked(record.familyId)) return undefined;
    return record;
  }
}
