/**
 * Workers' fetch rejects `redirect: "error"` ("use manual and check the status"), while the
 * shared code uses it for every Shopify request so a redirect can never carry a token
 * elsewhere. This shim, installed only in the Worker, gives the same guarantee: such a request
 * is sent with `redirect: "manual"`, and a redirect response fails the fetch instead of being
 * followed. Node keeps its native behavior.
 */
export function installRedirectErrorShim(target = globalThis) {
    const original = target.fetch;
    if (original.__smsRedirectShim)
        return;
    const shimmed = (async (input, init) => {
        if (init?.redirect !== "error")
            return original(input, init);
        const response = await original(input, { ...init, redirect: "manual" });
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => { });
            throw new TypeError(`fetch failed: the server answered with a redirect (HTTP ${response.status}), which is not followed.`);
        }
        return response;
    });
    shimmed.__smsRedirectShim = true;
    target.fetch = shimmed;
}
//# sourceMappingURL=fetch-shim.js.map