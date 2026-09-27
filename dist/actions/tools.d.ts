import type { McpServer } from "@modelcontextprotocol/server";
import { type DocumentNode, type GraphQLSchema, type OperationDefinitionNode } from "graphql";
interface ParsedAction {
    ast: DocumentNode;
    operation: OperationDefinitionNode;
    /** Root mutation fields in document order, fragments included. */
    rootFields: string[];
}
/** Parse a caller-supplied document: exactly one operation, a mutation, executable definitions only. */
export declare function parseActionDocument(document: string): ParsedAction;
/** Every Shopify GID string anywhere in a value. */
export declare function collectGids(value: unknown, found?: Set<string>, depth?: number): Set<string>;
/** A nodes(ids:) query with a small label selection for each GID type the schema knows. */
export declare function resolveQuery(schema: GraphQLSchema, ids: Iterable<string>): string;
/** Every entry of every *userErrors list in the response data. */
export declare function collectUserErrors(value: unknown, path?: string[], out?: Array<{
    path: string[];
    error: unknown;
}>, depth?: number): Array<{
    path: string[];
    error: unknown;
}>;
/** Turn Shopify ACCESS_DENIED errors (or HTTP 403) into a plain sentence naming the scope and store. */
export declare function accessDeniedMessage(errors: unknown, alias: string, mutations: string[]): string | undefined;
/**
 * The shared write policy for shopify_run_action and (in per-user mode) shopify_graphql_mutation:
 * refuse denylisted mutations, and require confirm equal to the destructive mutation names
 * (comma-separated, in document order) before applying. Returns the refusal, or undefined.
 */
export declare function actionPolicyError(mutations: string[], confirm: unknown, applying: boolean): string | undefined;
export declare function registerActionTools(server: McpServer): void;
export {};
