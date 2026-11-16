/**
 * Read-only mode: block every Admin API write for the whole server, for chosen stores, or for
 * chosen people. Set with plain settings, never secrets, so the rules are visible in the
 * deployment config:
 *
 * - SHOPIFY_READ_ONLY=true            no writes for anyone, on any store
 * - SHOPIFY_READ_ONLY_STORES=a,b       no writes on stores a and b, for anyone
 * - SHOPIFY_READ_ONLY_USERS=x@y.com    no writes for that person (hosted server only)
 *   SHOPIFY_READ_ONLY_USERS=x@y.com:a  no writes for that person on store a only
 *
 * Enforced where every Shopify call is sent (adminGraphql), so no tool can get around it.
 */
/** Mutations that change nothing in the store: previews and read-only exports. */
export declare const READ_SAFE_MUTATIONS: ReadonlySet<string>;
type Env = Readonly<Record<string, string | undefined>>;
/** Whether writes to this store are blocked for this person (default: the caller of the current tool call). */
export declare function isReadOnly(alias: string, email?: string | undefined, env?: Env): boolean;
/** Whether this person can write nowhere, so write tools can be left out of their tool list. */
export declare function readOnlyEverywhere(email?: string | undefined, env?: Env): boolean;
export declare class ReadOnlyError extends Error {
    name: string;
}
/** Refuse a mutation on a read-only store before it reaches Shopify. Queries and read-safe mutations pass. */
export declare function assertWritable(alias: string, document: string): void;
export {};
