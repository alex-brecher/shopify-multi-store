import { AsyncLocalStorage } from "node:async_hooks";
/**
 * Process-wide runtime switches. Stdio mode never changes these, so local
 * behavior (keychain credentials, preview stores, unfiltered store list) stays the same.
 */
let hosted = false;
/** Called once by `shopify-multi-store serve`. Turns off keychain and local-machine features. */
export function enableHostedMode() {
    hosted = true;
}
export function isHostedMode() {
    return hosted;
}
/**
 * Carries the caller's store allowlist through the async call chain of one tool call.
 * loadStores() filters by it, so any code path that resolves stores is covered,
 * including tools where the store list is optional and defaults to "all stores".
 */
export const storeScope = new AsyncLocalStorage();
export function storeAllowed(alias, scope = storeScope.getStore()) {
    if (!scope || scope.stores === "*")
        return true;
    const lower = alias.toLowerCase();
    return scope.stores.some((allowed) => allowed.toLowerCase() === lower);
}
/** The caller's per-user Shopify access, inside a hosted tool call. */
export function currentUserAccess() {
    return storeScope.getStore()?.access;
}
export function connectionStatus(access, alias) {
    const token = access.tokens.get(alias.toLowerCase());
    if (!token)
        return "not_connected";
    return token.expiresAt > access.now() ? "connected" : "expired";
}
/** The message a tool returns when the caller has no live Shopify token for a store. */
export function notConnectedMessage(access, alias) {
    if (access.blockedReason)
        return access.blockedReason;
    const status = connectionStatus(access, alias);
    const url = access.connectUrl(alias);
    return status === "expired"
        ? `Your Shopify connection to store "${alias}" has expired. Reconnect at ${url} (or see all stores at ${access.storesUrl}), then try again.`
        : `You have not connected store "${alias}" with your Shopify account. Connect it at ${url} (or see all stores at ${access.storesUrl}), then try again.`;
}
//# sourceMappingURL=runtime.js.map