/**
 * The network address a request came from, for per-source limits. The platform records it:
 * Node's HTTP adapter from the socket (never from a header a client could set), and the
 * Cloudflare Worker from CF-Connecting-IP, which Cloudflare's edge sets and clients cannot
 * forge on a Worker. Kept beside the Request, not in a header, so nothing downstream can
 * mistake a client-supplied header for it.
 */
const sources = new WeakMap();
export function setRequestSource(request, address) {
    if (address)
        sources.set(request, address);
}
/** The recorded source address, or undefined when the platform did not record one. */
export function requestSource(request) {
    return sources.get(request);
}
//# sourceMappingURL=request-source.js.map