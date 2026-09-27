import { AsyncLocalStorage } from "node:async_hooks";
/** Called once by `shopify-multi-store serve`. Turns off keychain and local-machine features. */
export declare function enableHostedMode(): void;
export declare function isHostedMode(): boolean;
/** One Shopify online (per-user) access token, already decrypted, for one store. */
export interface ShopifyUserToken {
    token: string;
    /** ms since epoch. */
    expiresAt: number;
    /** The Shopify staff account the token acts as. */
    shopifyEmail?: string;
}
/**
 * Per-user Shopify access for one hosted request (SHOPIFY_ACCESS_MODE=per_user).
 * When present, every Admin API call uses the caller's own online token for that store,
 * so Shopify enforces that person's staff permissions. There is no fallback to the app token.
 */
export interface UserShopifyAccess {
    /** Keyed by lower-case store alias. May include expired tokens so the error can say "expired". */
    tokens: Map<string, ShopifyUserToken>;
    /** The /stores page where the user connects stores. */
    storesUrl: string;
    /** The URL that starts a Shopify connection for one store. */
    connectUrl(alias: string): string;
    now(): number;
    /** Set when this caller may not use Shopify at all (for example a personal access token); tools return it as the error. */
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
        error?: string;
        userErrors?: number;
    }>;
}
/** Store aliases the current hosted caller may reach. "*" means every configured store. */
export interface StoreScope {
    stores: "*" | string[];
    /** Set in per-user mode: the caller's own Shopify tokens. */
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
/** The caller's per-user Shopify access, when the current hosted call runs in per-user mode. */
export declare function currentUserAccess(): UserShopifyAccess | undefined;
export type ConnectionStatus = "connected" | "expired" | "not_connected";
export declare function connectionStatus(access: UserShopifyAccess, alias: string): ConnectionStatus;
/** The message a tool returns when the caller has no live Shopify token for a store. */
export declare function notConnectedMessage(access: UserShopifyAccess, alias: string): string;
