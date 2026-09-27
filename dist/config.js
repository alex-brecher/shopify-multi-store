import { previewStores } from "./previews.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { DEFAULT_API_VERSION } from "./constants.js";
import { connectionStatus, currentUserAccess, isHostedMode, notConnectedMessage, runtimeEnv, storeAllowed } from "./runtime.js";
/**
 * The OS keychain (cross-keychain) is loaded only on the local stdio path, when a credential
 * is actually read, so a hosted server or a Worker never loads it.
 */
async function keychain() {
    return import("./credentials.js");
}
const AccessTokenAuthSchema = z.object({
    type: z.literal("access_token")
}).strict();
const ClientCredentialsAuthSchema = z.object({
    type: z.literal("client_credentials"),
    clientId: z.string().min(1)
}).strict();
const StoreAuthSchema = z.discriminatedUnion("type", [AccessTokenAuthSchema, ClientCredentialsAuthSchema, z.object({ type: z.literal("shopify_cli") }).strict()]);
const StoreConfigSchema = z.object({
    alias: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
    shop: z.string().min(1),
    apiVersion: z.string().regex(/^\d{4}-\d{2}$/).default(DEFAULT_API_VERSION),
    auth: StoreAuthSchema.default({ type: "access_token" }),
    tokenEnv: z.string().min(1).optional(),
    baseUrl: z.string().url().optional()
}).strict();
const ConfigSchema = z.object({
    stores: z.array(StoreConfigSchema).min(1)
}).strict();
const oauthTokenCache = new Map();
const oauthTokenRequests = new Map();
export function configPath() {
    const configured = runtimeEnv().SHOPIFY_MULTI_STORE_CONFIG;
    return configured ? resolve(configured) : resolve(homedir(), ".config", "codex-shopify-multi-store", "stores.json");
}
export async function loadStores() {
    const stores = await allowedStores();
    // Per-user mode: only stores the caller has a live Shopify token for. Outside a hosted
    // per-user tool call this is a no-op.
    const access = currentUserAccess();
    return access ? stores.filter((store) => connectionStatus(access, store.alias) === "connected") : stores;
}
/** Configured stores the caller may use, before the per-user connection filter. */
async function allowedStores() {
    const stores = await loadAllStores();
    // Hosted mode: restrict to the caller's allowlist. Outside a hosted tool call this is a no-op.
    return stores.filter((store) => storeAllowed(store.alias));
}
/**
 * Per-user mode: allowed stores the caller has not connected, or whose token expired, with the
 * URL that connects each. Empty outside per-user mode.
 */
