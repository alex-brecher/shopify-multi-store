import type { StoreConfig } from "../config.js";
import type { UserShopifyAccess } from "../runtime.js";
import { type AuthorizationServer } from "./oauth.js";
import type { PolicySource } from "./policy.js";
import type { OAuthStore } from "./store.js";
/** Shopify callbacks older than this (or this far in the future) are refused. */
export declare const CALLBACK_MAX_AGE_SECONDS = 300;
export interface ShopifyAssociatedUser {
    id: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    accountOwner?: boolean;
    collaborator?: boolean;
    emailVerified?: boolean;
}
/** Stored per (Google email, store alias). The token is stored only encrypted. */
export interface ShopifyTokenRecord {
    email: string;
    alias: string;
    shop: string;
    encryptedToken: string;
    scope: string;
    associatedUserScope: string;
    associatedUser: ShopifyAssociatedUser;
    connectedAt: number;
    expiresAt: number;
}
export interface ShopifyConnectOptions {
    auth: AuthorizationServer;
    store: OAuthStore;
    policy: PolicySource;
    /** AES-256-GCM keys, newest first. The first encrypts; all decrypt. */
    encryptionKeys: EncryptionKey[];
    /** Every configured store (unfiltered). */
    loadStores: () => Promise<StoreConfig[]>;
    /** The Shopify app client id for a store: its auth.clientId, else SHOPIFY_APP_CLIENT_ID. */
    clientId: (store: StoreConfig) => string | undefined;
    /** The Shopify app client secret for a store. */
    clientSecret: (store: StoreConfig) => string | undefined;
    /** Scopes to request, comma-separated handles. */
    scopes: string[];
    /** Reject a connection whose Shopify staff email differs from the Google email. */
    requireEmailMatch?: boolean;
    fetch?: typeof fetch;
    now?: () => number;
}
/** One AES-256-GCM key with the id stored next to each ciphertext it produced. */
export interface EncryptionKey {
    id: string;
    key: Buffer;
}
/** Parse one 32-byte key, base64 or base64url. */
export declare function parseEncryptionKey(value: string | undefined, name?: string): Buffer;
/**
 * The token encryption keys, newest first. SHOPIFY_TOKEN_ENCRYPTION_KEYS is a comma list of
 * id:base64key; the first key encrypts and every key decrypts, so a key can be rotated by
 * prepending a new one and dropping the old one once every token has been re-encrypted (tokens
 * are re-encrypted with the first key on use, and online tokens live about a day).
 * SHOPIFY_TOKEN_ENCRYPTION_KEY is the single-key form, with id "default".
 */
export declare function parseEncryptionKeys(env: {
    SHOPIFY_TOKEN_ENCRYPTION_KEYS?: string | undefined;
    SHOPIFY_TOKEN_ENCRYPTION_KEY?: string | undefined;
}): EncryptionKey[];
type Binding = {
    email: string;
    alias: string;
    shop: string;
};
/** Encrypt with the given key: v2.<keyId>.<iv>.<tag>.<ciphertext>. */
export declare function encryptToken(key: EncryptionKey, token: string, binding: Binding): string;
/** Decrypt with whichever configured key produced the value. keyId says which one. */
export declare function decryptToken(keys: EncryptionKey[], value: string, binding: Binding): {
    token: string;
    keyId: string;
};
/**
 * The message Shopify signs for an OAuth redirect: every parameter except hmac and signature,
 * with "%", "&" and "=" escaped in names and "%" and "&" escaped in values, array parameters
 * (name[]) written as name=["a", "b"], sorted by name, joined as name=value with "&".
 */
export declare function shopifyHmacMessage(params: URLSearchParams): string | undefined;
/**
 * Verify the hmac Shopify adds to OAuth redirects (hex HMAC-SHA256 of shopifyHmacMessage, keyed
 * with the app's client secret). With nowMs, also require a timestamp no older than
 * CALLBACK_MAX_AGE_SECONDS (and no more than that in the future).
 */
export declare function verifyShopifyHmac(params: URLSearchParams, secret: string, nowMs?: number): boolean;
export declare class ShopifyConnections {
    private readonly options;
    private readonly now;
    private readonly fetcher;
    constructor(options: ShopifyConnectOptions);
    get storesUrl(): string;
    connectUrl(alias: string): string;
    /** The caller's decrypted tokens for every store, for one MCP request. */
    accessFor(email: string): Promise<UserShopifyAccess>;
    signedIn(email: string): Promise<Response>;
    private session;
    private visibleStores;
    private record;
    private nextUnconnected;
    handleStoresPage(request: Request): Promise<Response>;
    private render;
    private action;
    /**
     * GET shows a confirmation button; only a POST with the /stores CSRF token creates the state and
     * redirects to Shopify, so another site cannot start a Shopify authorization in the user's name.
     */
    connect(request: Request): Promise<Response>;
    private connectForm;
    private connectableStore;
    callback(request: Request): Promise<Response>;
}
export {};
