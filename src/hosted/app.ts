import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { createServer } from "../server.js";
import { PACKAGE_VERSION } from "../shopify.js";
import type { AuditLog } from "./audit.js";
import { guardServer } from "./guard.js";
import { AuthorizationServer, SCOPE, type AuthServerOptions } from "./oauth.js";
import type { Principal } from "./policy.js";
import { PERSONAL_TOKEN_PREFIX, PersonalTokens } from "./tokens.js";

export interface HostedAppOptions extends AuthServerOptions {
  audit: AuditLog;
  /** Personal access tokens at /tokens and as bearer tokens on /mcp. Defaults to true. */
  personalTokensEnabled?: boolean;
  /** Longest personal access token lifetime a user may choose, in days. Defaults to 180. */
  personalTokenMaxDays?: number;
}

export interface HostedApp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  readonly auth: AuthorizationServer;
  readonly tokens: PersonalTokens;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "600"
};

/** Browser-facing pages. They get no CORS headers. */
const BROWSER_PAGES = new Set(["/authorize", "/oauth/google/callback", "/consent", "/tokens"]);

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
export function createHostedApp(options: HostedAppOptions): HostedApp {
  const auth = new AuthorizationServer(options);
  const tokens = new PersonalTokens({
    auth,
    store: options.store,
    policy: options.policy,
    enabled: options.personalTokensEnabled ?? true,
    maxDays: options.personalTokenMaxDays ?? 180,
    ...(options.now ? { now: options.now } : {})
  });
  const mcpPath = new URL(auth.resource).pathname;

  // Stateless: a fresh McpServer per request, built for the caller's role. No session state,
  // so the server can restart or scale without breaking clients, and auth is checked every request.
  const mcp = createMcpHandler(async (context) => {
    const principal = context.authInfo?.extra?.principal as Principal | undefined;
    if (!principal) throw new Error("Unauthenticated MCP request reached the server factory.");
    const tokenId = context.authInfo?.extra?.tokenId as string | undefined;
    return createServer({ title: auth.displayName, beforeRegister: (server) => guardServer(server, { principal, audit: options.audit, ...(tokenId ? { tokenId } : {}) }) });
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
      extra: { principal }
    };
    return mcp.fetch(request, { authInfo });
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
      extra: { principal, tokenId: record.id }
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
    if (path === "/consent") return method === "POST" ? auth.consent(request) : jsonResponse({ error: "method_not_allowed" }, 405);
    if (path === "/token") return method === "POST" ? auth.token(request) : jsonResponse({ error: "method_not_allowed" }, 405);
    if (path === "/register") return method === "POST" ? auth.register(request) : jsonResponse({ error: "method_not_allowed" }, 405);
    if (path === mcpPath) return handleMcp(request);
    return jsonResponse({ error: "not_found" }, 404);
  }

  return {
    auth,
    tokens,
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
