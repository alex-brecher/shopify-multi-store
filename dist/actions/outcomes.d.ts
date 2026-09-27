import { type DocumentNode, type FieldNode, type GraphQLSchema } from "graphql";
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
/** False only when @skip/@include on the node itself definitely leave it out. */
export declare function included(node: FieldNode, variables: Data): boolean;
/**
 * Add the payload's error lists under reserved aliases to every top-level mutation field, found
 * with TypeInfo so fields inside inline fragments and fragments on Mutation count too. The
 * document must already be valid against the schema.
 */
export declare function instrumentMutation(schema: GraphQLSchema, ast: DocumentNode, variables?: Data): InstrumentedMutation;
/** Judge each root of an instrumented mutation from Shopify's response, then the store as a whole. */
export declare function evaluateOutcome(roots: MutationRoot[], envelope: Pick<GraphqlEnvelope, "data" | "errors">): OutcomeReport;
/**
 * Judge a mutation response without the Admin schema (it could not be loaded, or the document
 * or variables did not validate, so no error lists were injected). The check is structural and
 * alias-agnostic: under each top-level response key, any list of objects that have a "message"
 * key is that root's user errors, whatever it was aliased to. A root is:
 * - rejected when such a list is non-empty (or access was denied);
 * - applied only when its payload is present, it has no errors on its path, and it holds an
 *   empty list under a key ending in "errors", so an error list was selected and came back empty;
 * - unknown otherwise: nothing shows whether it applied. It is never reported as applied.
 */
export declare function evaluateOutcomeStructural(document: string, envelope: Pick<GraphqlEnvelope, "data" | "errors">): OutcomeReport;
export {};
