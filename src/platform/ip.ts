/**
 * Addresses an outbound fetch of a client metadata document must never reach: unspecified,
 * loopback, private, carrier-grade NAT, link-local (including cloud metadata at
 * 169.254.169.254), benchmark, documentation, multicast, and reserved ranges, for IPv4 and
 * IPv6. Pure TypeScript, so it runs on Node and on Cloudflare Workers alike.
 */

const IPV4_FORBIDDEN: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
];

const IPV6_FORBIDDEN: ReadonlyArray<readonly [string, number]> = [
  ["::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]
];

/** An IPv4 dotted quad as a number, or undefined. */
export function parseIpv4(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  let result = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    result = result * 256 + octet;
  }
  return result;
}

/** An IPv6 address (with an optional embedded IPv4 tail) as a bigint, or undefined. */
export function parseIpv6(value: string): bigint | undefined {
  let text = value.toLowerCase();
  if (!text.includes(":") || text.includes("%")) return undefined;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIpv4(maybeV4);
    if (v4 === undefined) return undefined;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest] : head;
  if (groups.length !== 8 || (halves.length === 2 && head.length + rest.length > 7)) return undefined;
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    result = (result << 16n) | BigInt(parseInt(group, 16));
  }
  if (tail.length) result = (result & ~0xffffffffn) | (BigInt(tail[0]!) << 16n) | BigInt(tail[1]!);
  return result;
}

function inIpv4(address: number, [network, prefix]: readonly [string, number]): boolean {
  const base = parseIpv4(network)!;
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(base / size);
}

function inIpv6(address: bigint, [network, prefix]: readonly [string, number]): boolean {
  const shift = BigInt(128 - prefix);
  return (address >> shift) === (parseIpv6(network)! >> shift);
}

function forbiddenIpv4(address: number): boolean {
  return IPV4_FORBIDDEN.some((range) => inIpv4(address, range));
}

/** True for an IP address a client metadata fetch must not connect to. Non-IP input is refused. */
export function isForbiddenAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = parseIpv4(ip);
  if (v4 !== undefined) return forbiddenIpv4(v4);
  const v6 = parseIpv6(ip);
  if (v6 === undefined) return true;
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) addresses carry an IPv4 address.
  // IPv4-compatible and unspecified addresses (::/96, including :: and ::1) are refused below.
  const high = v6 >> 32n;
  if (high === 0xffffn || high === 0x64ff9b0000000000000000n) return forbiddenIpv4(Number(v6 & 0xffffffffn));
  return IPV6_FORBIDDEN.some((range) => inIpv6(v6, range));
}

/** True when a string is an IP literal (v4 or v6, brackets allowed). */
export function isIpLiteral(value: string): boolean {
  const ip = value.replace(/^\[|\]$/g, "");
  return parseIpv4(ip) !== undefined || parseIpv6(ip) !== undefined;
}