export async function unconnectedStores() {
    const access = currentUserAccess();
    if (!access)
        return [];
    const result = [];
    for (const store of await allowedStores()) {
        const status = connectionStatus(access, store.alias);
        if (status !== "connected")
            result.push({ alias: store.alias, status, connectUrl: access.connectUrl(store.alias) });
    }
    return result;
}
async function loadAllStores() {
    const hosted = isHostedMode();
    let raw;
    let source;
    const storesJson = runtimeEnv().STORES_JSON;
    if (storesJson) {
        raw = storesJson;
        source = "STORES_JSON";
    }
    else {
        source = configPath();
        try {
            raw = await readFile(configPath(), "utf8");
        }
        catch (error) {
            const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
            if (code === "ENOENT") {
                if (!hosted) {
                    const previews = await previewStores();
                    if (previews.length)
                        return previews;
                }
                throw new Error(`No Shopify stores are configured. Run \"npm run configure -- add\" in the plugin directory. Config path: ${configPath()}`);
            }
            throw error;
        }
    }
    const parsed = JSON.parse(raw);
    const config = ConfigSchema.parse(parsed);
    // Preview stores are created with the local Shopify CLI and never exist on a hosted server.
    if (!hosted)
        config.stores.push(...await previewStores());
    const aliases = new Set();
    for (const store of config.stores) {
        if (aliases.has(store.alias)) {
            throw new Error(`Duplicate store alias in ${source}: ${store.alias}`);
        }
        if (hosted && store.auth.type === "shopify_cli") {
            throw new Error(`Store ${store.alias} uses Shopify CLI auth, which is not available on a hosted server.`);
        }
        aliases.add(store.alias);
        validateStoreEndpoint(store);
    }
    // Hosted: two aliases for one shop would make multi-store tools act on it twice and split
    // its access control across two names. Refuse the configuration.
    const duplicate = hosted ? duplicateShopError(config.stores) : undefined;
    if (duplicate)
        throw new Error(`${duplicate} Each shop may be configured once in ${source}.`);
    return config.stores;
}
function shopIdentity(store) {
    return store.shop.trim().toLowerCase();
}
/** Names the first two aliases that point to the same shop, or undefined when every shop is distinct. */
export function duplicateShopError(stores) {
    const seen = new Map();
    for (const store of stores) {
        const key = shopIdentity(store);
        const first = seen.get(key);
        if (first !== undefined)
            return `Store aliases "${first}" and "${store.alias}" both point to ${store.shop}.`;
        seen.set(key, store.alias);
    }
    return undefined;
}
/**
 * Resolve the stores a multi-store tool should act on. Requested aliases are matched without
 * case and deduplicated; unknown aliases come back with an error for that entry. Two requested
 * aliases that point to the same shop are refused, naming both, so no action runs twice on one
 * shop. With no aliases, every configured store is used once per shop.
 */
