import { shopifyHmacMessage } from "../shopify-hmac.js";
import type { StoreConfig } from "../config.js";
import type { UserShopifyAccess } from "../runtime.js";
import { type AuthorizationServer, type PageSignInPurpose } from "./oauth.js";
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
/** Stored per (signed-in email, store alias). The token is stored only encrypted. */
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
    /** Alias of the store listed first (preselected) on the sign-in chooser. Defaults to the first configured store. */
    identityStore?: string;
    fetch?: typeof fetch;
    now?: () => number;
}
/** One AES-256-GCM key with the id stored next to each ciphertext it produced. */
export interface EncryptionKey {
    id: string;
    /** 32 raw key bytes. */
    key: Uint8Array;
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
/**
 * Encrypt with the given key: v2.<keyId>.<iv>.<tag>.<ciphertext>, each part base64url. AES-256-GCM
 * through Web Crypto. The format is the one written by earlier versions (Node's cipher API), so
 * existing records stay readable and no migration is needed.
 */
export declare function encryptToken(key: EncryptionKey, token: string, binding: Binding): Promise<string>;
/** Decrypt with whichever configured key produced the value. keyId says which one. */
export declare function decryptToken(keys: EncryptionKey[], value: string, binding: Binding): Promise<{
    token: string;
    keyId: string;
}>;
export { shopifyHmacMessage };
/**
 * Verify the hmac Shopify adds to OAuth redirects. With nowMs, also require a timestamp within
 * CALLBACK_MAX_AGE_SECONDS of it.
 */
export declare function verifyShopifyHmac(params: URLSearchParams, secret: string, nowMs?: number): Promise<boolean>;
export declare class ShopifyConnections {
    private readonly options;
    private readonly now;
    private readonly fetcher;
    constructor(options: ShopifyConnectOptions);
    get storesUrl(): string;
    /** One link that signs in if needed and reconnects every expired or unconnected store. */
    get reconnectUrl(): string;
    /**
     * The caller's Shopify access for one MCP request. Nothing is read until a tool call needs it
     * (load()), and a store's token is decrypted only when a call uses that store (token()), so
     * initialize and tools/list neither read nor decrypt, and a call to one store decrypts one.
     */
    accessFor(email: string): UserShopifyAccess;
    /** Decrypt one stored token, re-encrypting it under the newest key after a rotation. */
    private decryptStored;
    /** Stores a person can sign in through: *.myshopify.com, with app credentials on this server. */
    private loginStores;
    /**
     * The login step of a sign-in: with one store, straight to its Shopify admin; with several,
     * a chooser listing them, the identity store (or the first) preselected.
     */
    private startLogin;
    /** POST /login/shopify: the store picked on the chooser. The browser must hold the sign-in's binding cookie. */
    chooseLogin(request: Request): Promise<Response>;
    private redirectLogin;
    private authorizeUrl;
    /** A page sign-in finished: open a /stores session, then show the page or reconnect every store. */
    signedIn(email: string, purpose?: PageSignInPurpose): Promise<Response>;
    private session;
    /** Every configured store. Whether the person may use one is up to Shopify. */
    private visibleStores;
    private record;
    /** The next store that is not connected, or whose connection expired. */
    private nextUnconnected;
    handleStoresPage(request: Request): Promise<Response>;
    /**
     * GET /stores/reconnect: the one link tool errors return. Signed out, it signs in with Shopify
     * and then reconnects every expired or unconnected store in a row. Signed in, it shows the
     * stores page, where one "Reconnect all" click does the same.
     */
    handleReconnect(request: Request): Promise<Response>;
    private render;
    private action;
    /**
     * GET shows a confirmation button; only a POST with the /stores CSRF token creates the state and
     * redirects to Shopify, so another site cannot start a Shopify authorization in the user's name.
     */
    connect(request: Request): Promise<Response>;
    /** Create a single-use connection state bound to the /stores session and send the browser to Shopify. */
    private startConnection;
    private connectForm;
    private connectableStore;
    /**
     * Shopify's redirect back, for a sign-in or a store connection. The signature (keyed with the
     * store's app secret) and timestamp are checked first; the state then says which flow it is.
     */
    callback(request: Request): Promise<Response>;
    /** Exchange an authorization code for an online token. */
    private exchange;
    /** Keep an online token as the person's connection to a store. */
    private saveToken;
    /** Shopify callback for a sign-in: the verified staff email becomes the person's identity. */
    private loginCallback;
    /** Shopify callback for connecting one more store from the /stores session. */
    private connectionCallback;
}
