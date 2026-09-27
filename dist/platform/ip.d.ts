/**
 * Addresses an outbound fetch of a client metadata document must never reach: unspecified,
 * loopback, private, carrier-grade NAT, link-local (including cloud metadata at
 * 169.254.169.254), benchmark, documentation, multicast, and reserved ranges, for IPv4 and
 * IPv6. Pure TypeScript, so it runs on Node and on Cloudflare Workers alike.
 */
/** An IPv4 dotted quad as a number, or undefined. */
export declare function parseIpv4(value: string): number | undefined;
/** An IPv6 address (with an optional embedded IPv4 tail) as a bigint, or undefined. */
export declare function parseIpv6(value: string): bigint | undefined;
/** True for an IP address a client metadata fetch must not connect to. Non-IP input is refused. */
export declare function isForbiddenAddress(address: string): boolean;
/** True when a string is an IP literal (v4 or v6, brackets allowed). */
export declare function isIpLiteral(value: string): boolean;
