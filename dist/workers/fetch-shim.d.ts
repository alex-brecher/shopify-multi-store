/**
 * Workers' fetch rejects `redirect: "error"` ("use manual and check the status"), while the
 * shared code uses it for every Shopify request so a redirect can never carry a token
 * elsewhere. This shim, installed only in the Worker, gives the same guarantee: such a request
 * is sent with `redirect: "manual"`, and a redirect response fails the fetch instead of being
 * followed. Node keeps its native behavior.
 */
export declare function installRedirectErrorShim(target?: {
    fetch: typeof fetch;
}): void;
