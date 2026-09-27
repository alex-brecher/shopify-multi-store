/** Largest client metadata document accepted. */
export declare const CIMD_MAX_BYTES: number;
/**
 * Fetch a Client ID Metadata Document with the platform's fetch: HTTPS only, no redirects,
 * 5-second limit, 16 KB body. IP literals in forbidden ranges and localhost names are refused
 * here; for other names the platform's own outbound protection applies (Cloudflare Workers
 * cannot reach private or loopback addresses). On Node, use fetchMetadataDocument from
 * cimd-node.ts, which also pins DNS to public addresses.
 */
export declare function fetchMetadataDocumentWithFetch(url: string, fetcher?: typeof fetch): Promise<unknown>;
