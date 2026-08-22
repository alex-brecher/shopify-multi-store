import { readFileSync } from "node:fs";
import { getAccessToken, graphqlEndpoint } from "./config.js";
const CHARACTER_LIMIT = 50_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_THROTTLE_RETRIES = 3;
export const PACKAGE_VERSION = String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "unknown");
function retryDelay(response, attempt) {
    const retryAfter = response?.headers.get("retry-after");
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds))
            return Math.min(Math.max(seconds * 1_000, 0), 10_000);
        const dateDelay = Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(dateDelay))
            return Math.min(Math.max(dateDelay, 0), 10_000);
    }
    return 250 * 2 ** attempt;
}
function hasThrottleError(payload) {
    const body = payload && typeof payload === "object" ? payload : {};
    if (!Array.isArray(body.errors))
        return false;
    return body.errors.some((error) => {
        if (!error || typeof error !== "object")
            return false;
        const extensions = error.extensions;
        return Boolean(extensions && typeof extensions === "object" && extensions.code === "THROTTLED");
    });
}
async function wait(milliseconds) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function graphqlRequest(store, document, variables, token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(graphqlEndpoint(store), {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": token,
                "User-Agent": `shopify-multi-store-mcp-server/${PACKAGE_VERSION}`
            },
            body: JSON.stringify({ query: document, variables }),
            signal: controller.signal
        });
    }
    catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Shopify did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds for ${store.alias}.`);
        }
        throw new Error(`Shopify request failed for ${store.alias}: ${error instanceof Error ? error.message : String(error)}`);
    }
    finally {
        clearTimeout(timeout);
    }
    const requestId = response.headers.get("x-request-id");
    const responseText = await response.text();
    let payload;
    try {
        payload = JSON.parse(responseText);
    }
    catch {
        throw new Error(`Shopify returned a non-JSON response for ${store.alias}. HTTP ${response.status}. Request ID: ${requestId ?? "not provided"}`);
    }
    return { response, payload };
}
export async function adminGraphql(store, document, variables) {
    const token = await getAccessToken(store);
    let response;
    let payload;
    for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt += 1) {
        ({ response, payload } = await graphqlRequest(store, document, variables, token));
        const throttled = response.status === 429 || hasThrottleError(payload);
        if (!throttled || attempt === MAX_THROTTLE_RETRIES)
            break;
        await wait(retryDelay(response, attempt));
    }
    if (!response)
        throw new Error(`Shopify returned no response for ${store.alias}.`);
    const requestId = response.headers.get("x-request-id");
    if (!response.ok) {
        const details = JSON.stringify(payload).slice(0, 2_000);
        throw new Error(`Shopify returned HTTP ${response.status} for ${store.alias}. Request ID: ${requestId ?? "not provided"}. Response: ${details}`);
    }
    const body = payload && typeof payload === "object" ? payload : {};
    const envelope = {
        store: store.alias,
        shop: store.shop,
        apiVersion: store.apiVersion,
        ...(body.data !== undefined ? { data: body.data } : {}),
        ...(body.errors !== undefined ? { errors: body.errors } : {}),
        ...(body.extensions !== undefined ? { extensions: body.extensions } : {})
    };
    const serialized = JSON.stringify(envelope);
    if (serialized.length > CHARACTER_LIMIT) {
        throw new Error(`Shopify returned more than ${CHARACTER_LIMIT} characters for ${store.alias}. Add pagination or request fewer fields.`);
    }
    return envelope;
}
export function requireQuery(document) {
    const normalized = document.replace(/^\s*(#[^\n]*\n\s*)*/, "").trimStart();
    if (/^mutation\b/i.test(normalized)) {
        throw new Error("The query tool does not accept mutations. Use shopify_graphql_mutation.");
    }
    if (!/^(query\b|\{)/i.test(normalized)) {
        throw new Error("The document must start with query or an opening brace.");
    }
}
export function requireMutation(document) {
    const normalized = document.replace(/^\s*(#[^\n]*\n\s*)*/, "").trimStart();
    if (!/^mutation\b/i.test(normalized)) {
        throw new Error("The mutation document must start with mutation.");
    }
}
//# sourceMappingURL=shopify.js.map