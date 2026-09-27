import type { AuditLog } from "./audit.js";
import { AuthorizationServer, type AuthServerOptions } from "./oauth.js";
import { PersonalTokens } from "./tokens.js";
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
/**
 * The hosted connector as a web-standard fetch handler:
 * OAuth metadata, authorization server, Google sign-in callback, health check,
 * and the Streamable HTTP MCP endpoint at /mcp behind bearer-token auth.
 */
export declare function createHostedApp(options: HostedAppOptions): HostedApp;
