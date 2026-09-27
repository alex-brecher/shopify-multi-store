import { readFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import { createHostedApp } from "./hosted/app.js";
import { FileAuditLog } from "./hosted/audit.js";
import { googleLogin } from "./hosted/google.js";
import { toNodeListener } from "./hosted/node-adapter.js";
import { redirectListFromEnv } from "./hosted/known-clients.js";
import { DEFAULT_CIMD_HOSTS, DEFAULT_DISPLAY_NAME } from "./hosted/oauth.js";
import { FilePolicySource, openDomainPolicy } from "./hosted/policy.js";
import { parseEncryptionKeys } from "./hosted/shopify-connect.js";
import { FileStore } from "./hosted/store.js";
import { loadStores } from "./config.js";
import { fullScopes } from "./scope-requirements.js";
import { enableHostedMode } from "./runtime.js";
const FILE_SUFFIX_TARGETS = /^(SHOPIFY_TOKEN_[A-Z0-9_]+|SHOPIFY_CLIENT_SECRET_[A-Z0-9_]+|SHOPIFY_APP_CLIENT_SECRET|SHOPIFY_TOKEN_ENCRYPTION_KEYS?|GOOGLE_CLIENT_SECRET|STORES_JSON)_FILE$/;
/**
 * Support secret mounts: for NAME_FILE=/run/secrets/x, set NAME from the file contents
 * unless NAME is already set. Limited to credential and store-config variables.
 */
export function loadFileSecrets(env = process.env) {
    for (const [key, path] of Object.entries(env)) {
        const match = FILE_SUFFIX_TARGETS.exec(key);
        if (!match || !path)
            continue;
        const target = match[1];
        if (env[target])
            continue;
        env[target] = readFileSync(path, "utf8").trim();
    }
}
function required(env, name) {
    const value = env[name]?.trim();
    if (!value)
        throw new Error(`${name} is required for serve mode. See docs/HOSTED.md.`);
    return value;
}
function list(value) {
    if (value === undefined)
        return undefined;
    return value.split(",").map((item) => item.trim()).filter(Boolean);
}
function flag(value) {
    return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
function positiveInt(env, name, fallback) {
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
function personalTokenMaxDays(env) {
    const days = positiveInt(env, "PERSONAL_TOKEN_MAX_DAYS", 180);
    if (days > 3650)
        throw new Error("PERSONAL_TOKEN_MAX_DAYS must be at most 3650.");
    return days;
}
function accessMode(env) {
    const value = (env.SHOPIFY_ACCESS_MODE ?? "").trim().toLowerCase();
    if (value === "" || value === "per_user")
        return "per_user";
    if (value === "app")
        return "app";
    throw new Error("SHOPIFY_ACCESS_MODE must be per_user or app.");
}
function secretEnvName(alias) {
    return `SHOPIFY_CLIENT_SECRET_${alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
export async function buildHostedAppFromEnv(env = process.env) {
    loadFileSecrets(env);
    const publicUrl = new URL(required(env, "MCP_PUBLIC_URL"));
    if (publicUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(publicUrl.hostname)) {
        throw new Error("MCP_PUBLIC_URL must use https (http is allowed only for localhost testing).");
    }
    if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
        throw new Error("MCP_PUBLIC_URL must be an origin such as https://shopify-mcp.example.com, with no path.");
    }
    const origin = publicUrl.origin;
    const allowedDomains = list(required(env, "ALLOWED_EMAIL_DOMAINS"));
    const dataDir = resolve(env.SHOPIFY_MULTI_STORE_DATA_DIR ?? "data");
    const store = await FileStore.open(resolve(env.SHOPIFY_MULTI_STORE_OAUTH_STORE ?? `${dataDir}/oauth-store.json`));
    const mode = accessMode(env);
    // In per-user mode Shopify enforces each person's permissions, so the policy file is an optional
    // extra restriction. With the shared app token it is the only access control, so it is required.
    const policyPath = env.SHOPIFY_MULTI_STORE_POLICY?.trim();
    const policy = policyPath
        ? new FilePolicySource(resolve(policyPath))
        : mode === "per_user"
            ? openDomainPolicy(allowedDomains)
            : new FilePolicySource(resolve(required(env, "SHOPIFY_MULTI_STORE_POLICY")));
    if (mode === "per_user" && !policyPath) {
        process.stderr.write(`Warning: no SHOPIFY_MULTI_STORE_POLICY file. Every Google Workspace user in ${allowedDomains.join(", ")} can sign in as an editor on every store; ` +
            "Shopify limits each person to their own staff permissions. Set SHOPIFY_MULTI_STORE_POLICY to restrict users, roles, or stores.\n");
    }
    // Refuse to start per-user mode without an encryption key for the stored Shopify tokens.
    const encryptionKeys = mode === "per_user" ? parseEncryptionKeys({ SHOPIFY_TOKEN_ENCRYPTION_KEYS: env.SHOPIFY_TOKEN_ENCRYPTION_KEYS, SHOPIFY_TOKEN_ENCRYPTION_KEY: env.SHOPIFY_TOKEN_ENCRYPTION_KEY }) : undefined;
    const appClientId = env.SHOPIFY_APP_CLIENT_ID?.trim() || undefined;
    const appClientSecret = env.SHOPIFY_APP_CLIENT_SECRET?.trim() || undefined;
    const scopes = list(env.SHOPIFY_APP_SCOPES) ?? fullScopes();
    const audit = new FileAuditLog(resolve(env.SHOPIFY_MULTI_STORE_AUDIT_LOG ?? `${dataDir}/audit.jsonl`));
    const google = googleLogin({
        clientId: required(env, "GOOGLE_CLIENT_ID"),
        clientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
        ...(allowedDomains.length === 1 ? { hostedDomainHint: allowedDomains[0] } : {})
    });
    const app = createHostedApp({
        displayName: displayName(env),
        issuer: origin,
        resource: `${origin}/mcp`,
        google,
        allowedDomains,
        policy,
        store,
        audit,
        // OAUTH_REDIRECT_URIS adds to the built-in known clients; OAUTH_REDIRECT_URIS_REPLACE=1 replaces them.
        redirectAllowlist: redirectListFromEnv(list(env.OAUTH_REDIRECT_URIS), flag(env.OAUTH_REDIRECT_URIS_REPLACE)),
        allowLoopbackRedirects: env.OAUTH_ALLOW_LOOPBACK_REDIRECTS !== "0",
        allowAnyRedirect: flag(env.OAUTH_ALLOW_ANY_REDIRECT),
        cimdAllowedHosts: list(env.OAUTH_CIMD_ALLOWED_HOSTS) ?? DEFAULT_CIMD_HOSTS,
        accessTokenTtlSeconds: positiveInt(env, "OAUTH_ACCESS_TOKEN_TTL_SECONDS", 3600),
        refreshTokenTtlSeconds: positiveInt(env, "OAUTH_REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 3600),
        sessionMaxAgeSeconds: positiveInt(env, "OAUTH_SESSION_MAX_AGE_SECONDS", 7 * 24 * 3600),
        personalTokensEnabled: env.PERSONAL_TOKENS_ENABLED === undefined || env.PERSONAL_TOKENS_ENABLED === "" ? true : flag(env.PERSONAL_TOKENS_ENABLED),
        personalTokenMaxDays: personalTokenMaxDays(env),
        shopifyAccessMode: mode,
        personalTokensShopifyAccess: flag(env.PERSONAL_TOKENS_SHOPIFY_ACCESS),
        ...(encryptionKeys ? {
            shopifyConnect: {
                encryptionKeys,
                loadStores,
                clientId: (store) => (store.auth.type === "client_credentials" ? store.auth.clientId : undefined) ?? appClientId,
                clientSecret: (store) => env[secretEnvName(store.alias)]?.trim() || appClientSecret,
                scopes,
                requireEmailMatch: flag(env.SHOPIFY_REQUIRE_EMAIL_MATCH)
            }
        } : {})
    });
    return {
        app,
        config: { publicUrl: origin, host: env.HOST ?? "0.0.0.0", port: positiveInt(env, "PORT", 8080) }
    };
}
export async function serve(env = process.env) {
    enableHostedMode();
    const { app, config } = await buildHostedAppFromEnv(env);
    const server = http.createServer(toNodeListener(app.fetch, { origin: config.publicUrl, maxBodyBytes: 4 * 1024 * 1024 }));
    server.headersTimeout = 30_000;
    server.requestTimeout = 60_000;
    await new Promise((resolveListen) => server.listen(config.port, config.host, resolveListen));
    process.stderr.write(`shopify-multi-store serving ${config.publicUrl}/mcp on ${config.host}:${config.port}\n`);
    const shutdown = () => {
        server.close();
        void app.close();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    return server;
}
//# sourceMappingURL=serve.js.map