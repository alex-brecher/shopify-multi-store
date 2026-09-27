import type { McpServer } from "@modelcontextprotocol/server";
import { type AuditLog } from "./audit.js";
import type { Principal, Role } from "./policy.js";
/** Tools only an admin may call in hosted mode, whatever their annotations say. */
export declare const ADMIN_ONLY_TOOLS: ReadonlySet<string>;
/**
 * Tools that need the local machine (Shopify CLI, local preview receipts).
 * They are not registered at all in hosted mode.
 */
export declare const HOSTED_DISABLED_TOOLS: ReadonlySet<string>;
/** Arguments that refer to the server's local filesystem and are refused in hosted mode. */
export declare const HOSTED_DISABLED_ARGUMENTS: Readonly<Record<string, readonly string[]>>;
export declare function toolAllowedForRole(role: Role, tool: string, readOnly: boolean): boolean;
export declare function requestedStores(args: unknown): string[];
export interface GuardOptions {
    principal: Principal;
    audit: AuditLog;
}
/**
 * Wrap McpServer.registerTool so every tool, including ones added later, gets:
 * role filtering (tools the role cannot call are not registered), a store allowlist
 * check on store/stores/alias arguments, a store-scoped context for loadStores(),
 * refusal of local-file arguments, and one audit line per call.
 * Must run before any tool is registered.
 */
export declare function guardServer(server: McpServer, { principal, audit }: GuardOptions): void;