export async function resolveStoreTargets(aliases) {
    const configured = await loadStores();
    if (!aliases?.length) {
        const seen = new Set();
        return configured
            .filter((store) => !seen.has(shopIdentity(store)) && Boolean(seen.add(shopIdentity(store))))
            .map((store) => ({ requestedAlias: store.alias, store }));
    }
    const byAlias = new Map(configured.map((store) => [store.alias.toLowerCase(), store]));
    const requested = aliases.filter((alias, index) => aliases.findIndex((candidate) => candidate.toLowerCase() === alias.toLowerCase()) === index);
    const targets = requested.map((alias) => {
        const store = byAlias.get(alias.toLowerCase());
        return store
            ? { requestedAlias: alias, store }
            : { requestedAlias: alias, error: `Unknown store "${alias}". Available stores: ${configured.map((item) => item.alias).join(", ")}` };
    });
    const duplicate = duplicateShopError(targets.flatMap((target) => (target.store ? [target.store] : [])));
    if (duplicate)
        throw new Error(`${duplicate} Request each shop once.`);
    return targets;
}
function validateStoreEndpoint(store) {
    if (store.baseUrl) {
        const url = new URL(store.baseUrl);
        if (url.protocol === "http:" && runtimeEnv().SHOPIFY_MULTI_STORE_ALLOW_INSECURE_HTTP === "1")
            return;
        if (url.protocol !== "https:")
            throw new Error(`Store ${store.alias} must use HTTPS.`);
        return;
    }
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(store.shop)) {
        throw new Error(`Store ${store.alias} must use its permanent *.myshopify.com domain.`);
    }
}
export async function findStore(alias) {
    const stores = await loadStores();
    const store = stores.find((candidate) => candidate.alias.toLowerCase() === alias.toLowerCase());
    if (!store) {
        const access = currentUserAccess();
        if (access) {
            const configured = (await allowedStores()).find((candidate) => candidate.alias.toLowerCase() === alias.toLowerCase());
            if (configured)
                throw new Error(notConnectedMessage(access, configured.alias));
        }
        throw new Error(`Unknown store \"${alias}\". Available stores: ${stores.map((candidate) => candidate.alias).join(", ")}`);
    }
    return store;
}
function defaultTokenEnv(alias) {
    return `SHOPIFY_TOKEN_${alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
export async function getAccessToken(store) {
    // Per-user mode: the caller's own online token, never the app token.
    const access = currentUserAccess();
    if (access) {
        const token = access.tokens.get(store.alias.toLowerCase());
        if (token && token.expiresAt > access.now())
            return token.token;
        throw new Error(notConnectedMessage(access, store.alias));
    }
    // Hosted: only the caller's own Shopify token, never a static or app-level credential.
    if (isHostedMode())
        throw new Error(`No Shopify connection for ${store.alias}. Sign in with Shopify on the hosted server first.`);
    const envName = store.tokenEnv ?? defaultTokenEnv(store.alias);
    const envToken = process.env[envName];
    if (envToken)
        return envToken;
    if (store.auth.type === "client_credentials") {
        return getClientCredentialsToken(store);
    }
    const { accessTokenAccount, readCredential } = await keychain();
    const token = await readCredential(accessTokenAccount(store.alias));
    if (token)
        return token;
    throw new Error(`No operating-system credential is available for ${store.alias}. Set ${envName} or run \"shopify-multi-store setup\".`);
}
async function getClientCredentialsToken(store) {
    if (store.auth.type !== "client_credentials")
        throw new Error("Client credentials are not configured.");
    const secretEnv = `SHOPIFY_CLIENT_SECRET_${store.alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    let clientSecret = process.env[secretEnv];
    if (!clientSecret) {
        const { clientSecretAccount, readCredential } = await keychain();
        clientSecret = await readCredential(clientSecretAccount(store.alias));
    }
    if (!clientSecret) {
        throw new Error(`No OAuth client secret is available for ${store.alias}. Set ${secretEnv} or reconnect the store.`);
    }
    const secretFingerprint = createHash("sha256").update(clientSecret).digest("hex");
    const cacheKey = `${store.alias}\0${store.shop}\0${store.auth.clientId}\0${secretFingerprint}`;
    const cached = oauthTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 5 * 60_000)
        return cached.token;
    const pending = oauthTokenRequests.get(cacheKey);
    if (pending)
        return pending;
    const request = requestClientCredentialsToken(store, clientSecret, cacheKey);
    oauthTokenRequests.set(cacheKey, request);
    try {
        return await request;
    }
    finally {
        if (oauthTokenRequests.get(cacheKey) === request)
            oauthTokenRequests.delete(cacheKey);
    }
}
async function requestClientCredentialsToken(store, clientSecret, cacheKey) {
    if (store.auth.type !== "client_credentials")
        throw new Error("Client credentials are not configured.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response;
    let responseText;
    try {
        response = await fetch(`https://${store.shop}/admin/oauth/access_token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: store.auth.clientId,
                client_secret: clientSecret
            }),
            signal: controller.signal
        });
        responseText = await response.text();
    }
    catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Shopify OAuth did not respond within 30 seconds for ${store.alias}.`);
        }
        throw new Error(`Shopify OAuth request failed for ${store.alias}: ${error instanceof Error ? error.message : String(error)}`);
    }
    finally {
        clearTimeout(timeout);
    }
    let payload;
    try {
        const parsed = JSON.parse(responseText);
        payload = parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        throw new Error(`Shopify OAuth returned a non-JSON response for ${store.alias}. HTTP ${response.status}.`);
    }
    if (!response.ok || typeof payload.access_token !== "string") {
        const error = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
        const description = typeof payload.error_description === "string" ? `: ${payload.error_description}` : "";
        throw new Error(`Shopify OAuth failed for ${store.alias}: ${error}${description}`);
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 86_399;
    for (const key of oauthTokenCache.keys()) {
        if (key.startsWith(`${store.alias}\0`) && key !== cacheKey)
            oauthTokenCache.delete(key);
    }
    oauthTokenCache.set(cacheKey, {
        token: payload.access_token,
        expiresAt: Date.now() + expiresIn * 1_000
    });
    return payload.access_token;
}
export function graphqlEndpoint(store) {
    if (store.baseUrl)
        return new URL(`/admin/api/${store.apiVersion}/graphql.json`, store.baseUrl).toString();
    return `https://${store.shop}/admin/api/${store.apiVersion}/graphql.json`;
}
//# sourceMappingURL=config.js.map