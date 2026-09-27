import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { CIMD_MAX_BYTES } from "./cimd-fetch.js";
import { isForbiddenAddress, isIpLiteral } from "./ip.js";
/**
 * Node's Client ID Metadata Document fetcher (the "any server" option). Unlike the plain
 * fetch version used on Cloudflare Workers, it resolves the host itself and connects only to
 * the checked public address, so a DNS answer cannot change between the check and the
 * connection.
 */
/** dns.lookup that fails when any resolved address is forbidden. Used as the socket's lookup, so the checked address is the one connected to. */
const publicOnlyLookup = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error)
            return callback(error);
        const list = addresses;
        const blocked = list.find((entry) => isForbiddenAddress(entry.address));
        if (!list.length || blocked) {
            return callback(new Error(`Client metadata host ${hostname} resolves to a non-public address${blocked ? ` (${blocked.address})` : ""}.`));
        }
        if (options.all)
            return callback(null, list);
        callback(null, list[0].address, list[0].family);
    });
};
/**
 * Fetch a Client ID Metadata Document: HTTPS only, no redirects, 5-second limit, 16 KB body.
 * The host, named or wildcard-admitted, must resolve only to public addresses (checked at
 * connect time, so a DNS answer cannot change between the check and the connection).
 */
export function fetchMetadataDocument(url) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        }
        catch {
            reject(new Error("Invalid URL."));
            return;
        }
        if (target.protocol !== "https:") {
            reject(new Error("Only HTTPS is allowed."));
            return;
        }
        const literal = target.hostname.replace(/^\[|\]$/g, "");
        if (isIpLiteral(literal) && isForbiddenAddress(literal)) {
            reject(new Error(`Client metadata host ${literal} is a non-public address.`));
            return;
        }
        const request = httpsRequest(target, {
            method: "GET",
            headers: { accept: "application/json" },
            lookup: publicOnlyLookup
        }, (response) => {
            const status = response.statusCode ?? 0;
            if (status >= 300 && status < 400) {
                response.resume();
                reject(new Error(`Redirects are not followed (HTTP ${status}).`));
                return;
            }
            if (status < 200 || status >= 300) {
                response.resume();
                reject(new Error(`HTTP ${status}`));
                return;
            }
            if (Number(response.headers["content-length"] ?? "0") > CIMD_MAX_BYTES) {
                response.destroy();
                reject(new Error("Document too large."));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
                size += chunk.byteLength;
                if (size > CIMD_MAX_BYTES) {
                    response.destroy();
                    reject(new Error("Document too large."));
                    return;
                }
                chunks.push(chunk);
            });
            response.on("end", () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                }
                catch {
                    reject(new Error("Document is not valid JSON."));
                }
            });
            response.on("error", reject);
        });
        const timer = setTimeout(() => request.destroy(new Error("Timed out.")), 5_000);
        request.on("close", () => clearTimeout(timer));
        request.on("error", reject);
        request.end();
    });
}
//# sourceMappingURL=cimd-node.js.map