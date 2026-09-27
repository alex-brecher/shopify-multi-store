import { createHmac, timingSafeEqual } from "node:crypto";
/**
 * Shopify OAuth redirect signatures, shared by the local connect script (scripts/oauth-connect.mjs)
 * and, later, the hosted connector.
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
/**
 * Verify the hmac Shopify adds to OAuth redirects: hex HMAC-SHA256 of shopifyHmacMessage, keyed
 * with the app's client secret.
 */
export function verifyShopifyHmac(params, secret, options = {}) {
    const received = params.get("hmac") ?? "";
    if (!/^[0-9a-f]{64}$/i.test(received) || !secret)
        return false;
    const message = shopifyHmacMessage(params);
    if (message === undefined)
        return false;
    const expected = createHmac("sha256", secret).update(message).digest("hex");
    if (!safeEqual(expected, received.toLowerCase()))
        return false;
    if (options.nowMs !== undefined) {
        const timestamp = Number(params.get("timestamp"));
        const maxAge = options.maxAgeSeconds ?? 300;
        if (!Number.isInteger(timestamp) || Math.abs(options.nowMs / 1000 - timestamp) > maxAge)
            return false;
    }
    return true;
}
//# sourceMappingURL=shopify-hmac.js.map