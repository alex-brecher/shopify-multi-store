import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditErrorInfo } from "./hosted/audit.js";
/**
 * Called once by `shopify-multi-store serve` and by the Cloudflare Worker. Turns off keychain
 * and local-machine features. `env` holds the settings store configuration is read from
 * (STORES_JSON and friends): process.env on Node, the Worker's env on Cloudflare.
 */
export declare function enableHostedMode(env?: Readonly<Record<string, string | undefined>>): void;
/** Where configuration is read from: the hosted env when one was given, else process.env. */
export declare function runtimeEnv(): Readonly<Record<string, string | undefined>>;
export declare function isHostedMode(): boolean;
/** What is known about one store's Shopify online (per-user) token without decrypting it. */
export interface ShopifyUserConnection {
    /** ms since epoch. */
    expiresAt: number;
    /** The Shopify staff account the token acts as. */
    shopifyEmail?: string;
}
/**
 * Per-user Shopify access for one hosted request. Every hosted Admin API call uses the
 * caller's own online token for that store, so Shopify enforces that person's staff
 * permissions. There is no fallback to an app token or a static token.
 */
export interface UserShopifyAccess {
    /**
     * Keyed by lower-case store alias. May include expired tokens so the error can say "expired".
     * Filled by load(); nothing is decrypted for it.
     */
    tokens: Map<string, ShopifyUserConnection>;
    /**
     * Read the caller's stored connections (no decryption). Idempotent. The hosted guard calls it
     * before each tool call, so requests that call no tool (initialize, tools/list) read nothing.
     */
    load(): Promise<void>;
    /**
     * The decrypted token for one store, decrypted on first use in this request only. Undefined
     * when the store is not connected or its token cannot be decrypted (it then reads as not
     * connected).
     */
    token(alias: string): Promise<string | undefined>;
    /** The /stores page where the user connects stores. */
    storesUrl: string;
    /** The link that reconnects a store (on the hosted server, one link that reconnects every store). */
    connectUrl(alias: string): string;
    now(): number;
    /** Set when this caller may not use Shopify at all; tools return it as the error. */
    blockedReason?: string;
}
/** Details of one shopify_run_action call, for the hosted audit log. */
export interface ActionAuditDetails {
    mutations: string[];
    stores: string[];
    dryRun: boolean;
    variablesSha256: string;
    outcome: Array<{
        store: string;
        ok: boolean;
        error?: AuditErrorInfo;
        userErrors?: number;
        shopifyEmail?: string;
    }>;
}
/** Store aliases the current hosted caller may reach. "*" means every configured store. */
export interface StoreScope {
    stores: "*" | string[];
    /** Set on a hosted server: the caller's own Shopify tokens. */
    access?: UserShopifyAccess;
    /** Set in hosted mode: writes one audit line per action run. */
    auditAction?: (details: ActionAuditDetails) => Promise<void>;
}
/**
 * Carries the caller's store allowlist through the async call chain of one tool call.
 * loadStores() filters by it, so any code path that resolves stores is covered,
 * including tools where the store list is optional and defaults to "all stores".
 */
export declare const storeScope: AsyncLocalStorage<StoreScope>;
export declare function storeAllowed(alias: string, scope?: StoreScope | undefined): boolean;
/** The caller's per-user Shopify access, inside a hosted tool call. */
export declare function currentUserAccess(): UserShopifyAccess | undefined;
export type ConnectionStatus = "connected" | "expired" | "not_connected";
export declare function connectionStatus(access: UserShopifyAccess, alias: string): ConnectionStatus;
/** The message a tool returns when the caller has no live Shopify token for a store. */
export declare function notConnectedMessage(access: UserShopifyAccess, alias: string): string;
