import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "../server.js";
import { PACKAGE_VERSION } from "../shopify.js";
import { guardServer } from "./guard.js";
import { AuthorizationServer, SCOPE } from "./oauth.js";
const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
    "access-control-expose-headers": "www-authenticate, mcp-session-id, mcp-protocol-version",
    "access-control-max-age": "600"
};
function withCors(response) {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS))
        headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
/**
 * The hosted connector as a web-standard fetch handler:
 * OAuth metadata, authorization server, Google sign-in callback, health check,
 * and the Streamable HTTP MCP endpoint at /mcp behind bearer-token auth.
 */
export function createHostedApp(options) {
    const auth = new AuthorizationServer(options);
    const mcpPath = new URL(auth.resource).pathname;
    // Stateless: a fresh McpServer per request, built for the caller's role. No session state,
    // so the server can restart or scale without breaking clients, and auth is checked every request.
    const mcp = createMcpHandler(async (context) => {
        const principal = context.authInfo?.extra?.principal;
        if (!principal)
            throw new Error("Unauthenticated MCP request reached the server factory.");
        return createServer({ beforeRegister: (server) => guardServer(server, { principal, audit: options.audit }) });
    }, {
        legacy: "stateless",
        onerror: (error) => process.stderr.write(`MCP error: ${error.message}\n`)
    });
    const unauthorized = (description) => {
        const parts = [
            ...(description ? [`error="invalid_token"`, `error_description="${description}"`] : []),
            `resource_metadata="${auth.resourceMetadataUrl}"`,
            `scope="${SCOPE}"`
        ];
        return jsonResponse({ error: description ? "invalid_token" : "unauthorized", error_description: description ?? "Authorization required." }, 401, { "www-authenticate": `Bearer ${parts.join(", ")}` });
    };
    async function handleMcp(request) {
        const header = request.headers.get("authorization") ?? "";
        const match = /^Bearer\s+(\S+)$/i.exec(header);
        if (!match)
            return unauthorized();
        const record = await auth.verifyAccessToken(match[1]);
        if (!record)
            return unauthorized("The access token is invalid or expired.");
        // Resolve the role on every request so policy changes apply immediately.
        const principal = auth.resolvePrincipal(record.email);
        if (!principal) {
            return jsonResponse({ error: "access_denied", error_description: `${record.email} no longer has access.` }, 403);
        }
        const authInfo = {
            token: match[1],
            clientId: record.clientId,
            scopes: [record.scope],
            expiresAt: Math.floor(record.expiresAt / 1000),
            resource: new URL(auth.resource),
            extra: { principal }
        };
        return mcp.fetch(request, { authInfo });
    }
    async function route(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method.toUpperCase();
        if (method === "OPTIONS")
            return new Response(null, { status: 204 });
        if (path === "/healthz") {
            return method === "GET" ? jsonResponse({ ok: true, version: PACKAGE_VERSION }) : jsonResponse({ error: "method_not_allowed" }, 405);
        }
        if (path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${mcpPath}`) {
            return jsonResponse(auth.protectedResourceMetadata(), 200, { "cache-control": "public, max-age=3600" });
        }
        if (path === "/.well-known/oauth-authorization-server" || path === `/.well-known/oauth-authorization-server${mcpPath}`) {
            return jsonResponse(auth.authorizationServerMetadata(), 200, { "cache-control": "public, max-age=3600" });
        }
        if (path === "/authorize")
            return method === "GET" ? auth.authorize(url) : jsonResponse({ error: "method_not_allowed" }, 405);
        if (path === "/oauth/google/callback")
            return method === "GET" ? auth.googleCallback(url) : jsonResponse({ error: "method_not_allowed" }, 405);
        if (path === "/token")
            return method === "POST" ? auth.token(request) : jsonResponse({ error: "method_not_allowed" }, 405);
        if (path === "/register")
            return method === "POST" ? auth.register(request) : jsonResponse({ error: "method_not_allowed" }, 405);
        if (path === mcpPath)
            return handleMcp(request);
        return jsonResponse({ error: "not_found" }, 404);
    }
    return {
        auth,
        async fetch(request) {
            let response;
            try {
                response = await route(request);
            }
            catch (error) {
                process.stderr.write(`Request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
                response = jsonResponse({ error: "server_error" }, 500);
            }
            const path = new URL(request.url).pathname;
            // Browser-facing sign-in pages do not need CORS; API endpoints use bearer tokens, not cookies.
            return path === "/authorize" || path === "/oauth/google/callback" ? response : withCors(response);
        },
        close: () => mcp.close()
    };
}
//# sourceMappingURL=app.js.map