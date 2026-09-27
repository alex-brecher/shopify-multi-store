/**
 * Fetch a Client ID Metadata Document: HTTPS only, no redirects, 5-second limit, 16 KB body.
 * The host, named or wildcard-admitted, must resolve only to public addresses (checked at
 * connect time, so a DNS answer cannot change between the check and the connection).
 */
export declare function fetchMetadataDocument(url: string): Promise<unknown>;
