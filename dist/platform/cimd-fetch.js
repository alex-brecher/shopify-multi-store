import { isForbiddenAddress, isIpLiteral } from "./ip.js";
/** Largest client metadata document accepted. */
export const CIMD_MAX_BYTES = 16 * 1024;
const TIMEOUT_MS = 5_000;
/**
 * Fetch a Client ID Metadata Document with the platform's fetch: HTTPS only, no redirects,
 * 5-second limit, 16 KB body. IP literals in forbidden ranges and localhost names are refused
 * here; for other names the platform's own outbound protection applies (Cloudflare Workers
 * cannot reach private or loopback addresses). On Node, use fetchMetadataDocument from
 * cimd-node.ts, which also pins DNS to public addresses.
 */
export async function fetchMetadataDocumentWithFetch(url, fetcher = (input, init) => fetch(input, init)) {
    let target;
    try {
        target = new URL(url);
    }
    catch {
        throw new Error("Invalid URL.");
    }
    if (target.protocol !== "https:")
        throw new Error("Only HTTPS is allowed.");
    const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if ((isIpLiteral(host) && isForbiddenAddress(host)) || host === "localhost" || host.endsWith(".localhost")) {
        throw new Error(`Client metadata host ${host} is a non-public address.`);
    }
    const response = await fetcher(target.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => { });
        throw new Error(`Redirects are not followed (HTTP ${response.status}).`);
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => { });
        throw new Error(`HTTP ${response.status}`);
    }
    if (Number(response.headers.get("content-length") ?? "0") > CIMD_MAX_BYTES) {
        await response.body?.cancel().catch(() => { });
        throw new Error("Document too large.");
    }
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > CIMD_MAX_BYTES) {
                await reader.cancel().catch(() => { });
                throw new Error("Document too large.");
            }
            chunks.push(value);
        }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    catch {
        throw new Error("Document is not valid JSON.");
    }
}
//# sourceMappingURL=cimd-fetch.js.map