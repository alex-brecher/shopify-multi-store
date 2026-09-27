import type { McpServer } from "@modelcontextprotocol/server";
import { type UserShopifyAccess } from "../runtime.js";
import { type AuditLog } from "./audit.js";
import type { Principal, Role } from "./policy.js";
/** Tools only an admin may call in hosted mode, whatever their annotations say. */
export declare const ADMIN_ONLY_TOOLS: ReadonlySet<string>;
/**
 * Generic write tools that are admin-only with the shared app token, but open to every
 * non-viewer in per-user mode, where the caller's own Shopify permissions limit them.
 */
export declare const PER_USER_OPEN_TOOLS: ReadonlySet<string>;
export type ShopifyAccessMode = "per_user" | "app";
/**
 * Tools that need the local machine (Shopify CLI, local preview receipts).
 * They are not registered at all in hosted mode.
 */
export declare const HOSTED_DISABLED_TOOLS: ReadonlySet<string>;
/** Arguments that refer to the server's local filesystem and are refused in hosted mode. */
export declare const HOSTED_DISABLED_ARGUMENTS: Readonly<Record<string, readonly string[]>>;
/** Tools whose named arguments hold a GraphQL document. The audit log keeps only a summary of it. */
export declare const GRAPHQL_DOCUMENT_ARGUMENTS: Readonly<Record<string, readonly string[]>>;
export declare function toolAllowedForRole(role: Role, tool: string, readOnly: boolean, mode?: ShopifyAccessMode): boolean;
export declare function requestedStores(args: unknown): string[];
export interface GuardOptions {
    principal: Principal;
    audit: AuditLog;
    /** Personal access token id when the request used one. Recorded in the audit log; never the value. */
    tokenId?: string;
    /** "per_user" when every call uses the caller's own Shopify token. Defaults to "app". */
    accessMode?: ShopifyAccessMode;
    /** The caller's own Shopify tokens (per-user mode). */
    access?: UserShopifyAccess;
}
/**
 * Wrap McpServer.registerTool so every tool, including ones added later, gets:
 * role filtering (tools the role cannot call are not registered), a store allowlist
 * check on store/stores/alias arguments, a store-scoped context for loadStores(),
 * refusal of local-file arguments, and one audit line per call.
 * Must run before any tool is registered.
 */
export declare function guardServer(server: McpServer, { principal, audit, tokenId, accessMode, access }: GuardOptions): void;
