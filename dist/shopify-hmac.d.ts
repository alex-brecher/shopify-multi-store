/**
 * Shopify OAuth redirect signatures: the one implementation, shared by the local connect script
 * (scripts/oauth-connect.mjs, synchronous node:crypto) and the hosted connector
 * (src/hosted/shopify-connect.ts, Web Crypto, so it runs on Node and Cloudflare Workers).
 */
/**
 * The message Shopify signs for an OAuth redirect: every parameter except hmac and signature,
 * with "%", "&" and "=" escaped in names and "%" and "&" escaped in values, array parameters
 * (name[]) written as name=["a", "b"], sorted by name, joined as name=value with "&".
 * Returns undefined for a repeated plain parameter, which is ambiguous.
 */
export declare function shopifyHmacMessage(params: URLSearchParams): string | undefined;
/** Constant-time comparison of two strings; false when the lengths differ. */
export declare function safeEqual(a: string, b: string): boolean;
export interface VerifyShopifyHmacOptions {
    /** Current time in milliseconds. When set, the timestamp parameter must be within maxAgeSeconds of it. */
    nowMs?: number;
    /** Allowed clock distance for the timestamp parameter. Defaults to 300 seconds. */
    maxAgeSeconds?: number;
}
/**
 * Verify the hmac Shopify adds to OAuth redirects: hex HMAC-SHA256 of shopifyHmacMessage, keyed
 * with the app's client secret. Synchronous (node:crypto), for Node scripts.
 */
export declare function verifyShopifyHmac(params: URLSearchParams, secret: string, options?: VerifyShopifyHmacOptions): boolean;
/** verifyShopifyHmac with Web Crypto, for code that also runs on Cloudflare Workers. */
export declare function verifyShopifyHmacAsync(params: URLSearchParams, secret: string, options?: VerifyShopifyHmacOptions): Promise<boolean>;
