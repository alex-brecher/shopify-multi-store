import { type DocumentNode, type GraphQLSchema } from "graphql";
import type { GraphqlEnvelope } from "../shopify.js";
/**
 * Per-root mutation outcomes.
 *
 * Before a mutation is sent, every top-level mutation field gets its payload's error lists
 * (userErrors and any other *Errors list of objects with a message) added under a reserved
 * alias, `smsUserErrors_<field>`. Detection then never depends on how the caller selected or
 * aliased the error list, or whether they selected it at all. The injected keys are removed from
 * the data handed back. Each root is judged on its own, so one failing root in a document never
 * hides another that applied.
 */
export declare const RESERVED_ALIAS_PREFIX = "smsUserErrors";
type Data = Record<string, unknown>;
export interface MutationRoot {
    /** Response key: the alias if given, otherwise the field name. */
    key: string;
    mutation: string;
    /** Error-list fields injected on the payload: schema field name and the reserved alias used. */
    errorFields: Array<{
        field: string;
        alias: string;
    }>;
}
export interface InstrumentedMutation {
    document: string;
    roots: MutationRoot[];
}
export type RootOutcome = "applied" | "rejected" | "unknown";
export type StoreOutcome = "applied" | "rejected" | "partial" | "unknown";
export interface RootResult {
    key: string;
    mutation: string;
    outcome: RootOutcome;
    userErrors?: unknown[];
    errors?: unknown[];
    reason?: string;
}
export interface OutcomeReport {
    outcome: StoreOutcome;
    roots: RootResult[];
    /** Every user error as { path: [responseKey, errorField], error }. */
    userErrors: Array<{
        path: string[];
        error: unknown;
    }>;
    /** The response data with the injected error lists removed. */
    data: unknown;
    applied: string[];
    rejected: string[];
    unknown: string[];
    advice?: string;
}
/**
 * Add the payload's error lists under reserved aliases to every top-level mutation field, found
 * with TypeInfo so fields inside inline fragments and fragments on Mutation count too. The
 * document must already be valid against the schema.
 */
export declare function instrumentMutation(schema: GraphQLSchema, ast: DocumentNode, variables?: Data): InstrumentedMutation;
/** Judge each root of an instrumented mutation from Shopify's response, then the store as a whole. */
export declare function evaluateOutcome(roots: MutationRoot[], envelope: Pick<GraphqlEnvelope, "data" | "errors">): OutcomeReport;
export {};
