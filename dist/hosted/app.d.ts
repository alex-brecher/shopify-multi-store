import type { AuditLog } from "./audit.js";
import { type ShopifyAccessMode } from "./guard.js";
import { AuthorizationServer, type AuthServerOptions } from "./oauth.js";
import { ShopifyConnections, type ShopifyConnectOptions } from "./shopify-connect.js";
import { PersonalTokens } from "./tokens.js";
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
/**
 * The hosted connector as a web-standard fetch handler:
 * OAuth metadata, authorization server, Google sign-in callback, health check,
 * and the Streamable HTTP MCP endpoint at /mcp behind bearer-token auth.
 */
export declare function createHostedApp(options: HostedAppOptions): HostedApp;
