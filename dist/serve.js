import { readFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import { createHostedApp } from "./hosted/app.js";
import { FileAuditLog } from "./hosted/audit.js";
import { googleLogin } from "./hosted/google.js";
import { toNodeListener } from "./hosted/node-adapter.js";
import { DEFAULT_CIMD_HOSTS, DEFAULT_REDIRECT_URIS } from "./hosted/oauth.js";
import { FilePolicySource } from "./hosted/policy.js";
import { FileStore } from "./hosted/store.js";
import { enableHostedMode } from "./runtime.js";
const FILE_SUFFIX_TARGETS = /^(SHOPIFY_TOKEN_[A-Z0-9_]+|SHOPIFY_CLIENT_SECRET_[A-Z0-9_]+|GOOGLE_CLIENT_SECRET|STORES_JSON)_FILE$/;
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
function positiveInt(env, name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw === "")
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0)
        throw new Error(`${name} must be a positive integer.`);
    return value;
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
    const policy = new FilePolicySource(resolve(required(env, "SHOPIFY_MULTI_STORE_POLICY")));
    const audit = new FileAuditLog(resolve(env.SHOPIFY_MULTI_STORE_AUDIT_LOG ?? `${dataDir}/audit.jsonl`));
    const google = googleLogin({
        clientId: required(env, "GOOGLE_CLIENT_ID"),
        clientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
        ...(allowedDomains.length === 1 ? { hostedDomainHint: allowedDomains[0] } : {})
    });
    const app = createHostedApp({
        issuer: origin,
        resource: `${origin}/mcp`,
        google,
        allowedDomains,
        policy,
        store,
        audit,
        redirectAllowlist: list(env.OAUTH_REDIRECT_URIS) ?? DEFAULT_REDIRECT_URIS,
        allowLoopbackRedirects: env.OAUTH_ALLOW_LOOPBACK_REDIRECTS !== "0",
        cimdAllowedHosts: list(env.OAUTH_CIMD_ALLOWED_HOSTS) ?? DEFAULT_CIMD_HOSTS,
        accessTokenTtlSeconds: positiveInt(env, "OAUTH_ACCESS_TOKEN_TTL_SECONDS", 3600),
        refreshTokenTtlSeconds: positiveInt(env, "OAUTH_REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 3600)
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