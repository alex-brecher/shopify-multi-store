import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { createServer } from "../server.js";
import { PACKAGE_VERSION } from "../shopify.js";
import type { AuditLog } from "./audit.js";
import type { UserShopifyAccess } from "../runtime.js";
import { guardServer, type ShopifyAccessMode } from "./guard.js";
import { AuthorizationServer, errorPage, SCOPE, type AuthServerOptions } from "./oauth.js";
import type { Principal } from "./policy.js";
import { ShopifyConnections, type ShopifyConnectOptions } from "./shopify-connect.js";
import { PERSONAL_TOKEN_PREFIX, PersonalTokens } from "./tokens.js";

export interface HostedAppOptions extends AuthServerOptions {
  audit: AuditLog;
  /** Personal access tokens at /tokens and as bearer tokens on /mcp. Defaults to true. */
  personalTokensEnabled?: boolean;
  /** Longest personal access token lifetime a user may choose, in days. Defaults to 180. */
  personalTokenMaxDays?: number;
  /**
   * "per_user": every tool call uses the caller's own Shopify online token (connected at /stores).
   * "app" (the default here; serve mode defaults to per_user): the shared app token for each store.
   */
  shopifyAccessMode?: ShopifyAccessMode;
  /**
   * Per-user mode: whether personal access tokens may use the owner's Shopify connections.
   * Off by default. When on, personal tokens are capped at PERSONAL_TOKEN_SHOPIFY_MAX_DAYS.
   */
  personalTokensShopifyAccess?: boolean;
  /** Required in per_user mode. auth, store, policy and now are filled in from these options. */
  shopifyConnect?: Omit<ShopifyConnectOptions, "auth" | "store" | "policy" | "now">;
}

export interface HostedApp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  readonly auth: AuthorizationServer;
  readonly tokens: PersonalTokens;
  readonly accessMode: ShopifyAccessMode;
  /** Present in per_user mode. */
  readonly shopify?: ShopifyConnections;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "600"
};

/** Browser-facing pages. They get no CORS headers. */
const BROWSER_PAGES = new Set(["/authorize", "/oauth/google/callback", "/consent", "/tokens", "/stores", "/shopify/connect", "/shopify/callback"]);

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * The hosted connector as a web-standard fetch handler:
 * OAuth metadata, authorization server, Google sign-in callback, health check,
 * and the Streamable HTTP MCP endpoint at /mcp behind bearer-token auth.
 */
/** Longest personal access token lifetime when personal tokens may use Shopify (per-user mode). */
export const PERSONAL_TOKEN_SHOPIFY_MAX_DAYS = 30;

