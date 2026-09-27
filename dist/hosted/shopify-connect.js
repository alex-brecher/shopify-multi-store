import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookie, escapeHtml, htmlPage, readCookie, sameOrigin } from "./html.js";
import { PAGE_SIGN_IN_CLIENT, sha256 } from "./oauth.js";
/**
 * Per-user Shopify access (SHOPIFY_ACCESS_MODE=per_user).
 *
 * Each signed-in person connects each store with their own Shopify staff account through
 * Shopify's authorization-code flow in online access mode. The resulting online token carries
 * that person's Shopify permissions, so Shopify decides what every tool call may do.
 * Tokens are encrypted at rest with AES-256-GCM and never leave the server.
 */
const SESSION_COOKIE = "__Host-sms_stores";
const SESSION_TTL_MS = 30 * 60_000;
const STATE_TTL_MS = 10 * 60_000;
/** Keep an expired token record this long so /stores can say "Expired" rather than "Not connected". */
const EXPIRED_RECORD_GRACE_MS = 30 * 24 * 3600_000;
const TOKEN_FORMAT = "v1";
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
// ---------- Encryption ----------
/** Parse SHOPIFY_TOKEN_ENCRYPTION_KEY: 32 bytes, base64 or base64url. */
export function parseEncryptionKey(value) {
    const text = value?.trim() ?? "";
    const key = Buffer.from(text, text.includes("-") || text.includes("_") ? "base64url" : "base64");
    if (!text || key.length !== 32) {
        throw new Error("SHOPIFY_TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64 encoded (for example: openssl rand -base64 32).");
    }
    return key;
}
function tokenAad(email, alias, shop) {
    // Binds the ciphertext to its record, so a token cannot be moved to another user or store.
    return Buffer.from(`${TOKEN_FORMAT}\0${email}\0${alias.toLowerCase()}\0${shop}`);
}
export function encryptToken(key, token, binding) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(tokenAad(binding.email, binding.alias, binding.shop));
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return [TOKEN_FORMAT, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
export function decryptToken(key, value, binding) {
    const [format, iv, tag, ciphertext] = value.split(".");
    if (format !== TOKEN_FORMAT || !iv || !tag || ciphertext === undefined)
        throw new Error("Unknown encrypted token format.");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(tokenAad(binding.email, binding.alias, binding.shop));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
// ---------- Shopify request signatures ----------
/**
 * Verify the hmac Shopify adds to OAuth redirects: hex HMAC-SHA256, keyed with the app's client
 * secret, over every other query parameter sorted by name and joined as name=value with "&".
 */
export function verifyShopifyHmac(params, secret) {
    const received = params.get("hmac") ?? "";
    if (!/^[0-9a-f]{64}$/i.test(received) || !secret)
        return false;
    const message = [...params.entries()]
        .filter(([name]) => name !== "hmac" && name !== "signature")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, value]) => `${name}=${value}`)
        .join("&");
    const expected = createHmac("sha256", secret).update(message).digest("hex");
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received.toLowerCase(), "hex"));
}
function tokenKey(email, alias) {
    return sha256(`shopify\0${email}\0${alias.toLowerCase()}`);
}
function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
function formatTime(ms) {
    return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
function page(status, title, message) {
    return htmlPage({ status, title, body: `<div class="card"><h1>${escapeHtml(title)}</h1><p>${message}</p><p><a href="/stores">Back to your stores</a></p></div>` });
}
function redirect(location, headers = {}) {
    return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });
}
export class ShopifyConnections {
    options;
    now;
    fetcher;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.fetcher = options.fetch ?? fetch;
    }
    get storesUrl() {
        return `${this.options.auth.issuer}/stores`;
    }
    connectUrl(alias) {
        return `${this.options.auth.issuer}/shopify/connect?store=${encodeURIComponent(alias)}`;
    }
    // ---------- Per-request access ----------
    /** The caller's decrypted tokens for every store, for one MCP request. */
    async accessFor(email) {
        const tokens = new Map();
        for (const store of await this.options.loadStores()) {
            const record = await this.options.store.get("shopify_token", tokenKey(email, store.alias));
            if (!record || record.shop !== store.shop)
                continue;
            try {
                const token = decryptToken(this.options.encryptionKey, record.encryptedToken, { email, alias: store.alias, shop: store.shop });
                tokens.set(store.alias.toLowerCase(), { token, expiresAt: record.expiresAt, ...(record.associatedUser.email ? { shopifyEmail: record.associatedUser.email } : {}) });
            }
            catch {
                // A rotated encryption key or a tampered record reads as "not connected".
                process.stderr.write(`Stored Shopify token for ${store.alias} could not be decrypted; the user must reconnect.\n`);
            }
        }
        return { tokens, storesUrl: this.storesUrl, connectUrl: (alias) => this.connectUrl(alias), now: this.now };
    }
    // ---------- Sign-in and session ----------
    async signedIn(email) {
        const value = randomBytes(32).toString("base64url");
        await this.options.store.put("session", sha256(value), { email, purpose: "stores" }, this.now() + SESSION_TTL_MS);
        await this.options.auth.auditAuth({ event: "sign_in", user: email, clientId: PAGE_SIGN_IN_CLIENT, reason: "stores page" });
        return redirect("/stores", { "set-cookie": cookie(SESSION_COOKIE, value, SESSION_TTL_MS / 1000) });
    }
    async session(request) {
        const value = readCookie(request, SESSION_COOKIE);
        if (!value || value.length > 100)
            return undefined;
        const key = sha256(value);
        const record = await this.options.store.get("session", key);
        if (!record || record.purpose !== "stores")
            return undefined;
        const principal = this.options.policy.current().resolve(record.email);
        if (!principal) {
            await this.options.store.delete("session", key);
            return undefined;
        }
        return { key, email: record.email, principal, csrf: sha256(`csrf:${value}`) };
    }
    async visibleStores(principal) {
        const stores = await this.options.loadStores();
        if (principal.stores === "*")
            return stores;
        const allowed = new Set(principal.stores.map((alias) => alias.toLowerCase()));
        return stores.filter((store) => allowed.has(store.alias.toLowerCase()));
    }
    async record(email, store) {
        const record = await this.options.store.get("shopify_token", tokenKey(email, store.alias));
        return record && record.shop === store.shop ? record : undefined;
    }
    async nextUnconnected(session) {
        for (const store of await this.visibleStores(session.principal)) {
            const record = await this.record(session.email, store);
            if (!record || record.expiresAt <= this.now())
                return store;
        }
        return undefined;
    }
    // ---------- /stores ----------
    async handleStoresPage(request) {
        const method = request.method.toUpperCase();
        if (method === "GET") {
            const session = await this.session(request);
            if (!session)
                return this.options.auth.startPageSignIn("stores");
            return this.render(session);
        }
        if (method === "POST")
            return this.action(request);
        return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
    }
    async render(session, message, status = 200) {
        const displayName = this.options.auth.displayName;
        const stores = await this.visibleStores(session.principal);
        const csrfField = `<input type="hidden" name="csrf" value="${session.csrf}">`;
        const now = this.now();
        let unconnected = 0;
        const rows = [];
        for (const store of stores) {
            const record = await this.record(session.email, store);
            const live = record && record.expiresAt > now;
            if (!live)
                unconnected += 1;
            const user = record?.associatedUser;
            const who = user ? `${escapeHtml(user.email ?? `Shopify user ${user.id}`)}${user.accountOwner ? " (store owner)" : ""}${user.collaborator ? " (collaborator)" : ""}` : "";
            const statusText = !record
                ? "Not connected"
                : live
                    ? `Connected as ${who}<br><span class="muted">Expires ${formatTime(record.expiresAt)}</span>`
                    : `Expired<br><span class="muted">Was ${who}, expired ${formatTime(record.expiresAt)}</span>`;
            const connect = `<a href="/shopify/connect?store=${encodeURIComponent(store.alias)}">${record ? "Reconnect" : "Connect"}</a>`;
            const disconnect = record
                ? ` <form class="inline" method="post" action="/stores">${csrfField}<input type="hidden" name="action" value="disconnect"><input type="hidden" name="store" value="${escapeHtml(store.alias)}"><button class="danger" type="submit">Disconnect</button></form>`
                : "";
            rows.push(`<tr><td>${escapeHtml(store.alias)}<br><code class="muted">${escapeHtml(store.shop)}</code></td><td>${statusText}</td><td>${connect}${disconnect}</td></tr>`);
        }
        const first = unconnected ? await this.nextUnconnected(session) : undefined;
        const body = `<div class="card">
<h1>Your Shopify stores</h1>
<p class="muted">${escapeHtml(displayName)} - signed in with Google as ${escapeHtml(session.email)}</p>
<p>Connect each store with your own Shopify staff account. AI apps then act as you in that store, and Shopify allows only what your staff permissions allow. Shopify ends these connections after about a day; reconnecting takes one click while you are signed in to Shopify.</p>
${message ? `<div class="warn"><p>${escapeHtml(message)}</p></div>` : ""}
${stores.length ? `<table><thead><tr><th>Store</th><th>Status</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>` : `<p class="muted">No stores are configured for you.</p>`}
${first ? `<p class="actions"><a href="/shopify/connect?store=${encodeURIComponent(first.alias)}&amp;chain=1">Connect all ${unconnected} unconnected ${unconnected === 1 ? "store" : "stores"}</a></p>` : ""}
<form method="post" action="/stores">${csrfField}<input type="hidden" name="action" value="signout"><div class="actions"><button type="submit">Sign out</button></div></form>
</div>`;
        return htmlPage({ status, title: `Your Shopify stores - ${displayName}`, body });
    }
    async action(request) {
        if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
            return htmlPage({ status: 400, title: "Bad request", body: `<div class="card"><p>Unsupported form submission.</p></div>` });
        }
        if (!sameOrigin(request, this.options.auth.issuer)) {
            return htmlPage({ status: 403, title: "Forbidden", body: `<div class="card"><p>This form was submitted from another site.</p></div>` });
        }
        const session = await this.session(request);
        if (!session)
            return page(401, "Signed out", `Your session ended. <a href="/stores">Sign in again</a>.`);
        const form = new URLSearchParams(await request.text());
        if (!safeEqual(form.get("csrf") ?? "", session.csrf)) {
            return page(403, "Forbidden", `This form could not be verified. Reload the page and try again.`);
        }
        const action = form.get("action");
        if (action === "signout") {
            await this.options.store.delete("session", session.key);
            return htmlPage({ title: "Signed out", body: `<div class="card"><h1>Signed out</h1><p><a href="/stores">Sign in again</a>.</p></div>`, headers: { "set-cookie": cookie(SESSION_COOKIE, "", 0) } });
        }
        if (action === "disconnect") {
            const alias = form.get("store") ?? "";
            const store = (await this.visibleStores(session.principal)).find((candidate) => candidate.alias.toLowerCase() === alias.toLowerCase());
            if (!store)
                return this.render(session, "That store was not found.", 404);
            await this.options.store.delete("shopify_token", tokenKey(session.email, store.alias));
            await this.options.auth.auditAuth({ event: "shopify_disconnected", user: session.email, store: store.alias });
            return redirect("/stores");
        }
        return this.render(session, "Unknown action.", 400);
    }
    // ---------- /shopify/connect ----------
    async connect(request) {
        if (request.method.toUpperCase() !== "GET")
            return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
        const url = new URL(request.url);
        const session = await this.session(request);
        if (!session)
            return this.options.auth.startPageSignIn("stores");
        const alias = url.searchParams.get("store") ?? "";
        const store = (await this.visibleStores(session.principal)).find((candidate) => candidate.alias.toLowerCase() === alias.toLowerCase());
        if (!store)
            return this.render(session, `Store "${alias}" is not configured, or you are not allowed to use it.`, 404);
        if (!SHOP_HOST.test(store.shop))
            return this.render(session, `Store ${store.alias} does not use a *.myshopify.com domain, so it cannot be connected.`, 400);
        const clientId = this.options.clientId(store);
        if (!clientId || !this.options.clientSecret(store)) {
            return this.render(session, `Store ${store.alias} has no Shopify app client id and secret on this server. Ask an administrator to set SHOPIFY_APP_CLIENT_ID and SHOPIFY_APP_CLIENT_SECRET.`, 500);
        }
        const state = randomBytes(32).toString("base64url");
        const record = { email: session.email, alias: store.alias, shop: store.shop, sessionSha256: session.key, chain: url.searchParams.get("chain") === "1" };
        await this.options.store.put("shopify_state", sha256(state), record, this.now() + STATE_TTL_MS);
        const target = new URL(`https://${store.shop}/admin/oauth/authorize`);
        target.searchParams.set("client_id", clientId);
        target.searchParams.set("scope", this.options.scopes.join(","));
        target.searchParams.set("redirect_uri", `${this.options.auth.issuer}/shopify/callback`);
        target.searchParams.set("state", state);
        target.searchParams.append("grant_options[]", "per-user");
        return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
    }
    // ---------- /shopify/callback ----------
    async callback(request) {
        if (request.method.toUpperCase() !== "GET")
            return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
        const url = new URL(request.url);
        const params = url.searchParams;
        const shop = (params.get("shop") ?? "").toLowerCase();
        const stores = await this.options.loadStores();
        // The shop must be a configured store. Its secret verifies the signature.
        const store = SHOP_HOST.test(shop) ? stores.find((candidate) => candidate.shop.toLowerCase() === shop) : undefined;
        const secret = store ? this.options.clientSecret(store) : undefined;
        if (!store || !secret || !verifyShopifyHmac(params, secret)) {
            await this.options.auth.auditAuth({ event: "shopify_connect_denied", reason: "invalid Shopify signature or unknown shop", ...(store ? { store: store.alias } : {}) });
            return page(400, "Connection failed", "Shopify's response could not be verified. Start again from the stores page.");
        }
        const stateValue = params.get("state") ?? "";
        const state = stateValue ? await this.options.store.take("shopify_state", sha256(stateValue)) : undefined;
        const session = await this.session(request);
        if (!state || !session || !safeEqual(state.sessionSha256, session.key) || state.email !== session.email) {
            await this.options.auth.auditAuth({ event: "shopify_connect_denied", store: store.alias, reason: "missing, expired, reused, or foreign state", ...(session ? { user: session.email } : {}) });
            return page(400, "Connection failed", "This connection link expired, was already used, or was started in another browser. Start again from the stores page.");
        }
        if (state.shop !== store.shop || state.alias.toLowerCase() !== store.alias.toLowerCase()) {
            await this.options.auth.auditAuth({ event: "shopify_connect_denied", user: session.email, store: store.alias, reason: "shop does not match the store being connected" });
            return page(400, "Connection failed", "Shopify returned a different store than the one you were connecting.");
        }
        if (!(await this.visibleStores(session.principal)).some((candidate) => candidate.alias === store.alias)) {
            return page(403, "Connection failed", "You are not allowed to use this store.");
        }
        const code = params.get("code");
        if (!code)
            return page(400, "Connection failed", "Shopify did not return an authorization code.");
        let payload;
        try {
            const response = await this.fetcher(`https://${store.shop}/admin/oauth/access_token`, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "application/json" },
                body: JSON.stringify({ client_id: this.options.clientId(store), client_secret: secret, code }),
                redirect: "error",
                signal: AbortSignal.timeout(15_000)
            });
            payload = await response.json().catch(() => ({}));
            if (!response.ok || typeof payload.access_token !== "string")
                throw new Error(`HTTP ${response.status}`);
        }
        catch (error) {
            await this.options.auth.auditAuth({ event: "shopify_connect_denied", user: session.email, store: store.alias, reason: `token exchange failed: ${error instanceof Error ? error.message : String(error)}` });
            return page(502, "Connection failed", "Shopify did not issue a token. Try again.");
        }
        // Only an online token carries the person's own permissions. An offline token would act as the app.
        const rawUser = payload.associated_user;
        if (!rawUser || (typeof rawUser.id !== "number" && typeof rawUser.id !== "string") || typeof payload.expires_in !== "number") {
            await this.options.auth.auditAuth({ event: "shopify_connect_denied", user: session.email, store: store.alias, reason: "Shopify returned an offline token" });
            return page(502, "Connection failed", "Shopify returned an app-level token instead of a per-user token. It was discarded.");
        }
        const associatedUser = {
            id: String(rawUser.id),
            ...(typeof rawUser.email === "string" ? { email: rawUser.email.toLowerCase() } : {}),
            ...(typeof rawUser.first_name === "string" ? { firstName: rawUser.first_name } : {}),
            ...(typeof rawUser.last_name === "string" ? { lastName: rawUser.last_name } : {}),
            ...(typeof rawUser.account_owner === "boolean" ? { accountOwner: rawUser.account_owner } : {}),
            ...(typeof rawUser.collaborator === "boolean" ? { collaborator: rawUser.collaborator } : {}),
            ...(typeof rawUser.email_verified === "boolean" ? { emailVerified: rawUser.email_verified } : {})
        };
        if (this.options.requireEmailMatch && associatedUser.email !== session.email) {
            await this.options.auth.auditAuth({ event: "shopify_connect_denied", user: session.email, store: store.alias, shopifyUserId: associatedUser.id, ...(associatedUser.email ? { shopifyEmail: associatedUser.email } : {}), reason: "Shopify email does not match Google email" });
            return page(403, "Connection refused", `This server requires your Shopify staff email to match your Google email (${escapeHtml(session.email)}). Shopify reported ${escapeHtml(associatedUser.email ?? "no email")}. Sign in to Shopify with the matching account and try again.`);
        }
        const now = this.now();
        const expiresAt = now + payload.expires_in * 1000;
        const record = {
            email: session.email,
            alias: store.alias,
            shop: store.shop,
            encryptedToken: encryptToken(this.options.encryptionKey, payload.access_token, { email: session.email, alias: store.alias, shop: store.shop }),
            scope: typeof payload.scope === "string" ? payload.scope : "",
            associatedUserScope: typeof payload.associated_user_scope === "string" ? payload.associated_user_scope : "",
            associatedUser,
            connectedAt: now,
            expiresAt
        };
        await this.options.store.put("shopify_token", tokenKey(session.email, store.alias), record, expiresAt + EXPIRED_RECORD_GRACE_MS);
        await this.options.auth.auditAuth({ event: "shopify_connected", user: session.email, store: store.alias, shopifyUserId: associatedUser.id, ...(associatedUser.email ? { shopifyEmail: associatedUser.email } : {}), reason: `expires ${new Date(expiresAt).toISOString()}` });
        if (state.chain) {
            const next = await this.nextUnconnected(session);
            if (next)
                return redirect(`/shopify/connect?store=${encodeURIComponent(next.alias)}&chain=1`);
        }
        return redirect("/stores");
    }
}
//# sourceMappingURL=shopify-connect.js.map