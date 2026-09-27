import type { StoreConfig } from "../config.js";
import { fullScopes } from "../scope-requirements.js";
import type { HostedAppOptions } from "./app.js";
import { redirectListFromEnv } from "./known-clients.js";
import { DEFAULT_CIMD_HOSTS, DEFAULT_DISPLAY_NAME } from "./oauth.js";
import { parseEncryptionKeys } from "./shopify-connect.js";

/**
 * The hosted server's settings as plain strings: process.env on Node (`serve`), the Worker's
 * env (vars and secrets) on Cloudflare. Hosted code reads settings only from this object.
 */
export type HostedEnv = Readonly<Record<string, string | undefined>>;

function required(env: HostedEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the hosted server. See docs/HOSTED.md.`);
  return value;
}

export function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function flag(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function positiveInt(env: HostedEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function displayName(env: HostedEnv): string {
  const value = env.SERVER_DISPLAY_NAME?.trim();
  if (!value) return DEFAULT_DISPLAY_NAME;
  if (value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("SERVER_DISPLAY_NAME must be 1 to 100 characters with no control characters.");
  return value;
}

function secretEnvName(alias: string): string {
  return `SHOPIFY_CLIENT_SECRET_${alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** MCP_PUBLIC_URL as an origin: https (http only for localhost), no path. */
export function publicOrigin(env: HostedEnv): string {
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
 * Everything createHostedApp needs from the settings, for any platform. The caller adds the
 * platform's parts: the OAuth store, the audit log, and (on Node) the DNS-pinned client
 * metadata fetcher. Throws on a missing encryption key or an invalid setting, so a
 * misconfigured server refuses to start.
 */
export async function hostedOptionsFromEnv(
  env: HostedEnv,
  platform: { loadStores: () => Promise<StoreConfig[]> }
): Promise<Omit<HostedAppOptions, "store" | "audit">> {
  const origin = publicOrigin(env);
  const encryptionKeys = parseEncryptionKeys({ SHOPIFY_TOKEN_ENCRYPTION_KEYS: env.SHOPIFY_TOKEN_ENCRYPTION_KEYS, SHOPIFY_TOKEN_ENCRYPTION_KEY: env.SHOPIFY_TOKEN_ENCRYPTION_KEY });
  const appClientId = env.SHOPIFY_APP_CLIENT_ID?.trim() || undefined;
  const appClientSecret = env.SHOPIFY_APP_CLIENT_SECRET?.trim() || undefined;
  const scopes = list(env.SHOPIFY_APP_SCOPES) ?? fullScopes();
  const identityStore = env.SHOPIFY_IDENTITY_STORE?.trim() || undefined;
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
    shopifyConnect: {
      encryptionKeys,
      loadStores: platform.loadStores,
      clientId: (store: StoreConfig) => (store.auth.type === "client_credentials" ? store.auth.clientId : undefined) ?? appClientId,
      clientSecret: (store: StoreConfig) => env[secretEnvName(store.alias)]?.trim() || appClientSecret,
      scopes,
      ...(identityStore ? { identityStore } : {})
    }
  };
}
