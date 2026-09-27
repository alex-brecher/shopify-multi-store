import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { checkGoogleIdentity } from "./google.js";
export const SCOPE = "mcp";
export const DEFAULT_REDIRECT_URIS = [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback"
];
export const DEFAULT_CIMD_HOSTS = ["claude.ai", "claude.com"];
const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
const CIMD_CACHE_MS = 5 * 60_000;
const CIMD_MAX_BYTES = 16 * 1024;
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];
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
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
export function errorPage(status, message) {
    const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in problem</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Sign-in problem</h1><p>${escapeHtml(message)}</p></body>`;
    return new Response(body, {
        status,
        headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE, "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-frame-options": "DENY" }
    });
}
function redirect(location) {
    return new Response(null, { status: 302, headers: { location, ...NO_STORE } });
}
/** Loopback redirect per RFC 8252 section 7.3: http, a loopback host, any port and path. */
export function isLoopbackRedirect(uri) {
    let url;
    try {
        url = new URL(uri);
    }
    catch {
        return false;
    }
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password && !url.hash;
}
export class AuthorizationServer {
    options;
    issuer;
    resource;
    googleRedirectUri;
    redirectAllowlist;
    allowLoopback;
    cimdHosts;
    accessTtlMs;
    refreshTtlMs;
    maxClients;
    now;
    log;
    cimdCache = new Map();
    constructor(options) {
        this.options = options;
        this.issuer = trimSlash(options.issuer);
        this.resource = trimSlash(options.resource);
        this.googleRedirectUri = `${this.issuer}/oauth/google/callback`;
        this.redirectAllowlist = options.redirectAllowlist ?? DEFAULT_REDIRECT_URIS;
        this.allowLoopback = options.allowLoopbackRedirects ?? true;
        this.cimdHosts = (options.cimdAllowedHosts ?? DEFAULT_CIMD_HOSTS).map((host) => host.toLowerCase());
        this.accessTtlMs = (options.accessTokenTtlSeconds ?? 3600) * 1000;
        this.refreshTtlMs = (options.refreshTokenTtlSeconds ?? 30 * 24 * 3600) * 1000;
        this.maxClients = options.maxRegisteredClients ?? 10_000;
        this.now = options.now ?? Date.now;
        this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
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
            resource_name: "Shopify Multi-Store"
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
        if (this.redirectAllowlist.includes(uri))
            return true;
        return this.allowLoopback && isLoopbackRedirect(uri);
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
            document = await (this.options.fetchClientMetadata ?? fetchMetadataDocument)(clientId);
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
    async googleCallback(url) {
        const loginState = url.searchParams.get("state");
        const pending = loginState ? await this.options.store.take("pending", loginState) : undefined;
        if (!pending)
            return errorPage(400, "This sign-in link expired or was already used. Start again from Claude.");
        const back = (params) => redirect(this.clientRedirect(pending.redirectUri, { ...params, state: pending.clientState }));
        if (url.searchParams.get("error"))
            return back({ error: "access_denied", error_description: "Google sign-in was cancelled or failed." });
        const code = url.searchParams.get("code");
        if (!code)
            return back({ error: "access_denied", error_description: "Google did not return an authorization code." });
        let email;
        try {
            const claims = await this.options.google.exchange({ code, codeVerifier: pending.googleVerifier, redirectUri: this.googleRedirectUri, nonce: pending.nonce });
            const identity = checkGoogleIdentity(claims, this.options.allowedDomains);
            if ("error" in identity) {
                this.log(`Sign-in refused: ${identity.error}`);
                return back({ error: "access_denied", error_description: identity.error });
            }
            email = identity.email;
        }
        catch (error) {
            this.log(`Google sign-in verification failed: ${error instanceof Error ? error.message : String(error)}`);
            return back({ error: "access_denied", error_description: "Google sign-in could not be verified." });
        }
        if (!this.options.policy.current().resolve(email)) {
            this.log(`Sign-in refused: ${email} is not in the access policy.`);
            return back({ error: "access_denied", error_description: `${email} has not been granted access. Ask an administrator.` });
        }
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
        return back({ code: authorizationCode });
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
        if (!this.options.policy.current().resolve(record.email))
            return oauthError("invalid_grant", "The user no longer has access.");
        return this.issueTokens(client, record.email, record.scope, randomUUID());
    }
    async refreshTokenGrant(client, body) {
        const token = body.get("refresh_token");
        if (!token)
            return oauthError("invalid_request", "refresh_token is required.");
        const key = sha256(token);
        const record = await this.options.store.get("refresh", key);
        if (!record)
            return oauthError("invalid_grant", "The refresh token is invalid or expired.");
        if (record.clientId !== client.client_id)
            return oauthError("invalid_grant", "The refresh token was issued to another client.");
        if (record.rotated) {
            // A rotated token came back: assume it leaked and revoke the whole token family.
            await this.revokeFamily(record.familyId);
            this.log(`Refresh token reuse detected for ${record.email}; revoked token family.`);
            return oauthError("invalid_grant", "The refresh token was already used.");
        }
        const resource = body.get("resource");
        if (resource !== null && !this.resourceMatches(resource))
            return oauthError("invalid_target", `This server only issues tokens for ${this.resource}.`);
        if (!this.options.policy.current().resolve(record.email)) {
            await this.revokeFamily(record.familyId);
            return oauthError("invalid_grant", "The user no longer has access.");
        }
        // Rotation: keep the old token only as a reuse tripwire until it would have expired.
        await this.options.store.put("refresh", key, { ...record, rotated: true }, record.expiresAt);
        return this.issueTokens(client, record.email, record.scope, record.familyId);
    }
    async revokeFamily(familyId) {
        await this.options.store.deleteWhere("access", (value) => value.familyId === familyId);
        await this.options.store.deleteWhere("refresh", (value) => value.familyId === familyId);
    }
    async issueTokens(client, email, scope, familyId) {
        const now = this.now();
        const accessToken = secret("sms_at_");
        const access = { clientId: client.client_id, email, scope, resource: this.resource, familyId, expiresAt: now + this.accessTtlMs };
        await this.options.store.put("access", sha256(accessToken), access, access.expiresAt);
        const issueRefresh = client.grant_types.includes("refresh_token");
        let refreshToken;
        if (issueRefresh) {
            refreshToken = secret("sms_rt_");
            const refresh = { ...access, expiresAt: now + this.refreshTtlMs };
            await this.options.store.put("refresh", sha256(refreshToken), refresh, refresh.expiresAt);
        }
        return json({
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: Math.floor(this.accessTtlMs / 1000),
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
/** Fetch a Client ID Metadata Document: HTTPS only, no redirects, short timeout, small body. */
async function fetchMetadataDocument(url) {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > CIMD_MAX_BYTES)
        throw new Error("Document too large.");
    const reader = response.body?.getReader();
    if (!reader)
        throw new Error("Empty response.");
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > CIMD_MAX_BYTES) {
            await reader.cancel();
            throw new Error("Document too large.");
        }
        chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
//# sourceMappingURL=oauth.js.map