export function createHostedApp(options: HostedAppOptions): HostedApp {
  const auth = new AuthorizationServer(options);
  const patShopify = options.shopifyAccessMode === "per_user" && options.personalTokensShopifyAccess === true;
  const tokens = new PersonalTokens({
    auth,
    store: options.store,
    policy: options.policy,
    enabled: options.personalTokensEnabled ?? true,
    maxDays: patShopify ? Math.min(options.personalTokenMaxDays ?? 180, PERSONAL_TOKEN_SHOPIFY_MAX_DAYS) : options.personalTokenMaxDays ?? 180,
    ...(options.now ? { now: options.now } : {})
  });
  const accessMode: ShopifyAccessMode = options.shopifyAccessMode ?? "app";
  let shopify: ShopifyConnections | undefined;
  if (accessMode === "per_user") {
    if (!options.shopifyConnect) throw new Error("Per-user Shopify access needs shopifyConnect options.");
    shopify = new ShopifyConnections({ ...options.shopifyConnect, auth, store: options.store, policy: options.policy, ...(options.now ? { now: options.now } : {}) });
    const tokensSignIn = auth.onPageSignIn;
    const connections = shopify;
    auth.onPageSignIn = (purpose, email, principal) => purpose === "stores"
      ? connections.signedIn(email)
      : tokensSignIn ? tokensSignIn(purpose, email, principal) : Promise.resolve(errorPage(404, "This page is not available."));
  }
  const mcpPath = new URL(auth.resource).pathname;

  // Stateless: a fresh McpServer per request, built for the caller's role. No session state,
  // so the server can restart or scale without breaking clients, and auth is checked every request.
  const mcp = createMcpHandler(async (context) => {
    const principal = context.authInfo?.extra?.principal as Principal | undefined;
    if (!principal) throw new Error("Unauthenticated MCP request reached the server factory.");
    const tokenId = context.authInfo?.extra?.tokenId as string | undefined;
    const access = context.authInfo?.extra?.access as UserShopifyAccess | undefined;
    return createServer({ title: auth.displayName, beforeRegister: (server) => guardServer(server, { principal, audit: options.audit, accessMode, ...(access ? { access } : {}), ...(tokenId ? { tokenId } : {}) }) });
  }, {
    legacy: "stateless",
    onerror: (error) => process.stderr.write(`MCP error: ${error.message}\n`)
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
    if (token.startsWith(PERSONAL_TOKEN_PREFIX)) return handlePersonalToken(request, token);
    const record = await auth.verifyAccessToken(token);
    if (!record) {
      await auth.auditAuth({ event: "request_unauthorized", status: 401, reason: "invalid or expired access token" });
      return unauthorized("The access token is invalid or expired.");
    }
    // Resolve the role on every request so policy changes apply immediately.
    const principal = auth.resolvePrincipal(record.email);
    if (!principal) {
      await auth.auditAuth({ event: "request_forbidden", status: 403, user: record.email, clientId: record.clientId, reason: "not in the access policy" });
      return jsonResponse({ error: "access_denied", error_description: `${record.email} no longer has access.` }, 403);
    }
    const authInfo: AuthInfo = {
      token,
      clientId: record.clientId,
      scopes: [record.scope],
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(auth.resource),
      extra: { principal, ...(shopify ? { access: await shopify.accessFor(principal.email) } : {}) }
    };
    return mcp.fetch(request, { authInfo });
  }

  /**
   * Personal access tokens are long-lived bearer secrets, so in per-user mode they carry no Shopify
   * access unless PERSONAL_TOKENS_SHOPIFY_ACCESS=1, and then only tokens of at most 30 days.
   */
  async function personalTokenAccess(connections: ShopifyConnections, email: string, record: { createdAt: number; expiresAt: number }): Promise<UserShopifyAccess> {
    const lifetimeOk = record.expiresAt - record.createdAt <= PERSONAL_TOKEN_SHOPIFY_MAX_DAYS * 24 * 3600_000;
    if (patShopify && lifetimeOk) return connections.accessFor(email);
    const reason = patShopify
      ? `This personal access token lives longer than ${PERSONAL_TOKEN_SHOPIFY_MAX_DAYS} days, so it cannot use Shopify. Create a new one at ${auth.issuer}/tokens.`
      : `Personal access tokens cannot use Shopify on this server (per-user mode). Connect your AI app with OAuth sign-in instead, or ask an administrator to set PERSONAL_TOKENS_SHOPIFY_ACCESS=1.`;
    return { tokens: new Map(), storesUrl: connections.storesUrl, connectUrl: (alias) => connections.connectUrl(alias), now: options.now ?? Date.now, blockedReason: reason };
  }

  async function handlePersonalToken(request: Request, token: string): Promise<Response> {
    const record = await tokens.verify(token);
    if (!record) {
      await auth.auditAuth({ event: "request_unauthorized", status: 401, reason: "invalid, expired, or revoked personal access token" });
      return unauthorized("The personal access token is invalid, expired, or revoked.");
    }
    // Same policy re-check as OAuth tokens, on every request.
    const principal = auth.resolvePrincipal(record.email);
    if (!principal) {
      await auth.auditAuth({ event: "request_forbidden", status: 403, user: record.email, clientId: "personal-token", tokenId: record.id, reason: "not in the access policy" });
      return jsonResponse({ error: "access_denied", error_description: `${record.email} no longer has access.` }, 403);
    }
    const authInfo: AuthInfo = {
      token,
      clientId: "personal-token",
      scopes: [SCOPE],
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(auth.resource),
      extra: { principal, tokenId: record.id, ...(shopify ? { access: await personalTokenAccess(shopify, principal.email, record) } : {}) }
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
    if (path === "/oauth/google/callback") return method === "GET" ? auth.googleCallback(request) : jsonResponse({ error: "method_not_allowed" }, 405);
    if (path === "/tokens") return tokens.handle(request);
    if (shopify && path === "/stores") return shopify.handleStoresPage(request);
    if (shopify && path === "/shopify/connect") return shopify.connect(request);
    if (shopify && path === "/shopify/callback") return shopify.callback(request);
    if (path === "/consent") return method === "POST" ? auth.consent(request) : jsonResponse({ error: "method_not_allowed" }, 405);
    if (path === "/token") return method === "POST" ? auth.token(request) : jsonResponse({ error: "method_not_allowed" }, 405);
    if (path === "/register") return method === "POST" ? auth.register(request) : jsonResponse({ error: "method_not_allowed" }, 405);
    if (path === mcpPath) return handleMcp(request);
    return jsonResponse({ error: "not_found" }, 404);
  }

  return {
    auth,
    tokens,
    accessMode,
    ...(shopify ? { shopify } : {}),
    async fetch(request: Request): Promise<Response> {
      let response: Response;
      try {
        response = await route(request);
      } catch (error) {
        process.stderr.write(`Request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        response = jsonResponse({ error: "server_error" }, 500);
      }
      const path = new URL(request.url).pathname;
      // Browser-facing sign-in pages do not need CORS; API endpoints use bearer tokens, not cookies.
      return BROWSER_PAGES.has(path) ? response : withCors(response);
    },
    close: () => mcp.close()
  };
}
