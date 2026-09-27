import { type GraphQLField, type GraphQLOutputType, type GraphQLSchema } from "graphql";
/**
 * A catalog of every Admin API mutation in a bundled schema, for the generic action tools.
 * Everything here is derived from the schema at runtime, except three small hand-kept tables:
 * category overrides, the dedicated-tool map, and scope hints.
 */
export declare const CATEGORIES: readonly ["orders", "fulfillment", "inventory", "products", "customers", "discounts", "content", "markets", "marketing", "checkout", "subscriptions", "pos", "platform"];
export type Category = (typeof CATEGORIES)[number];
/** The category for a mutation, or undefined when no rule matches (a test keeps that at zero). */
export declare function classifyMutation(name: string): Category | undefined;
/**
 * Name fragments that make a mutation destructive: shopify_run_action then requires confirm
 * equal to the mutation name. Keep this the only list.
 */
export declare const DESTRUCTIVE_WORDS: readonly ["delete", "remove", "cancel", "refund", "void", "debit", "deactivate", "revoke", "close", "archive", "disable", "erasure", "uninstall", "destroy", "merge", "expire", "dispose", "unpublish"];
/**
 * Mutations whose names do not say so but that overwrite or replace data wholesale, move money,
 * or change what customers see at once. They need confirm like the name-matched ones.
 */
export declare const DESTRUCTIVE_MUTATIONS: ReadonlySet<string>;
export declare function isDestructive(name: string): boolean;
/**
 * Mutations refused by default: ones that mint credentials or change this app's own installation
 * or billing; webhook and server-pixel subscriptions, which deliver data to an endpoint with the
 * app's scopes long after the caller's own token has expired; and bulkOperationRunMutation, which
 * hides the inner mutation from the denylist and the confirm check.
 * ACTIONS_DENYLIST adds entries (comma list; a trailing * matches a prefix);
 * ACTIONS_DENYLIST_REPLACE=1 makes it replace this list instead.
 */
export declare const DEFAULT_DENYLIST: readonly string[];
export declare function denylist(env?: NodeJS.ProcessEnv): string[];
export declare function isDenied(name: string, list?: readonly string[]): boolean;
/** Mutations that already have a dedicated, guided tool. */
export declare const DEDICATED_TOOLS: Readonly<Record<string, readonly string[]>>;
export declare function scopeHint(name: string, description?: string): string[];
export interface CatalogEntry {
    name: string;
    summary: string;
    category: Category;
    destructive: boolean;
    denied: boolean;
    deprecated: boolean;
    dedicatedTools: string[];
    inputTypes: string[];
    scopeHint: string[];
    /** Lower-case search text: split name words, input type names, and description. */
    searchText: string;
}
/** First sentence of a GraphQL description, without markdown links, capped. */
export declare function summarize(description: string | null | undefined, max?: number): string;
export declare function mutationFields(schema: GraphQLSchema): GraphQLField<unknown, unknown>[];
/** The catalog for one API version, built once and cached. */
export declare function actionCatalog(version: string): Promise<CatalogEntry[]>;
export interface FindOptions {
    query?: string;
    category?: Category;
    includeDeprecated?: boolean;
    limit: number;
    offset: number;
}
/** Keyword search ranked by where the words match: name first, then input types, then description. */
export declare function searchCatalog(entries: CatalogEntry[], options: FindOptions): {
    total: number;
    offset: number;
    nextOffset?: number | undefined;
    actions: {
        name: string;
        description: string;
        category: "checkout" | "content" | "customers" | "discounts" | "fulfillment" | "inventory" | "marketing" | "markets" | "orders" | "platform" | "pos" | "products" | "subscriptions";
        destructive: boolean;
        deprecated?: boolean | undefined;
        denied?: boolean | undefined;
        dedicatedTools: string[];
        scopeHint: string[];
    }[];
};
export interface InputFieldDescription {
    name: string;
    type: string;
    required: boolean;
    description?: string;
    defaultValue?: unknown;
    enumValues?: string[];
    fields?: InputFieldDescription[];
    /** Set when the nested fields were not expanded (depth limit or a recursive type). */
    seeType?: string;
}
/** Default selection for a mutation payload: scalars, record ids and labels, and every *userErrors list. */
export declare function defaultSelection(payload: GraphQLOutputType): string;
export declare function findMutation(schema: GraphQLSchema, name: string): GraphQLField<unknown, unknown> | undefined;
/** A ready-to-edit document that declares every argument as a variable. */
export declare function buildDocument(field: GraphQLField<unknown, unknown>, selection?: string): string;
export declare function describeAction(name: string, version: string, depth?: number): Promise<{
    name: string;
    apiVersion: string;
    description: string;
    category: "checkout" | "content" | "customers" | "discounts" | "fulfillment" | "inventory" | "marketing" | "markets" | "orders" | "platform" | "pos" | "products" | "subscriptions";
    destructive: boolean;
    confirmRequired?: string | undefined;
    denied: boolean;
    deprecated?: string | undefined;
    dedicatedTools: string[];
    scopeHint: string[];
    arguments: {
        enumValues?: string[];
        fields?: InputFieldDescription[];
        seeType?: string;
        name: string;
        type: string;
        required: boolean;
        description?: string | undefined;
        defaultValue?: {} | null | undefined;
    }[];
    returns: {
        type: string;
        fields: {
            name: string;
            type: string;
            deprecated?: boolean | undefined;
            description?: string | undefined;
        }[];
    };
    document: string;
    variablesTemplate: Record<string, unknown>;
}>;
