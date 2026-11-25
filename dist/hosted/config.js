import { fullScopes } from "../scope-requirements.js";
import { redirectListFromEnv } from "./known-clients.js";
import { DEFAULT_CIMD_HOSTS, DEFAULT_DISPLAY_NAME } from "./oauth.js";
import { parseEncryptionKeys } from "./shopify-connect.js";
function required(env, name) {
    const value = env[name]?.trim();
    if (!value)
        throw new Error(`${name} is required for the hosted server. See docs/HOSTED.md.`);
    return value;
}
export function list(value) {
    if (value === undefined)
        return undefined;
    return value.split(",").map((item) => item.trim()).filter(Boolean);
}
export function flag(value) {
    return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
export function nonNegativeInt(env, name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw === "")
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0)
        throw new Error(`${name} must be a whole number, 0 or more.`);
    return value;
}
export function positiveInt(env, name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw === "")
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0)
        throw new Error(`${name} must be a positive integer.`);
    return value;
}
function displayName(env) {
    const value = env.SERVER_DISPLAY_NAME?.trim();
    if (!value)
        return DEFAULT_DISPLAY_NAME;
    if (value.length > 100 || /[\u0000-\u001f\u007f]/.test(value))
        throw new Error("SERVER_DISPLAY_NAME must be 1 to 100 characters with no control characters.");
    return value;
}
function aliasEnvSuffix(alias) {
    return alias.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
function secretEnvName(alias) {
    return `SHOPIFY_CLIENT_SECRET_${aliasEnvSuffix(alias)}`;
}
/**
 * A store in another Shopify organization cannot install the main app (a custom app installs only
 * in its own organization), so it gets its own app: SHOPIFY_CLIENT_ID_<ALIAS> with
 * SHOPIFY_CLIENT_SECRET_<ALIAS>.
 */
function clientIdEnvName(alias) {
    return `SHOPIFY_CLIENT_ID_${aliasEnvSuffix(alias)}`;
}
/** MCP_PUBLIC_URL as an origin: https (http only for localhost), no path. */
export function publicOrigin(env) {
    const publicUrl = new URL(required(env, "MCP_PUBLIC_URL"));
    if (publicUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(publicUrl.hostname)) {
        throw new Error("MCP_PUBLIC_URL must use https (http is allowed only for localhost testing).");
    }
    if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
        throw new Error("MCP_PUBLIC_URL must be an origin such as https://shopify-mcp.example.com, with no path.");
    }
    return publicUrl.origin;
}
/**
 * OFFLINE_TOKEN_USERS: comma-separated verified Shopify staff emails (the email each person signs
 * in with, as the audit log's user column shows it), matched without regard to case. These
 * people get Shopify's expiring offline tokens, renewed by the server, instead of 24-hour
 * per-user tokens. Unset or empty: nobody.
 */
export function offlineTokenUsers(env, warn = (message) => console.warn(message)) {
    const users = list(env.OFFLINE_TOKEN_USERS) ?? [];
    // ASCII addresses only, folded with an ASCII-only lower case (no Unicode case folding), so no
    // look-alike or locale-folded address can match someone else's. A bad entry is dropped with one
    // warning; it never stops the server.
    const valid = users.filter((user) => ASCII_EMAIL.test(user));
    const dropped = users.length - valid.length;
    if (dropped)
        warn(`OFFLINE_TOKEN_USERS: ignored ${dropped} ${dropped === 1 ? "entry that is" : "entries that are"} not a plain ASCII email address.`);
    return [...new Set(valid.map(asciiLower))];
}
const ASCII_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
/** Lower-case A-Z only. Other characters are left as they are. */
export function asciiLower(value) {
    return value.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}
/**
 * Everything createHostedApp needs from the settings, for any platform. The caller adds the
 * platform's parts: the OAuth store, the audit log, and (on Node) the DNS-pinned client
 * metadata fetcher. Throws on a missing encryption key or an invalid setting, so a
 * misconfigured server refuses to start.
 */
export async function hostedOptionsFromEnv(env, platform) {
    const origin = publicOrigin(env);
    const encryptionKeys = parseEncryptionKeys({ SHOPIFY_TOKEN_ENCRYPTION_KEYS: env.SHOPIFY_TOKEN_ENCRYPTION_KEYS, SHOPIFY_TOKEN_ENCRYPTION_KEY: env.SHOPIFY_TOKEN_ENCRYPTION_KEY });
    const appClientId = env.SHOPIFY_APP_CLIENT_ID?.trim() || undefined;
    const appClientSecret = env.SHOPIFY_APP_CLIENT_SECRET?.trim() || undefined;
    const scopes = list(env.SHOPIFY_APP_SCOPES) ?? fullScopes();
    const identityStore = env.SHOPIFY_IDENTITY_STORE?.trim() || undefined;
    const offlineUsers = offlineTokenUsers(env);
    if (identityStore && !(await platform.loadStores()).some((store) => store.alias.toLowerCase() === identityStore.toLowerCase())) {
        throw new Error(`SHOPIFY_IDENTITY_STORE names ${identityStore}, which is not a configured store alias.`);
    }
    return {
        displayName: displayName(env),
        issuer: origin,
        resource: `${origin}/mcp`,
        // OAUTH_REDIRECT_URIS adds to the built-in known clients; OAUTH_REDIRECT_URIS_REPLACE=1 replaces them.
        redirectAllowlist: redirectListFromEnv(list(env.OAUTH_REDIRECT_URIS), flag(env.OAUTH_REDIRECT_URIS_REPLACE)),
        allowLoopbackRedirects: env.OAUTH_ALLOW_LOOPBACK_REDIRECTS !== "0",
        allowAnyRedirect: flag(env.OAUTH_ALLOW_ANY_REDIRECT),
        cimdAllowedHosts: list(env.OAUTH_CIMD_ALLOWED_HOSTS) ?? DEFAULT_CIMD_HOSTS,
        accessTokenTtlSeconds: positiveInt(env, "OAUTH_ACCESS_TOKEN_TTL_SECONDS", 3600),
        refreshTokenTtlSeconds: positiveInt(env, "OAUTH_REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 3600),
        sessionMaxAgeSeconds: positiveInt(env, "OAUTH_SESSION_MAX_AGE_SECONDS", 7 * 24 * 3600),
        clientIdleTtlSeconds: positiveInt(env, "OAUTH_CLIENT_IDLE_TTL_SECONDS", 30 * 24 * 3600),
        maxRegistrationsPerSourcePerHour: nonNegativeInt(env, "OAUTH_MAX_REGISTRATIONS_PER_SOURCE_PER_HOUR", 30),
        shopifyConnect: {
            encryptionKeys,
            loadStores: platform.loadStores,
            clientId: (store) => env[clientIdEnvName(store.alias)]?.trim() || (store.auth.type === "client_credentials" ? store.auth.clientId : undefined) || appClientId,
            clientSecret: (store) => env[secretEnvName(store.alias)]?.trim() || appClientSecret,
            scopes,
            ...(identityStore ? { identityStore } : {}),
            ...(offlineUsers.length ? { offlineTokenUsers: offlineUsers } : {})
        }
    };
}
//# sourceMappingURL=config.js.map