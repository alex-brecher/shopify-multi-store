import type { AuditLog } from "./audit.js";
import { AuthorizationServer, type AuthServerOptions } from "./oauth.js";
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
/**
 * The hosted connector as a web-standard fetch handler: OAuth metadata, the authorization
 * server, Shopify sign-in, the /stores page, a health check, and the Streamable HTTP MCP
 * endpoint at /mcp behind bearer-token auth. Every tool call uses the caller's own Shopify
 * online token, so Shopify's staff permissions decide what each person can do.
 */
export declare function createHostedApp(options: HostedAppOptions): HostedApp;
