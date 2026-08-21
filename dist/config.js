import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
const execFileAsync = promisify(execFile);
const StoreConfigSchema = z.object({
    alias: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
    shop: z.string().min(1),
    apiVersion: z.string().regex(/^\d{4}-\d{2}$/).default("2026-07"),
    tokenEnv: z.string().min(1).optional(),
    baseUrl: z.string().url().optional()
}).strict();
const ConfigSchema = z.object({
    stores: z.array(StoreConfigSchema).min(1)
}).strict();
export function configPath() {
    const configured = process.env.SHOPIFY_MULTI_STORE_CONFIG;
    return configured ? resolve(configured) : resolve(homedir(), ".config", "codex-shopify-multi-store", "stores.json");
}
export async function loadStores() {
    let raw;
    try {
        raw = await readFile(configPath(), "utf8");
    }
    catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
        if (code === "ENOENT") {
            throw new Error(`No Shopify stores are configured. Run \"npm run configure -- add\" in the plugin directory. Config path: ${configPath()}`);
        }
        throw error;
    }
    const parsed = JSON.parse(raw);
    const config = ConfigSchema.parse(parsed);
    const aliases = new Set();
    for (const store of config.stores) {
        if (aliases.has(store.alias)) {
            throw new Error(`Duplicate store alias in ${configPath()}: ${store.alias}`);
        }
        aliases.add(store.alias);
        validateStoreEndpoint(store);
    }
    return config.stores;
}
function validateStoreEndpoint(store) {
    if (store.baseUrl) {
        const url = new URL(store.baseUrl);
        if (url.protocol === "http:" && process.env.SHOPIFY_MULTI_STORE_ALLOW_INSECURE_HTTP === "1")
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
        throw new Error(`Unknown store \"${alias}\". Available stores: ${stores.map((candidate) => candidate.alias).join(", ")}`);
    }
    return store;
}
function defaultTokenEnv(alias) {
    return `SHOPIFY_TOKEN_${alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
export async function getAccessToken(store) {
    const envName = store.tokenEnv ?? defaultTokenEnv(store.alias);
    const envToken = process.env[envName];
    if (envToken)
        return envToken;
    if (process.platform !== "darwin") {
        throw new Error(`No token is available for ${store.alias}. Set ${envName} in the MCP server environment.`);
    }
    try {
        const { stdout } = await execFileAsync("security", [
            "find-generic-password",
            "-s", "codex-shopify-multi-store",
            "-a", store.alias,
            "-w"
        ], { timeout: 10_000, maxBuffer: 64 * 1024 });
        const token = stdout.trim();
        if (!token)
            throw new Error("The Keychain item is empty.");
        return token;
    }
    catch {
        throw new Error(`No macOS Keychain token is available for ${store.alias}. Run \"npm run configure -- add\" in the plugin directory.`);
    }
}
export function graphqlEndpoint(store) {
    if (store.baseUrl)
        return new URL(`/admin/api/${store.apiVersion}/graphql.json`, store.baseUrl).toString();
    return `https://${store.shop}/admin/api/${store.apiVersion}/graphql.json`;
}
//# sourceMappingURL=config.js.map