import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { checkGoogleIdentity, type GoogleLogin } from "./google.js";
import type { Principal, PolicySource } from "./policy.js";
import type { OAuthStore } from "./store.js";
import type { AuditLog, AuthAuditEntry } from "./audit.js";
import { KNOWN_REDIRECT_URIS, RedirectPolicy, isLoopbackRedirect, redirectDisplayHost, type RedirectClass } from "./known-clients.js";
import { cookie, escapeHtml, formActionSource, htmlPage, readCookie, sameOrigin } from "./html.js";

export { isLoopbackRedirect };
export const SCOPE = "mcp";
/** Built-in redirect URIs. See known-clients.ts. */
export const DEFAULT_REDIRECT_URIS: readonly string[] = KNOWN_REDIRECT_URIS;
export const DEFAULT_CIMD_HOSTS = ["claude.ai", "claude.com"];

const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
const CONSENT_TTL_MS = 5 * 60_000;
const APPROVAL_TTL_MS = 30 * 24 * 3600_000;
const CONSENT_COOKIE = "__Host-sms_consent";
const CIMD_CACHE_MS = 5 * 60_000;
const CIMD_MAX_BYTES = 16 * 1024;
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
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

interface PendingRecord {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  redirectUriExplicit: boolean;
  clientState?: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  nonce: string;
  googleVerifier: string;
}

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
  /** When the Google sign-in that started this token family happened (ms since epoch). */
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
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

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

function describeStores(stores: Principal["stores"]): string {
  return stores === "*" ? "All stores" : stores.length ? stores.join(", ") : "None";
}

export class AuthorizationServer {
  readonly issuer: string;
  readonly resource: string;
  readonly googleRedirectUri: string;
  readonly redirects: RedirectPolicy;
  readonly displayName: string;
  private readonly cimdHosts: string[];
  private readonly accessTtlMs: number;
  private readonly refreshTtlMs: number;
  private readonly sessionMaxAgeMs: number;
  private readonly maxClients: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly cimdCache = new Map<string, { client: ClientRecord; fetchedAt: number }>();
  /** Per refresh-token lock chain, so concurrent uses of one token are handled one at a time. */
  private readonly refreshLocks = new Map<string, Promise<void>>();

  constructor(private readonly options: AuthServerOptions) {
    this.issuer = trimSlash(options.issuer);
    this.resource = trimSlash(options.resource);
    this.googleRedirectUri = `${this.issuer}/oauth/google/callback`;
    this.displayName = options.displayName ?? "Shopify Multi-Store";
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
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
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
      resource_name: "Shopify Multi-Store"
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
    if (await this.options.store.count("client") >= this.maxClients) {
      return oauthError("temporarily_unavailable", "Client registration limit reached.", 503);
    }

    const clientId = `sms_client_${randomUUID()}`;
    const clientSecret = method === "none" ? undefined : secret("sms_cs_");
    const issuedAt = Math.floor(this.now() / 1000);
    const record: ClientRecord = {
      client_id: clientId,
      redirect_uris: redirectUris as string[],
      token_endpoint_auth_method: method,
      grant_types: grantTypes as string[],
      ...(clientName ? { client_name: clientName } : {}),
      ...(clientSecret ? { client_secret_sha256: sha256(clientSecret) } : {}),
      client_id_issued_at: issuedAt
    };
    await this.options.store.put("client", clientId, record);
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
    return client ?? { error: "Unknown client_id." };
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
    const listed = this.cimdHosts.some((allowed) => allowed !== "*" && (host === allowed || host.endsWith(`.${allowed}`)));
    const hostAllowed = listed || this.cimdHosts.includes("*");
    if (!hostAllowed) return { error: `Client metadata host ${host} is not allowed on this server.` };
    // A host admitted only by "*" could point anywhere, so its addresses must be public.
    const restrictAddresses = !listed;

    const cached = this.cimdCache.get(clientId);
    if (cached && this.now() - cached.fetchedAt < CIMD_CACHE_MS) return cached.client;

    let document: unknown;
    try {
      document = this.options.fetchClientMetadata
        ? await this.options.fetchClientMetadata(clientId)
        : await fetchMetadataDocument(clientId, { restrictAddresses });
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
    const method = doc.token_endpoint_auth_method ?? "none";
    if (method !== "none") return { error: "Client metadata clients must use token_endpoint_auth_method none." };
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

    const nonce = randomBytes(16).toString("base64url");
    const googleVerifier = randomBytes(48).toString("base64url");
    const loginState = randomBytes(32).toString("base64url");
    const pending: PendingRecord = {
      clientId,
      ...(client.client_name ? { clientName: client.client_name } : {}),
      redirectUri,
      redirectUriExplicit: requestedRedirect !== null,
      ...(state !== undefined ? { clientState: state } : {}),
      codeChallenge: challenge,
      resource: this.resource,
      scope: SCOPE,
      nonce,
      googleVerifier
    };
    await this.options.store.put("pending", loginState, pending, this.now() + PENDING_TTL_MS);
    return redirect(this.options.google.authorizationUrl({
      state: loginState,
      nonce,
      codeChallenge: createHash("sha256").update(googleVerifier).digest("base64url"),
      redirectUri: this.googleRedirectUri
    }));
  }

  private clientRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries({ ...params, iss: this.issuer })) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  // ---------- Google callback ----------

