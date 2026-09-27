import { type DocumentNode, type GraphQLSchema } from "graphql";
/**
 * Dry-run target analysis for shopify_run_action: which records a document names, and whether
 * that list can be the whole impact. A document whose targets come from a search, a saved search,
 * a filter, or an "all" flag cannot be previewed record by record.
 */
type Data = Record<string, unknown>;
/**
 * Why a document's targets cannot be listed from its IDs: search, saved-search, filter, or
 * "all" style mutations and arguments. Empty when every target is named by ID.
 */
export declare function nonEnumerableReasons(schema: GraphQLSchema, ast: DocumentNode, variables: Data): string[];
/** Every Shopify GID written as a string literal in the document. */
export declare function literalGids(ast: DocumentNode, test: (value: string) => boolean): string[];
export {};
