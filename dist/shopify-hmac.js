import { createHmac, timingSafeEqual } from "node:crypto";
import { constantTimeEqual, hmacSha256Hex } from "./platform/crypto.js";
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
export function shopifyHmacMessage(params) {
    const escapeKey = (value) => value.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, "%3D");
    const escapeValue = (value) => value.replace(/%/g, "%25").replace(/&/g, "%26");
    const grouped = new Map();
    for (const [name, value] of params.entries()) {
        if (name === "hmac" || name === "signature")
            continue;
        grouped.set(name, [...(grouped.get(name) ?? []), value]);
    }
    const pairs = [];
    for (const [name, values] of grouped) {
        if (name.endsWith("[]")) {
            pairs.push([escapeKey(name.slice(0, -2)), escapeValue(`[${values.map((value) => `"${value}"`).join(", ")}]`)]);
        }
        else {
            if (values.length !== 1)
                return undefined;
            pairs.push([escapeKey(name), escapeValue(values[0])]);
        }
    }
    return pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, value]) => `${name}=${value}`).join("&");
}
/** Constant-time comparison of two strings; false when the lengths differ. */
export function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
/** The hmac parameter, lower-cased, when it has the right shape; undefined otherwise. */
function receivedHmac(params) {
    const received = params.get("hmac") ?? "";
    return /^[0-9a-f]{64}$/i.test(received) ? received.toLowerCase() : undefined;
}
/** The timestamp parameter is within maxAgeSeconds (default 300) of nowMs, either way. */
function timestampFresh(params, nowMs, maxAgeSeconds = 300) {
    const timestamp = Number(params.get("timestamp"));
    return Number.isInteger(timestamp) && Math.abs(nowMs / 1000 - timestamp) <= maxAgeSeconds;
}
/**
 * Verify the hmac Shopify adds to OAuth redirects: hex HMAC-SHA256 of shopifyHmacMessage, keyed
 * with the app's client secret. Synchronous (node:crypto), for Node scripts.
 */
export function verifyShopifyHmac(params, secret, options = {}) {
    const received = receivedHmac(params);
    if (!received || !secret)
        return false;
    const message = shopifyHmacMessage(params);
    if (message === undefined)
        return false;
    const expected = createHmac("sha256", secret).update(message).digest("hex");
    if (!safeEqual(expected, received))
        return false;
    return options.nowMs === undefined || timestampFresh(params, options.nowMs, options.maxAgeSeconds);
}
/** verifyShopifyHmac with Web Crypto, for code that also runs on Cloudflare Workers. */
export async function verifyShopifyHmacAsync(params, secret, options = {}) {
    const received = receivedHmac(params);
    if (!received || !secret)
        return false;
    const message = shopifyHmacMessage(params);
    if (message === undefined)
        return false;
    if (!constantTimeEqual(await hmacSha256Hex(secret, message), received))
        return false;
    return options.nowMs === undefined || timestampFresh(params, options.nowMs, options.maxAgeSeconds);
}
//# sourceMappingURL=shopify-hmac.js.map