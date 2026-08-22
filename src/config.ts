import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { DEFAULT_API_VERSION } from "./constants.js";
import { accessTokenAccount, clientSecretAccount, readCredential } from "./credentials.js";

const AccessTokenAuthSchema = z.object({
  type: z.literal("access_token")
}).strict();

const ClientCredentialsAuthSchema = z.object({
  type: z.literal("client_credentials"),
  clientId: z.string().min(1)
}).strict();

const StoreAuthSchema = z.discriminatedUnion("type", [AccessTokenAuthSchema, ClientCredentialsAuthSchema]);

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

export type StoreConfig = z.infer<typeof StoreConfigSchema>;

const oauthTokenCache = new Map<string, { token: string; expiresAt: number }>();
const oauthTokenRequests = new Map<string, Promise<string>>();

export function configPath(): string {
  const configured = process.env.SHOPIFY_MULTI_STORE_CONFIG;
  return configured ? resolve(configured) : resolve(homedir(), ".config", "codex-shopify-multi-store", "stores.json");
}

export async function loadStores(): Promise<StoreConfig[]> {
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    if (code === "ENOENT") {
      throw new Error(`No Shopify stores are configured. Run \"npm run configure -- add\" in the plugin directory. Config path: ${configPath()}`);
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  const config = ConfigSchema.parse(parsed);
  const aliases = new Set<string>();
  for (const store of config.stores) {
    if (aliases.has(store.alias)) {
      throw new Error(`Duplicate store alias in ${configPath()}: ${store.alias}`);
    }
    aliases.add(store.alias);
    validateStoreEndpoint(store);
  }
  return config.stores;
}

function validateStoreEndpoint(store: StoreConfig): void {
  if (store.baseUrl) {
    const url = new URL(store.baseUrl);
    if (url.protocol === "http:" && process.env.SHOPIFY_MULTI_STORE_ALLOW_INSECURE_HTTP === "1") return;
    if (url.protocol !== "https:") throw new Error(`Store ${store.alias} must use HTTPS.`);
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(store.shop)) {
    throw new Error(`Store ${store.alias} must use its permanent *.myshopify.com domain.`);
  }
}

export async function findStore(alias: string): Promise<StoreConfig> {
  const stores = await loadStores();
  const store = stores.find((candidate) => candidate.alias.toLowerCase() === alias.toLowerCase());
  if (!store) {
    throw new Error(`Unknown store \"${alias}\". Available stores: ${stores.map((candidate) => candidate.alias).join(", ")}`);
  }
  return store;
}

function defaultTokenEnv(alias: string): string {
  return `SHOPIFY_TOKEN_${alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export async function getAccessToken(store: StoreConfig): Promise<string> {
  const envName = store.tokenEnv ?? defaultTokenEnv(store.alias);
  const envToken = process.env[envName];
  if (envToken) return envToken;

  if (store.auth.type === "client_credentials") {
    return getClientCredentialsToken(store);
  }

  const token = await readCredential(accessTokenAccount(store.alias));
  if (token) return token;
  throw new Error(`No operating-system credential is available for ${store.alias}. Set ${envName} or run \"shopify-multi-store setup\".`);
}

async function getClientCredentialsToken(store: StoreConfig): Promise<string> {
  if (store.auth.type !== "client_credentials") throw new Error("Client credentials are not configured.");
  const secretEnv = `SHOPIFY_CLIENT_SECRET_${store.alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const clientSecret = process.env[secretEnv] ?? await readCredential(clientSecretAccount(store.alias));
  if (!clientSecret) {
    throw new Error(`No OAuth client secret is available for ${store.alias}. Set ${secretEnv} or reconnect the store.`);
  }
  const secretFingerprint = createHash("sha256").update(clientSecret).digest("hex");
  const cacheKey = `${store.alias}\0${store.shop}\0${store.auth.clientId}\0${secretFingerprint}`;
  const cached = oauthTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;

  const pending = oauthTokenRequests.get(cacheKey);
  if (pending) return pending;

  const request = requestClientCredentialsToken(store, clientSecret, cacheKey);
  oauthTokenRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (oauthTokenRequests.get(cacheKey) === request) oauthTokenRequests.delete(cacheKey);
  }
}

async function requestClientCredentialsToken(store: StoreConfig, clientSecret: string, cacheKey: string): Promise<string> {
  if (store.auth.type !== "client_credentials") throw new Error("Client credentials are not configured.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
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
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Shopify OAuth did not respond within 30 seconds for ${store.alias}.`);
    }
    throw new Error(`Shopify OAuth request failed for ${store.alias}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(responseText);
    payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    throw new Error(`Shopify OAuth returned a non-JSON response for ${store.alias}. HTTP ${response.status}.`);
  }
  if (!response.ok || typeof payload.access_token !== "string") {
    const error = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
    const description = typeof payload.error_description === "string" ? `: ${payload.error_description}` : "";
    throw new Error(`Shopify OAuth failed for ${store.alias}: ${error}${description}`);
  }

  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 86_399;
  for (const key of oauthTokenCache.keys()) {
    if (key.startsWith(`${store.alias}\0`) && key !== cacheKey) oauthTokenCache.delete(key);
  }
  oauthTokenCache.set(cacheKey, {
    token: payload.access_token,
    expiresAt: Date.now() + expiresIn * 1_000
  });
  return payload.access_token;
}

export function graphqlEndpoint(store: StoreConfig): string {
  if (store.baseUrl) return new URL(`/admin/api/${store.apiVersion}/graphql.json`, store.baseUrl).toString();
  return `https://${store.shop}/admin/api/${store.apiVersion}/graphql.json`;
}
