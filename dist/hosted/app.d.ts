import type { AuditLog } from "./audit.js";
import { AuthorizationServer, type AuthServerOptions } from "./oauth.js";
export interface HostedAppOptions extends AuthServerOptions {
    audit: AuditLog;
}
export interface HostedApp {
    fetch(request: Request): Promise<Response>;
    close(): Promise<void>;
    readonly auth: AuthorizationServer;
}
/**
 * The hosted connector as a web-standard fetch handler:
 * OAuth metadata, authorization server, Google sign-in callback, health check,
 * and the Streamable HTTP MCP endpoint at /mcp behind bearer-token auth.
 */
export declare function createHostedApp(options: HostedAppOptions): HostedApp;
