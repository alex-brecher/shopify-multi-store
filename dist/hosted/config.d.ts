import type { StoreConfig } from "../config.js";
import type { HostedAppOptions } from "./app.js";
/**
 * The hosted server's settings as plain strings: process.env on Node (`serve`), the Worker's
 * env (vars and secrets) on Cloudflare. Hosted code reads settings only from this object.
 */
export type HostedEnv = Readonly<Record<string, string | undefined>>;
export declare function list(value: string | undefined): string[] | undefined;
export declare function flag(value: string | undefined): boolean;
export declare function nonNegativeInt(env: HostedEnv, name: string, fallback: number): number;
export declare function positiveInt(env: HostedEnv, name: string, fallback: number): number;
/** MCP_PUBLIC_URL as an origin: https (http only for localhost), no path. */
export declare function publicOrigin(env: HostedEnv): string;
/**
 * OFFLINE_TOKEN_USERS: comma-separated verified Shopify staff emails (the email each person signs
 * in with, as the audit log's user column shows it), matched without regard to case. These
 * people get Shopify's expiring offline tokens, renewed by the server, instead of 24-hour
 * per-user tokens. Unset or empty: nobody.
 */
export declare function offlineTokenUsers(env: HostedEnv): string[];
/**
 * Everything createHostedApp needs from the settings, for any platform. The caller adds the
 * platform's parts: the OAuth store, the audit log, and (on Node) the DNS-pinned client
 * metadata fetcher. Throws on a missing encryption key or an invalid setting, so a
 * misconfigured server refuses to start.
 */
export declare function hostedOptionsFromEnv(env: HostedEnv, platform: {
    loadStores: () => Promise<StoreConfig[]>;
}): Promise<Omit<HostedAppOptions, "store" | "audit">>;
