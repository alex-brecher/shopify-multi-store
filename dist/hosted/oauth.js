import { createHash } from "node:crypto";
import { fetchMetadataDocumentWithFetch } from "../platform/cimd-fetch.js";
import { constantTimeEqual, randomToken, randomUuid } from "../platform/crypto.js";
import { KNOWN_REDIRECT_URIS, RedirectPolicy, isLoopbackRedirect, redirectDisplayHost } from "./known-clients.js";
import { cookie, escapeHtml, formActionSource, htmlPage, readCookie, sameOrigin } from "./html.js";
export { isLoopbackRedirect };
export const SCOPE = "mcp";
export const DEFAULT_DISPLAY_NAME = "Shopify Multi-Store";
/** Built-in redirect URIs. See known-clients.ts. */
export const DEFAULT_REDIRECT_URIS = KNOWN_REDIRECT_URIS;
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
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];
/** Audit label for sign-ins to server pages. */
export const PAGE_SIGN_IN_CLIENT = "stores-page";
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function secret(prefix) {
    return `${prefix}${randomToken(32)}`;
}
const safeEqual = constantTimeEqual;
function trimSlash(value) {
    return value.endsWith("/") ? value.slice(0, -1) : value;
}
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };
function json(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...NO_STORE, ...headers } });
}
function oauthError(error, description, status = 400, headers = {}) {
    return json({ error, error_description: description }, status, headers);
}
export function errorPage(status, message) {
    return htmlPage({ status, title: "Sign-in problem", body: `<div class="card"><h1>Sign-in problem</h1><p>${escapeHtml(message)}</p></div>` });
}
function redirect(location, status = 302, headers = {}) {
    return new Response(null, { status, headers: { location, ...NO_STORE, ...headers } });
}
function loginCookieName(loginState) {
    return `${LOGIN_COOKIE_PREFIX}${sha256(loginState).slice(0, 24)}`;
}
/** HttpOnly, Secure, SameSite=Lax: it must survive the top-level redirect back from Shopify. */
function loginCookie(name, value, maxAgeSeconds) {
    return cookie(name, value, maxAgeSeconds);
}
/** Add a Set-Cookie header to a response, keeping any it already has. */
export function appendSetCookie(response, value) {
    const headers = new Headers(response.headers);
    headers.append("set-cookie", value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function approvalKey(email, clientId, redirectUri) {
    return sha256(`${email}\n${clientId}\n${redirectUri}`);
}
export class AuthorizationServer {
    options;
    issuer;
    resource;
    redirects;
    displayName;
    cimdHosts;
    accessTtlMs;
    refreshTtlMs;
    sessionMaxAgeMs;
    maxClients;
    now;
    log;
    cimdCache = new Map();
    constructor(options) {
        this.options = options;
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
        this.now = options.now ?? Date.now;
        this.log = options.log ?? ((message) => console.error(message));
    }
    /** Record a sign-in, token, or authorization event. Never throws. */
    async auditAuth(entry) {
        if (!this.options.audit)
            return;
        try {
            await this.options.audit.write({ timestamp: new Date(this.now()).toISOString(), ...entry });
        }
        catch (error) {
            this.log(`Audit log write failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    get resourceMetadataUrl() {
        return `${this.issuer}/.well-known/oauth-protected-resource${new URL(this.resource).pathname}`;
    }
    protectedResourceMetadata() {
        return {
            resource: this.resource,
            authorization_servers: [this.issuer],
            scopes_supported: [SCOPE],
            bearer_methods_supported: ["header"],
            resource_name: this.displayName
        };
    }
    authorizationServerMetadata() {
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
    redirectUriAllowed(uri) {
        return this.redirects.allowed(uri);
    }
    redirectUriClass(uri) {
        return this.redirects.classify(uri);
    }
    resourceMatches(value) {
        return trimSlash(value) === this.resource;
    }
    // ---------- Dynamic Client Registration (RFC 7591) ----------
    async register(request) {
        if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
            return oauthError("invalid_client_metadata", "Send client metadata as application/json.");
        }
        let body;
        try {
            const parsed = await request.json();
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error();
            body = parsed;
        }
        catch {
            return oauthError("invalid_client_metadata", "Client metadata must be a JSON object.");
        }
        const redirectUris = body.redirect_uris;
        if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every((uri) => typeof uri === "string")) {
            return oauthError("invalid_redirect_uri", "redirect_uris must list one to ten URIs.");
        }
        const rejected = redirectUris.find((uri) => !this.redirectUriAllowed(uri));
        if (rejected !== undefined)
            return oauthError("invalid_redirect_uri", `Redirect URI is not allowed on this server: ${rejected}`);
        const method = (body.token_endpoint_auth_method ?? "client_secret_basic");
        if (!AUTH_METHODS.includes(method))
            return oauthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
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
        const clientId = `sms_client_${randomUuid()}`;
        const clientSecret = method === "none" ? undefined : secret("sms_cs_");
        const issuedAt = Math.floor(this.now() / 1000);
        const record = {
            client_id: clientId,
            redirect_uris: redirectUris,
            token_endpoint_auth_method: method,
            grant_types: grantTypes,
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
    async resolveClient(clientId) {
        if (clientId.startsWith("https://"))
            return this.resolveMetadataDocument(clientId);
        const client = await this.options.store.get("client", clientId);
        return client ?? { error: "Unknown client_id." };
    }
    async resolveMetadataDocument(clientId) {
        let url;
        try {
            url = new URL(clientId);
        }
        catch {
            return { error: "client_id is not a valid URL." };
        }
        if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname === "/" || url.pathname === "") {
            return { error: "client_id metadata URL must be HTTPS with a path and no credentials or fragment." };
        }
        const host = url.hostname.toLowerCase();
        const hostAllowed = this.cimdHosts.includes("*") || this.cimdHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
        if (!hostAllowed)
            return { error: `Client metadata host ${host} is not allowed on this server.` };
        const cached = this.cimdCache.get(clientId);
        if (cached && this.now() - cached.fetchedAt < CIMD_CACHE_MS)
            return cached.client;
        let document;
        try {
            document = this.options.fetchClientMetadata
                ? await this.options.fetchClientMetadata(clientId)
                : await fetchMetadataDocumentWithFetch(clientId);
        }
        catch (error) {
            this.log(`Client metadata fetch failed for ${clientId}: ${error instanceof Error ? error.message : String(error)}`);
            return { error: "Client metadata document could not be fetched." };
        }
        if (!document || typeof document !== "object" || Array.isArray(document))
            return { error: "Client metadata document is not a JSON object." };
        const doc = document;
        if (doc.client_id !== clientId)
            return { error: "Client metadata client_id does not match its URL." };
        if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0 || !doc.redirect_uris.every((uri) => typeof uri === "string")) {
            return { error: "Client metadata must list redirect_uris." };
        }
        const method = doc.token_endpoint_auth_method ?? "none";
        if (method !== "none")
            return { error: "Client metadata clients must use token_endpoint_auth_method none." };
        // Keep only redirect URIs this server allows. A document with none left cannot be used.
        const redirectUris = doc.redirect_uris.filter((uri) => this.redirectUriAllowed(uri));
        if (redirectUris.length === 0)
            return { error: "None of the client's redirect URIs are allowed on this server." };
        const grantTypes = Array.isArray(doc.grant_types) ? doc.grant_types.filter((grant) => typeof grant === "string") : ["authorization_code", "refresh_token"];
        const client = {
            client_id: clientId,
            redirect_uris: redirectUris,
            token_endpoint_auth_method: "none",
            grant_types: grantTypes,
            ...(typeof doc.client_name === "string" ? { client_name: doc.client_name.slice(0, 200) } : {})
        };
        if (this.cimdCache.size > 100)
            this.cimdCache.clear();
        this.cimdCache.set(clientId, { client, fetchedAt: this.now() });
        return client;
    }
    // ---------- Authorization endpoint ----------
    async authorize(url) {
        const params = url.searchParams;
        for (const name of ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope"]) {
            if (params.getAll(name).length > 1)
                return errorPage(400, `The ${name} parameter is repeated.`);
        }
        const clientId = params.get("client_id");
        if (!clientId)
            return errorPage(400, "The client_id parameter is missing.");
        const client = await this.resolveClient(clientId);
        if ("error" in client)
            return errorPage(400, client.error);
        const requestedRedirect = params.get("redirect_uri");
        const redirectUri = requestedRedirect ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
        if (!redirectUri || !client.redirect_uris.includes(redirectUri) || !this.redirectUriAllowed(redirectUri)) {
            // Never redirect to an unverified URI.
            return errorPage(400, "The redirect_uri is not registered for this client or is not allowed on this server.");
        }
        const state = params.get("state") ?? undefined;
        const fail = (error, description) => redirect(this.clientRedirect(redirectUri, { error, error_description: description, state }));
        if (params.get("response_type") !== "code")
            return fail("unsupported_response_type", "Only response_type=code is supported.");
        const challenge = params.get("code_challenge");
        if (!challenge || params.get("code_challenge_method") !== "S256")
            return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
        if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
            return fail("invalid_request", "code_challenge must be a base64url-encoded SHA-256 hash.");
        const resources = params.getAll("resource");
        if (resources.length > 1 || (resources.length === 1 && !this.resourceMatches(resources[0]))) {
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
    async beginLogin(build) {
        if (!this.startLogin)
            return errorPage(503, "Sign-in is not available on this server.");
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
    startLogin;
    /** Whether a login state names a pending sign-in (as opposed to a store connection). */
    async isLogin(loginState) {
        if (!loginState || loginState.length > 200)
            return false;
        return (await this.options.store.get("pending", sha256(loginState))) !== undefined;
    }
    /**
     * Read a pending sign-in without consuming it, after checking that this browser holds its
     * binding cookie. Used by the store chooser.
     */
    async peekLogin(request, loginState) {
        const expired = () => errorPage(400, "This sign-in link expired or was already used. Start again from your AI app.");
        if (!loginState || loginState.length > 200)
            return { response: expired() };
        const record = await this.options.store.get("pending", sha256(loginState));
        if (!record)
            return { response: expired() };
        if (!this.bound(request, loginState, record))
            return { response: await this.refuseUnbound(record) };
        return { record };
    }
    /** Record which store a pending sign-in goes through. */
    async setLoginStore(loginState, alias) {
        const key = sha256(loginState);
        const record = await this.options.store.get("pending", key);
        if (!record)
            return;
        await this.options.store.put("pending", key, { ...record, loginStore: alias }, record.expiresAt);
    }
    /**
     * Consume a pending sign-in at the Shopify callback. The binding cookie is checked before the
     * state is consumed, so a callback without the matching cookie (for example a callback URL
     * forwarded from another browser) is refused and leaves the state unconsumed: it can neither
     * create a session nor burn the real sign-in. Once the check passes, the state is taken
     * (single use). Wrap every response that follows in clearLogin().
     */
    async takeLogin(request, loginState) {
        const peeked = await this.peekLogin(request, loginState);
        if ("response" in peeked)
            return { response: this.clearLogin(peeked.response, loginState) };
        const stored = await this.options.store.take("pending", sha256(loginState));
        if (!stored || stored.bindingSha256 !== peeked.record.bindingSha256) {
            return { response: this.clearLogin(errorPage(400, "This sign-in link expired or was already used. Start again from your AI app."), loginState) };
        }
        return { record: stored };
    }
    /** Clear the binding cookie of a finished (or failed) sign-in. */
    clearLogin(response, loginState) {
        return appendSetCookie(response, loginCookie(loginCookieName(loginState), "", 0));
    }
    bound(request, loginState, record) {
        const binding = readCookie(request, loginCookieName(loginState));
        return Boolean(binding) && typeof record.bindingSha256 === "string" && safeEqual(sha256(binding), record.bindingSha256);
    }
    async refuseUnbound(record) {
        const clientId = "purpose" in record ? PAGE_SIGN_IN_CLIENT : record.clientId;
        this.log("Sign-in refused: the request did not come from the browser that started the sign-in.");
        await this.auditAuth({ event: "sign_in_denied", clientId, reason: "sign-in not bound to this browser" });
        return errorPage(403, "This sign-in was started in a different browser. Start again from your AI app, in this browser.");
    }
    /**
     * Refuse a sign-in: OAuth sign-ins report the failure to the client's redirect URI, page
     * sign-ins show it here.
     */
    async denyLogin(record, description, user) {
        const clientId = "purpose" in record ? PAGE_SIGN_IN_CLIENT : record.clientId;
        this.log(`Sign-in refused: ${description}`);
        await this.auditAuth({ event: "sign_in_denied", clientId, reason: description, ...(user ? { user } : {}) });
        return "purpose" in record
            ? errorPage(403, description)
            : redirect(this.clientRedirect(record.redirectUri, { error: "access_denied", error_description: description, state: record.clientState }));
    }
    clientRedirect(redirectUri, params) {
        const url = new URL(redirectUri);
        for (const [key, value] of Object.entries({ ...params, iss: this.issuer })) {
            if (value !== undefined)
                url.searchParams.set(key, value);
        }
        return url.toString();
    }
    // ---------- Completing a sign-in ----------
    /** Start a sign-in for a page on this server rather than for an OAuth client. */
    async startPageSignIn(purpose) {
        return this.beginLogin((login) => ({ purpose, ...login }));
    }
    /** Receives page sign-ins (see startPageSignIn) once Shopify has verified the person. */
    onPageSignIn;
    /**
     * Finish a sign-in for a verified Shopify staff email: page sign-ins go to onPageSignIn;
     * OAuth sign-ins get an authorization code (remembered approval) or the consent page.
     */
    async completeLogin(record, email) {
        const page = "purpose" in record ? record : undefined;
        const principal = { email };
        if (page) {
            if (!this.onPageSignIn)
                return errorPage(404, "This page is not available.");
            return this.onPageSignIn(page.purpose, email);
        }
        const pending = record;
        const back = (params) => redirect(this.clientRedirect(pending.redirectUri, { ...params, state: pending.clientState }));
        const redirectClass = this.redirectUriClass(pending.redirectUri);
        if (!redirectClass)
            return back({ error: "access_denied", error_description: "The redirect URI is no longer allowed on this server." });
        // A remembered approval skips the consent screen, except for redirects admitted only by
        // OAUTH_ALLOW_ANY_REDIRECT, which always ask.
        if (redirectClass !== "open" && await this.options.store.get("approval", approvalKey(email, pending.clientId, pending.redirectUri))) {
            return redirect(await this.issueCode(pending, email));
        }
        return this.consentPage(pending, email, principal, redirectClass);
    }
    async issueCode(pending, email) {
        const authorizationCode = secret("sms_ac_");
        const record = {
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
    async consentPage(pending, email, principal, redirectClass) {
        const consentId = randomToken(32);
        const csrf = randomToken(32);
        const binding = randomToken(32);
        const record = { pending, email, csrfSha256: sha256(csrf), bindingSha256: sha256(binding), redirectClass };
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
    async consent(request) {
        if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
            return errorPage(400, "Unsupported form submission.");
        }
        if (!sameOrigin(request, this.issuer))
            return errorPage(403, "This form was submitted from another site.");
        const form = new URLSearchParams(await request.text());
        const consentId = form.get("consent") ?? "";
        const csrf = form.get("csrf") ?? "";
        const binding = readCookie(request, CONSENT_COOKIE) ?? "";
        const key = sha256(consentId);
        const record = consentId ? await this.options.store.get("consent", key) : undefined;
        const expired = "This approval request expired or was already used. Start again from your AI app.";
        if (!record)
            return errorPage(400, expired);
        if (!csrf || !binding || !safeEqual(sha256(csrf), record.csrfSha256) || !safeEqual(sha256(binding), record.bindingSha256)) {
            return errorPage(403, "This approval request could not be verified. Start again from your AI app.");
        }
        // Single use: only the request that removes the record may act on it.
        if (!await this.options.store.take("consent", key))
            return errorPage(400, expired);
        const { pending, email } = record;
        const clearCookie = { "set-cookie": cookie(CONSENT_COOKIE, "", 0) };
        const back = (params) => redirect(this.clientRedirect(pending.redirectUri, { ...params, state: pending.clientState }), 303, clearCookie);
        if (form.get("decision") !== "approve") {
            await this.auditAuth({ event: "consent_denied", user: email, clientId: pending.clientId });
            return back({ error: "access_denied", error_description: "The user denied access." });
        }
        const redirectClass = this.redirectUriClass(pending.redirectUri);
        if (!redirectClass)
            return back({ error: "access_denied", error_description: "The redirect URI is no longer allowed on this server." });
        if (redirectClass !== "open") {
            await this.options.store.put("approval", approvalKey(email, pending.clientId, pending.redirectUri), { approvedAt: this.now() }, this.now() + APPROVAL_TTL_MS);
        }
        await this.auditAuth({ event: "consent_approved", user: email, clientId: pending.clientId });
        return redirect(await this.issueCode(pending, email), 303, clearCookie);
    }
    // ---------- Token endpoint ----------
    async token(request) {
        if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
            return oauthError("invalid_request", "Send token requests as application/x-www-form-urlencoded.");
        }
        const body = new URLSearchParams(await request.text());
        for (const name of ["grant_type", "code", "code_verifier", "redirect_uri", "refresh_token", "client_id", "client_secret", "resource"]) {
            if (body.getAll(name).length > 1)
                return oauthError("invalid_request", `The ${name} parameter is repeated.`);
        }
        const client = await this.authenticateClient(request, body);
        if ("error" in client)
            return client.error;
        const grantType = body.get("grant_type");
        if (grantType === "authorization_code")
            return this.authorizationCodeGrant(client, body);
        if (grantType === "refresh_token") {
            if (!client.grant_types.includes("refresh_token"))
                return oauthError("unauthorized_client", "This client may not use refresh tokens.");
            return this.refreshTokenGrant(client, body);
        }
        return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
    }
    async authenticateClient(request, body) {
        let clientId = body.get("client_id");
        let clientSecret = body.get("client_secret");
        let usedBasic = false;
        const authorization = request.headers.get("authorization");
        if (authorization?.toLowerCase().startsWith("basic ")) {
            const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
            const colon = decoded.indexOf(":");
            let basicId;
            let basicSecret;
            try {
                if (colon < 0)
                    throw new Error("no separator");
                basicId = decodeURIComponent(decoded.slice(0, colon));
                basicSecret = decodeURIComponent(decoded.slice(colon + 1));
            }
            catch {
                return { error: oauthError("invalid_client", "Malformed Basic credentials.", 401, { "www-authenticate": 'Basic realm="token"' }) };
            }
            if (clientId && clientId !== basicId)
                return { error: oauthError("invalid_request", "client_id does not match the Authorization header.") };
            clientId = basicId;
            clientSecret = basicSecret;
            usedBasic = true;
        }
        const unauthorized = (description) => ({
            error: oauthError("invalid_client", description, 401, usedBasic ? { "www-authenticate": 'Basic realm="token"' } : {})
        });
        if (!clientId)
            return unauthorized("client_id is required.");
        if (clientId.startsWith("https://")) {
            if (clientSecret)
                return unauthorized("Client metadata document clients are public and must not send a secret.");
            const client = await this.resolveClient(clientId);
            return "error" in client ? unauthorized(client.error) : client;
        }
        const client = await this.options.store.get("client", clientId);
        if (!client)
            return unauthorized("Unknown client.");
        if (client.token_endpoint_auth_method !== "none") {
            if (!clientSecret || !client.client_secret_sha256 || !safeEqual(sha256(clientSecret), client.client_secret_sha256)) {
                return unauthorized("Client authentication failed.");
            }
        }
        return client;
    }
    async authorizationCodeGrant(client, body) {
        const code = body.get("code");
        const verifier = body.get("code_verifier");
        if (!code || !verifier)
            return oauthError("invalid_request", "code and code_verifier are required.");
        // Single use: the code is removed before any other check.
        const record = await this.options.store.take("code", sha256(code));
        if (!record || record.clientId !== client.client_id)
            return oauthError("invalid_grant", "The authorization code is invalid or expired.");
        const redirectUri = body.get("redirect_uri");
        if (redirectUri !== null ? redirectUri !== record.redirectUri : record.redirectUriExplicit) {
            return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
        }
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
            return oauthError("invalid_grant", "code_verifier is malformed.");
        const computed = createHash("sha256").update(verifier).digest("base64url");
        if (!safeEqual(computed, record.codeChallenge))
            return oauthError("invalid_grant", "PKCE verification failed.");
        const resource = body.get("resource");
        if (resource !== null && !this.resourceMatches(resource))
            return oauthError("invalid_target", `This server only issues tokens for ${this.resource}.`);
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
    async refreshTokenGrant(client, body) {
        const token = body.get("refresh_token");
        if (!token)
            return oauthError("invalid_request", "refresh_token is required.");
        const key = sha256(token);
        const record = await this.options.store.get("refresh", key);
        if (!record || await this.familyRevoked(record.familyId))
            return oauthError("invalid_grant", "The refresh token is invalid or expired.");
        if (record.clientId !== client.client_id)
            return oauthError("invalid_grant", "The refresh token was issued to another client.");
        if (record.rotated)
            return this.refreshReused(record, client);
        const resource = body.get("resource");
        if (resource !== null && !this.resourceMatches(resource))
            return oauthError("invalid_target", `This server only issues tokens for ${this.resource}.`);
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
        const claimed = await this.options.store.claim("refresh", key, "rotated");
        if (!claimed)
            return oauthError("invalid_grant", "The refresh token is invalid or expired.");
        if (!claimed.claimed)
            return this.refreshReused(claimed.value, client);
        const refreshed = await this.issueTokens(client, record.email, record.scope, record.familyId, record.familyStartedAt);
        await this.auditAuth({ event: "token_refreshed", user: record.email, clientId: client.client_id });
        return refreshed;
    }
    /** A rotated refresh token came back: assume it leaked and revoke the whole token family. */
    async refreshReused(record, client) {
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
    async revokeFamily(familyId, familyStartedAt) {
        await this.options.store.put("revoked_family", familyId, { revokedAt: this.now() }, Math.max(familyStartedAt + this.sessionMaxAgeMs, this.now() + 60_000));
        await this.options.store.deleteMatching("access", { familyId });
        await this.options.store.deleteMatching("refresh", { familyId });
    }
    async familyRevoked(familyId) {
        return (await this.options.store.get("revoked_family", familyId)) !== undefined;
    }
    async issueTokens(client, email, scope, familyId, familyStartedAt) {
        const now = this.now();
        const sessionEnd = familyStartedAt + this.sessionMaxAgeMs;
        const accessToken = secret("sms_at_");
        const access = { clientId: client.client_id, email, scope, resource: this.resource, familyId, familyStartedAt, expiresAt: Math.min(now + this.accessTtlMs, sessionEnd) };
        await this.options.store.put("access", sha256(accessToken), access, access.expiresAt);
        const issueRefresh = client.grant_types.includes("refresh_token");
        let refreshToken;
        if (issueRefresh) {
            refreshToken = secret("sms_rt_");
            const refresh = { ...access, expiresAt: Math.min(now + this.refreshTtlMs, sessionEnd) };
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
    async verifyAccessToken(token) {
        if (!token.startsWith("sms_at_") || token.length > 200)
            return undefined;
        const record = await this.options.store.get("access", sha256(token));
        if (!record || record.expiresAt <= this.now() || !this.resourceMatches(record.resource))
            return undefined;
        if (await this.familyRevoked(record.familyId))
            return undefined;
        return record;
    }
}
//# sourceMappingURL=oauth.js.map