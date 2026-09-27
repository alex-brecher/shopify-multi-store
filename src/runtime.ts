import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Process-wide runtime switches. Stdio mode never changes these, so local
 * behavior (keychain credentials, preview stores, unfiltered store list) stays the same.
 */
let hosted = false;

/** Called once by `shopify-multi-store serve`. Turns off keychain and local-machine features. */
export function enableHostedMode(): void {
  hosted = true;
}

export function isHostedMode(): boolean {
  return hosted;
}

/** Store aliases the current hosted caller may reach. "*" means every configured store. */
export interface StoreScope {
  stores: "*" | string[];
}

/**
 * Carries the caller's store allowlist through the async call chain of one tool call.
 * loadStores() filters by it, so any code path that resolves stores is covered,
 * including tools where the store list is optional and defaults to "all stores".
 */
export const storeScope = new AsyncLocalStorage<StoreScope>();

export function storeAllowed(alias: string, scope: StoreScope | undefined = storeScope.getStore()): boolean {
  if (!scope || scope.stores === "*") return true;
  const lower = alias.toLowerCase();
  return scope.stores.some((allowed) => allowed.toLowerCase() === lower);
}
