import type { McpServer } from "@modelcontextprotocol/server";
import { type DocumentNode, type FieldNode, type GraphQLSchema, type OperationDefinitionNode } from "graphql";
import { type StoreConfig } from "../config.js";
type Data = Record<string, unknown>;
interface ParsedAction {
    ast: DocumentNode;
    operation: OperationDefinitionNode;
    /** Root mutation fields in document order, fragments included. */
    rootFields: string[];
    /** Every root field call (an aliased field called twice appears twice), for argument checks. */
    rootNodes: FieldNode[];
}
/** Parse a caller-supplied document: exactly one operation, a mutation, executable definitions only. */
export declare function parseActionDocument(document: string): ParsedAction;
/**
 * The destructive mutations a document calls, in document order: by name, and by the resolved
 * argument values (inline literals with each variable set substituted) under the argument rules
 * in DESTRUCTIVE_ARGUMENT_RULES. Several variable sets (one per store) are checked together, and
 * a mutation destructive under any of them is included.
 */
export declare function destructiveMutations(parsed: ParsedAction, variableSets?: readonly Data[]): string[];
/** Every Shopify GID string anywhere in a value. */
export declare function collectGids(value: unknown, found?: Set<string>, depth?: number): Set<string>;
/** A nodes(ids:) query with a small label selection for each GID type the schema knows. */
export declare function resolveQuery(schema: GraphQLSchema, ids: Iterable<string>): string;
/** Turn Shopify ACCESS_DENIED errors (or HTTP 403) into a plain sentence naming the scope and store. */
export declare function accessDeniedMessage(errors: unknown, alias: string, mutations: string[]): string | undefined;
/**
 * The shared write policy for shopify_run_action and (in per-user mode) shopify_graphql_mutation:
 * refuse denylisted mutations, and require confirm equal to the destructive mutation names
 * (comma-separated, in document order) before applying. Returns the refusal, or undefined.
 */
export declare function actionPolicyError(mutations: string[], confirm: unknown, applying: boolean, destructiveNames?: string[]): string | undefined;
/**
 * Send one mutation document to one store with every root's error lists injected, and judge each
 * root on its own. Used by shopify_graphql_mutation. When the document cannot be checked against
 * the schema (it does not validate, or the schema cannot be loaded), it is sent unchanged, as
 * before, and the result says the outcome was not analyzed.
 */
export declare function sendMutationWithOutcome(store: StoreConfig, document: string, variables: Data): Promise<Data & {
    outcome?: string;
}>;
export declare function registerActionTools(server: McpServer): void;
export {};
