import type { McpServer } from "@modelcontextprotocol/server";
import { type UserShopifyAccess } from "../runtime.js";
import { type AuditLog } from "./audit.js";
/**
 * A signed-in hosted user. Hosted access has no roles or store lists of its own: every tool
 * call runs with the caller's own Shopify online token, so Shopify's staff permissions are
 * the only rule.
 */
export interface Principal {
    /** Lower-case, verified email of the caller's Shopify staff account. */
    email: string;
}
/**
 * Tools that need the local machine (Shopify CLI, local preview receipts).
 * They are not registered at all in hosted mode.
 */
export declare const HOSTED_DISABLED_TOOLS: ReadonlySet<string>;
/** Arguments that refer to the server's local filesystem and are refused in hosted mode. */
export declare const HOSTED_DISABLED_ARGUMENTS: Readonly<Record<string, readonly string[]>>;
/** Tools whose named arguments hold a GraphQL document. The audit log keeps only a summary of it. */
export declare const GRAPHQL_DOCUMENT_ARGUMENTS: Readonly<Record<string, readonly string[]>>;
export declare function requestedStores(args: unknown): string[];
export interface GuardOptions {
    principal: Principal;
    audit: AuditLog;
    /** The caller's own Shopify tokens. Every Admin API call uses them; there is no app token. */
    access: UserShopifyAccess;
}
/**
 * Wrap McpServer.registerTool so every tool, including ones added later, runs in a store
 * scope carrying the caller's own Shopify tokens (loadStores() and every Admin API call use
 * them), refuses local-file arguments, and writes one audit line per call. Tools that need
 * the local machine are not registered. Must run before any tool is registered.
 */
export declare function guardServer(server: McpServer, { principal, audit, access }: GuardOptions): void;
