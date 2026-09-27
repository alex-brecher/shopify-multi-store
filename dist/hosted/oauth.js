import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { checkGoogleIdentity } from "./google.js";
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
const CIMD_CACHE_MS = 5 * 60_000;
const CIMD_MAX_BYTES = 16 * 1024;
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];
/** Audit label for sign-ins to server pages. */
export const PAGE_SIGN_IN_CLIENT = "tokens-page";
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function secret(prefix) {
    return `${prefix}${randomBytes(32).toString("base64url")}`;
}
function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
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
function approvalKey(email, clientId, redirectUri) {
    return sha256(`${email}\n${clientId}\n${redirectUri}`);
}
function describeStores(stores) {
    return stores === "*" ? "All stores" : stores.length ? stores.join(", ") : "None";
}
export class AuthorizationServer {
    options;
    issuer;
    resource;
    googleRedirectUri;
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
    /** Per refresh-token lock chain, so concurrent uses of one token are handled one at a time. */
    refreshLocks = new Map();
    constructor(options) {
        this.options = options;
        this.issuer = trimSlash(options.issuer);
        this.resource = trimSlash(options.resource);
        this.googleRedirectUri = `${this.issuer}/oauth/google/callback`;
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
        this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
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
        const clientId = `sms_client_${randomUUID()}`;
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
                : await fetchMetadataDocument(clientId);
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
        const nonce = randomBytes(16).toString("base64url");
        const googleVerifier = randomBytes(48).toString("base64url");
        const loginState = randomBytes(32).toString("base64url");
        const pending = {
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
    clientRedirect(redirectUri, params) {
        const url = new URL(redirectUri);
        for (const [key, value] of Object.entries({ ...params, iss: this.issuer })) {
            if (value !== undefined)
                url.searchParams.set(key, value);
        }
        return url.toString();
    }
    // ---------- Google callback ----------
    /**
     * Start a Google sign-in for a page on this server (the personal access token page) rather
     * than for an OAuth client. The same domain and policy checks apply.
     */
    async startPageSignIn(purpose) {
        const nonce = randomBytes(16).toString("base64url");
        const googleVerifier = randomBytes(48).toString("base64url");
        const loginState = randomBytes(32).toString("base64url");
        const pending = { purpose, nonce, googleVerifier };
        await this.options.store.put("pending", loginState, pending, this.now() + PENDING_TTL_MS);
        return redirect(this.options.google.authorizationUrl({
            state: loginState,
            nonce,
            codeChallenge: createHash("sha256").update(googleVerifier).digest("base64url"),
            redirectUri: this.googleRedirectUri
        }));
    }
    /** Receives page sign-ins (see startPageSignIn) after the domain and policy checks pass. */
    onPageSignIn;
    async googleCallback(url) {
        const loginState = url.searchParams.get("state");
        const stored = loginState ? await this.options.store.take("pending", loginState) : undefined;
        if (!stored)
            return errorPage(400, "This sign-in link expired or was already used. Start again from your AI app.");
        const page = "purpose" in stored ? stored : undefined;
        const pending = page ? undefined : stored;
        const clientId = pending?.clientId ?? PAGE_SIGN_IN_CLIENT;
        // OAuth sign-ins report failures to the client's redirect URI; page sign-ins show them here.
        const deny = (description) => pending
            ? redirect(this.clientRedirect(pending.redirectUri, { error: "access_denied", error_description: description, state: pending.clientState }))
            : errorPage(403, description);
        if (url.searchParams.get("error"))
            return deny("Google sign-in was cancelled or failed.");
        const code = url.searchParams.get("code");
        if (!code)
            return deny("Google did not return an authorization code.");
        let email;
        try {
            const claims = await this.options.google.exchange({ code, codeVerifier: stored.googleVerifier, redirectUri: this.googleRedirectUri, nonce: stored.nonce });
            const identity = checkGoogleIdentity(claims, this.options.allowedDomains);
            if ("error" in identity) {
                this.log(`Sign-in refused: ${identity.error}`);
                await this.auditAuth({ event: "sign_in_denied", clientId, reason: identity.error, ...(typeof claims.email === "string" ? { user: claims.email.toLowerCase() } : {}) });
                return deny(identity.error);
            }
            email = identity.email;
        }
        catch (error) {
            this.log(`Google sign-in verification failed: ${error instanceof Error ? error.message : String(error)}`);
            await this.auditAuth({ event: "sign_in_denied", clientId, reason: "Google sign-in could not be verified." });
            return deny("Google sign-in could not be verified.");
        }
        const principal = this.options.policy.current().resolve(email);
        if (!principal) {
            this.log(`Sign-in refused: ${email} is not in the access policy.`);
            await this.auditAuth({ event: "sign_in_denied", user: email, clientId, reason: "not in the access policy" });
            return deny(`${email} has not been granted access. Ask an administrator.`);
        }
        if (page) {
            if (!this.onPageSignIn)
                return errorPage(404, "This page is not available.");
            return this.onPageSignIn(page.purpose, email, principal);
        }
        if (!pending)
            return errorPage(400, "Unknown sign-in.");
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
        const consentId = randomBytes(32).toString("base64url");
        const csrf = randomBytes(32).toString("base64url");
        const binding = randomBytes(32).toString("base64url");
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
        if (!this.options.policy.current().resolve(email)) {
            await this.auditAuth({ event: "sign_in_denied", user: email, clientId: pending.clientId, reason: "removed from the access policy before approval" });
            return back({ error: "access_denied", error_description: `${email} has not been granted access. Ask an administrator.` });
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
        if (!this.options.policy.current().resolve(record.email)) {
            await this.auditAuth({ event: "sign_in_denied", user: record.email, clientId: client.client_id, reason: "removed from the access policy before the code was redeemed" });
            return oauthError("invalid_grant", "The user no longer has access.");
        }
        const issued = await this.issueTokens(client, record.email, record.scope, randomUUID(), this.now());
        await this.auditAuth({ event: "token_issued", user: record.email, clientId: client.client_id });
        return issued;
    }
    async refreshTokenGrant(client, body) {
        const token = body.get("refresh_token");
        if (!token)
            return oauthError("invalid_request", "refresh_token is required.");
        const key = sha256(token);
        // Serialize every use of the same refresh token. Without this, concurrent requests could all
        // read the record before any of them marked it rotated, and each would get new tokens.
        // With it, exactly one succeeds and the others see a rotated token and revoke the family.
        const previous = this.refreshLocks.get(key) ?? Promise.resolve();
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        const chain = previous.then(() => held);
        this.refreshLocks.set(key, chain);
        await previous;
        try {
            return await this.refreshTokenGrantLocked(client, body, key);
        }
        finally {
            release();
            if (this.refreshLocks.get(key) === chain)
                this.refreshLocks.delete(key);
        }
    }
    async refreshTokenGrantLocked(client, body, key) {
        const record = await this.options.store.get("refresh", key);
        if (!record)
            return oauthError("invalid_grant", "The refresh token is invalid or expired.");
        if (record.clientId !== client.client_id)
            return oauthError("invalid_grant", "The refresh token was issued to another client.");
        if (record.rotated) {
            // A rotated token came back: assume it leaked and revoke the whole token family.
            await this.revokeFamily(record.familyId);
            this.log(`Refresh token reuse detected for ${record.email}; revoked token family.`);
            await this.auditAuth({ event: "refresh_denied", user: record.email, clientId: client.client_id, reason: "refresh token reuse; token family revoked" });
            return oauthError("invalid_grant", "The refresh token was already used.");
        }
        const resource = body.get("resource");
        if (resource !== null && !this.resourceMatches(resource))
            return oauthError("invalid_target", `This server only issues tokens for ${this.resource}.`);
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
        await this.options.store.put("refresh", key, { ...record, rotated: true }, record.expiresAt);
        const refreshed = await this.issueTokens(client, record.email, record.scope, record.familyId, record.familyStartedAt);
        await this.auditAuth({ event: "token_refreshed", user: record.email, clientId: client.client_id });
        return refreshed;
    }
    async revokeFamily(familyId) {
        await this.options.store.deleteWhere("access", (value) => value.familyId === familyId);
        await this.options.store.deleteWhere("refresh", (value) => value.familyId === familyId);
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
        return record;
    }
    resolvePrincipal(email) {
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
])
    FORBIDDEN.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
    ["::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
    ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]
])
    FORBIDDEN.addSubnet(network, prefix, "ipv6");
/** True for an IP address a client metadata fetch must not connect to. Non-IP input is refused. */
export function isForbiddenAddress(address) {
    const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
    const family = isIP(ip);
    if (family === 4)
        return FORBIDDEN.check(ip, "ipv4");
    if (family !== 6)
        return true;
    // IPv4-mapped, IPv4-compatible and NAT64 (64:ff9b::/96) addresses carry an IPv4 address.
    const embedded = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
    if (embedded)
        return FORBIDDEN.check(embedded, "ipv4");
    const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
    if (hex) {
        const value = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
        return FORBIDDEN.check([24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join("."), "ipv4");
    }
    return FORBIDDEN.check(ip, "ipv6");
}
/** dns.lookup that fails when any resolved address is forbidden. Used as the socket's lookup, so the checked address is the one connected to. */
const publicOnlyLookup = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error)
            return callback(error);
        const list = addresses;
        const blocked = list.find((entry) => isForbiddenAddress(entry.address));
        if (!list.length || blocked) {
            return callback(new Error(`Client metadata host ${hostname} resolves to a non-public address${blocked ? ` (${blocked.address})` : ""}.`));
        }
        if (options.all)
            return callback(null, list);
        callback(null, list[0].address, list[0].family);
    });
};
/**
 * Fetch a Client ID Metadata Document: HTTPS only, no redirects, 5-second limit, 16 KB body.
 * The host, named or wildcard-admitted, must resolve only to public addresses (checked at
 * connect time, so a DNS answer cannot change between the check and the connection).
 */
export function fetchMetadataDocument(url) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        }
        catch {
            reject(new Error("Invalid URL."));
            return;
        }
        if (target.protocol !== "https:") {
            reject(new Error("Only HTTPS is allowed."));
            return;
        }
        const literal = target.hostname.replace(/^\[|\]$/g, "");
        if (isIP(literal) && isForbiddenAddress(literal)) {
            reject(new Error(`Client metadata host ${literal} is a non-public address.`));
            return;
        }
        const request = httpsRequest(target, {
            method: "GET",
            headers: { accept: "application/json" },
            lookup: publicOnlyLookup
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
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
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
                }
                catch {
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
//# sourceMappingURL=oauth.js.map