  async googleCallback(url: URL): Promise<Response> {
    const loginState = url.searchParams.get("state");
    const pending = loginState ? await this.options.store.take<PendingRecord>("pending", loginState) : undefined;
    if (!pending) return errorPage(400, "This sign-in link expired or was already used. Start again from your AI app.");
    const back = (params: Record<string, string>) => redirect(this.clientRedirect(pending.redirectUri, { ...params, state: pending.clientState }));

    if (url.searchParams.get("error")) return back({ error: "access_denied", error_description: "Google sign-in was cancelled or failed." });
    const code = url.searchParams.get("code");
    if (!code) return back({ error: "access_denied", error_description: "Google did not return an authorization code." });

    let email: string;
    try {
      const claims = await this.options.google.exchange({ code, codeVerifier: pending.googleVerifier, redirectUri: this.googleRedirectUri, nonce: pending.nonce });
      const identity = checkGoogleIdentity(claims, this.options.allowedDomains);
      if ("error" in identity) {
        this.log(`Sign-in refused: ${identity.error}`);
        await this.auditAuth({ event: "sign_in_denied", clientId: pending.clientId, reason: identity.error, ...(typeof claims.email === "string" ? { user: claims.email.toLowerCase() } : {}) });
        return back({ error: "access_denied", error_description: identity.error });
      }
      email = identity.email;
    } catch (error) {
      this.log(`Google sign-in verification failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.auditAuth({ event: "sign_in_denied", clientId: pending.clientId, reason: "Google sign-in could not be verified." });
      return back({ error: "access_denied", error_description: "Google sign-in could not be verified." });
    }

    const principal = this.options.policy.current().resolve(email);
    if (!principal) {
      this.log(`Sign-in refused: ${email} is not in the access policy.`);
      await this.auditAuth({ event: "sign_in_denied", user: email, clientId: pending.clientId, reason: "not in the access policy" });
      return back({ error: "access_denied", error_description: `${email} has not been granted access. Ask an administrator.` });
    }

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
    const consentId = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const binding = randomBytes(32).toString("base64url");
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
<dt>Signed in as</dt><dd>${escapeHtml(email)}</dd>
<dt>Your role</dt><dd>${escapeHtml(principal.role)}</dd>
<dt>Stores</dt><dd>${escapeHtml(describeStores(principal.stores))}</dd>
</dl>
<p class="muted">The app can call ${server} tools as you, limited to your role and stores.${open ? "" : " Approval is remembered for 30 days for this app."}</p>
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
    if (!this.options.policy.current().resolve(email)) {
      await this.auditAuth({ event: "sign_in_denied", user: email, clientId: pending.clientId, reason: "removed from the access policy before approval" });
      return back({ error: "access_denied", error_description: `${email} has not been granted access. Ask an administrator.` });
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
    if (!this.options.policy.current().resolve(record.email)) {
      await this.auditAuth({ event: "sign_in_denied", user: record.email, clientId: client.client_id, reason: "removed from the access policy before the code was redeemed" });
      return oauthError("invalid_grant", "The user no longer has access.");
    }
    const issued = await this.issueTokens(client, record.email, record.scope, randomUUID(), this.now());
    await this.auditAuth({ event: "token_issued", user: record.email, clientId: client.client_id });
    return issued;
  }

  private async refreshTokenGrant(client: ClientRecord, body: URLSearchParams): Promise<Response> {
    const token = body.get("refresh_token");
    if (!token) return oauthError("invalid_request", "refresh_token is required.");
    const key = sha256(token);
    // Serialize every use of the same refresh token. Without this, concurrent requests could all
    // read the record before any of them marked it rotated, and each would get new tokens.
    // With it, exactly one succeeds and the others see a rotated token and revoke the family.
    const previous = this.refreshLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => held);
    this.refreshLocks.set(key, chain);
    await previous;
    try {
      return await this.refreshTokenGrantLocked(client, body, key);
    } finally {
      release();
      if (this.refreshLocks.get(key) === chain) this.refreshLocks.delete(key);
    }
  }

  private async refreshTokenGrantLocked(client: ClientRecord, body: URLSearchParams, key: string): Promise<Response> {
    const record = await this.options.store.get<RefreshRecord>("refresh", key);
    if (!record) return oauthError("invalid_grant", "The refresh token is invalid or expired.");
    if (record.clientId !== client.client_id) return oauthError("invalid_grant", "The refresh token was issued to another client.");
    if (record.rotated) {
      // A rotated token came back: assume it leaked and revoke the whole token family.
      await this.revokeFamily(record.familyId);
      this.log(`Refresh token reuse detected for ${record.email}; revoked token family.`);
      await this.auditAuth({ event: "refresh_denied", user: record.email, clientId: client.client_id, reason: "refresh token reuse; token family revoked" });
      return oauthError("invalid_grant", "The refresh token was already used.");
    }
    const resource = body.get("resource");
    if (resource !== null && !this.resourceMatches(resource)) return oauthError("invalid_target", `This server only issues tokens for ${this.resource}.`);
    // Sessions do not slide forever: after the family's maximum age the user must sign in with
    // Google again, which re-checks the Workspace domain and the access policy.
    if (typeof record.familyStartedAt !== "number" || this.now() - record.familyStartedAt >= this.sessionMaxAgeMs) {
      await this.revokeFamily(record.familyId);
      this.log(`Session for ${record.email} reached its maximum age; sign-in required.`);
      await this.auditAuth({ event: "refresh_denied", user: record.email, clientId: client.client_id, reason: "session maximum age reached" });
      return oauthError("invalid_grant", "The sign-in session has expired. Sign in again.");
    }
    // Re-evaluate the access policy on every refresh so removed users lose access immediately.
    if (!this.options.policy.current().resolve(record.email)) {
      await this.revokeFamily(record.familyId);
      this.log(`Refresh refused: ${record.email} is not in the access policy; revoked token family.`);
      await this.auditAuth({ event: "refresh_denied", user: record.email, clientId: client.client_id, reason: "not in the access policy; token family revoked" });
      return oauthError("invalid_grant", "The user no longer has access.");
    }
    // Rotation: keep the old token only as a reuse tripwire until it would have expired.
    // Written before new tokens are issued, while this token's lock is held.
    await this.options.store.put<RefreshRecord>("refresh", key, { ...record, rotated: true }, record.expiresAt);
    const refreshed = await this.issueTokens(client, record.email, record.scope, record.familyId, record.familyStartedAt);
    await this.auditAuth({ event: "token_refreshed", user: record.email, clientId: client.client_id });
    return refreshed;
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.options.store.deleteWhere<AccessRecord>("access", (value) => value.familyId === familyId);
    await this.options.store.deleteWhere<RefreshRecord>("refresh", (value) => value.familyId === familyId);
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
    return record;
  }

  resolvePrincipal(email: string): Principal | null {
    return this.options.policy.current().resolve(email);
  }
}

// Addresses a client metadata URL must never reach: unspecified, loopback, private,
// carrier-grade NAT, link-local (including cloud metadata at 169.254.169.254), benchmark,
// documentation, multicast, and reserved ranges, for IPv4 and IPv6.
const FORBIDDEN = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) FORBIDDEN.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]
] as const) FORBIDDEN.addSubnet(network, prefix, "ipv6");

/** True for an IP address a client metadata fetch must not connect to. Non-IP input is refused. */
export function isForbiddenAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(ip);
  if (family === 4) return FORBIDDEN.check(ip, "ipv4");
  if (family !== 6) return true;
  // IPv4-mapped, IPv4-compatible and NAT64 (64:ff9b::/96) addresses carry an IPv4 address.
  const embedded = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  if (embedded) return FORBIDDEN.check(embedded, "ipv4");
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex) {
    const value = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
    return FORBIDDEN.check([24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join("."), "ipv4");
  }
  return FORBIDDEN.check(ip, "ipv6");
}

/** dns.lookup that fails when any resolved address is forbidden. Used as the socket's lookup, so the checked address is the one connected to. */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return (callback as (e: Error) => void)(error);
    const list = addresses as LookupAddress[];
    const blocked = list.find((entry) => isForbiddenAddress(entry.address));
    if (!list.length || blocked) {
      return (callback as (e: Error) => void)(new Error(`Client metadata host ${hostname} resolves to a non-public address${blocked ? ` (${blocked.address})` : ""}.`));
    }
    if (options.all) return (callback as (e: null, a: LookupAddress[]) => void)(null, list);
    (callback as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
  });
};

/**
 * Fetch a Client ID Metadata Document: HTTPS only, no redirects, 5-second limit, small body.
 * With restrictAddresses, the host must resolve only to public addresses (checked at connect time,
 * so a DNS answer cannot change between the check and the connection).
 */
export function fetchMetadataDocument(url: string, { restrictAddresses = true }: { restrictAddresses?: boolean } = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error("Invalid URL."));
      return;
    }
    if (target.protocol !== "https:") {
      reject(new Error("Only HTTPS is allowed."));
      return;
    }
    const literal = target.hostname.replace(/^\[|\]$/g, "");
    if (restrictAddresses && isIP(literal) && isForbiddenAddress(literal)) {
      reject(new Error(`Client metadata host ${literal} is a non-public address.`));
      return;
    }
    const request = httpsRequest(target, {
      method: "GET",
      headers: { accept: "application/json" },
      ...(restrictAddresses ? { lookup: publicOnlyLookup } : {})
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        reject(new Error(`Redirects are not followed (HTTP ${status}).`));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      if (Number(response.headers["content-length"] ?? "0") > CIMD_MAX_BYTES) {
        response.destroy();
        reject(new Error("Document too large."));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > CIMD_MAX_BYTES) {
          response.destroy();
          reject(new Error("Document too large."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("Document is not valid JSON."));
        }
      });
      response.on("error", reject);
    });
    const timer = setTimeout(() => request.destroy(new Error("Timed out.")), 5_000);
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    request.end();
  });
}
