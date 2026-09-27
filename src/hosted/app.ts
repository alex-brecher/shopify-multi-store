import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { createServer } from "../server.js";
import { PACKAGE_VERSION } from "../shopify.js";
import type { AuditLog } from "./audit.js";
import type { UserShopifyAccess } from "../runtime.js";
import { guardServer, type Principal } from "./guard.js";
import { AuthorizationServer, SCOPE, type AuthServerOptions } from "./oauth.js";
import { ShopifyConnections, type ShopifyConnectOptions } from "./shopify-connect.js";

export interface HostedAppOptions extends AuthServerOptions {
  audit: AuditLog;
  /** Shopify app credentials, token encryption and the configured stores. auth, store and now come from these options. */
  shopifyConnect: Omit<ShopifyConnectOptions, "auth" | "store" | "now">;
}

export interface HostedApp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  readonly auth: AuthorizationServer;
  readonly shopify: ShopifyConnections;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "600"
};

/** Browser-facing pages. They get no CORS headers. */
const BROWSER_PAGES = new Set(["/authorize", "/consent", "/stores", "/stores/reconnect", "/shopify/connect", "/shopify/callback", "/login/shopify"]);

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * The hosted connector as a web-standard fetch handler: OAuth metadata, the authorization
 * server, Shopify sign-in, the /stores page, a health check, and the Streamable HTTP MCP
 * endpoint at /mcp behind bearer-token auth. Every tool call uses the caller's own Shopify
 * online token, so Shopify's staff permissions decide what each person can do.
 */
export function createHostedApp(options: HostedAppOptions): HostedApp {
  const auth = new AuthorizationServer(options);
  const shopify = new ShopifyConnections({ ...options.shopifyConnect, auth, store: options.store, ...(options.now ? { now: options.now } : {}) });
  auth.onPageSignIn = (purpose, email) => shopify.signedIn(email, purpose);
  const mcpPath = new URL(auth.resource).pathname;

  // Stateless: a fresh McpServer per request, built for the caller. No session state, so the
  // server can restart or scale without breaking clients, and auth is checked every request.
  const mcp = createMcpHandler(async (context) => {
    const principal = context.authInfo?.extra?.principal as Principal | undefined;
    const access = context.authInfo?.extra?.access as UserShopifyAccess | undefined;
    if (!principal || !access) throw new Error("Unauthenticated MCP request reached the server factory.");
    return createServer({ title: auth.displayName, beforeRegister: (server) => guardServer(server, { principal, audit: options.audit, access }) });
  }, {
    legacy: "stateless",
    onerror: (error) => console.error(`MCP error: ${error.message}`)
  });

  const unauthorized = (description?: string): Response => {
    const parts = [
      ...(description ? [`error="invalid_token"`, `error_description="${description}"`] : []),
      `resource_metadata="${auth.resourceMetadataUrl}"`,
      `scope="${SCOPE}"`
    ];
    return jsonResponse(
      { error: description ? "invalid_token" : "unauthorized", error_description: description ?? "Authorization required." },
      401,
      { "www-authenticate": `Bearer ${parts.join(", ")}` }
    );
  };

  async function handleMcp(request: Request): Promise<Response> {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      await auth.auditAuth({ event: "request_unauthorized", status: 401, reason: "missing bearer token" });
      return unauthorized();
    }
    const token = match[1]!;
    const record = await auth.verifyAccessToken(token);
    if (!record) {
      await auth.auditAuth({ event: "request_unauthorized", status: 401, reason: "invalid or expired access token" });
      return unauthorized("The access token is invalid or expired.");
    }
    const principal: Principal = { email: record.email };
    const authInfo: AuthInfo = {
      token,
      clientId: record.clientId,
      scopes: [record.scope],
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(auth.resource),
      extra: { principal, access: await shopify.accessFor(principal.email) }
    };
    return mcp.fetch(request, { authInfo });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return new Response(null, { status: 204 });

    if (path === "/healthz") {
      return method === "GET" ? jsonResponse({ ok: true, version: PACKAGE_VERSION }) : jsonResponse({ error: "method_not_allowed" }, 405);
    }
    if (path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${mcpPath}`) {
      return jsonResponse(auth.protectedResourceMetadata(), 200, { "cache-control": "public, max-age=3600" });
    }
    if (path === "/.well-known/oauth-authorization-server" || path === `/.well-known/oauth-authorization-server${mcpPath}`) {
      return jsonResponse(auth.authorizationServerMetadata(), 200, { "cache-control": "public, max-age=3600" });
    }
    if (path === "/authorize") return method === "GET" ? auth.authorize(url) : jsonResponse({ error: "method_not_allowed" }, 405);
    if (path === "/login/shopify") return shopify.chooseLogin(request);
    if (path === "/stores") return shopify.handleStoresPage(request);
    if (path === "/stores/reconnect") return shopify.handleReconnect(request);
    if (path === "/shopify/connect") return shopify.connect(request);
    if (path === "/shopify/callback") return shopify.callback(request);
    if (path === "/consent") return method === "POST" ? auth.consent(request) : jsonResponse({ error: "method_not_allowed" }, 405);
    if (path === "/token") return method === "POST" ? auth.token(request) : jsonResponse({ error: "method_not_allowed" }, 405);
    if (path === "/register") return method === "POST" ? auth.register(request) : jsonResponse({ error: "method_not_allowed" }, 405);
    if (path === mcpPath) return handleMcp(request);
    return jsonResponse({ error: "not_found" }, 404);
  }

  return {
    auth,
    shopify,
    async fetch(request: Request): Promise<Response> {
      let response: Response;
      try {
        response = await route(request);
      } catch (error) {
        console.error(`Request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        response = jsonResponse({ error: "server_error" }, 500);
      }
      const path = new URL(request.url).pathname;
      // Browser-facing sign-in pages do not need CORS; API endpoints use bearer tokens, not cookies.
      return BROWSER_PAGES.has(path) ? response : withCors(response);
    },
    close: () => mcp.close()
  };
}
