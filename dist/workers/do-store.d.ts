import type { OAuthStore, RecordKind } from "../hosted/store.js";
import type { DurableObjectNamespaceLike, DurableObjectStateLike } from "./types.js";
type Operation = {
    op: "get" | "take" | "delete";
    kind: RecordKind;
    key: string;
} | {
    op: "put";
    kind: RecordKind;
    key: string;
    value: unknown;
    expiresAt?: number;
} | {
    op: "claim";
    kind: RecordKind;
    key: string;
    flag: string;
} | {
    op: "deleteMatching";
    kind: RecordKind;
    match: Record<string, string | number | boolean>;
} | {
    op: "count" | "entries";
    kind: RecordKind;
};
/**
 * The Durable Object class (wrangler.jsonc binds it as OAUTH_STORE). It speaks a small JSON
 * protocol over fetch, so it needs no Workers-only import and can be tested in Node with an
 * in-memory storage.
 */
export declare class OAuthStoreObject {
    private readonly storage;
    private readonly now;
    constructor(state: DurableObjectStateLike, _env?: unknown, now?: () => number);
    private live;
    private all;
    private deleteKeys;
    /** Run one store operation. Exposed for tests; fetch() is the Durable Object entry point. */
    run(operation: Operation): Promise<unknown>;
    fetch(request: Request): Promise<Response>;
    private scheduleSweep;
    /** Durable Object alarm: drop expired records of every kind, then schedule the next sweep. */
    alarm(): Promise<void>;
}
/** OAuthStore backed by the OAuthStoreObject Durable Object. */
export declare class DurableObjectStore implements OAuthStore {
    private readonly namespace;
    private readonly name;
    constructor(namespace: DurableObjectNamespaceLike, name?: string);
    private call;
    get<T>(kind: RecordKind, key: string): Promise<T | undefined>;
    put<T>(kind: RecordKind, key: string, value: T, expiresAt?: number): Promise<void>;
    take<T>(kind: RecordKind, key: string): Promise<T | undefined>;
    delete(kind: RecordKind, key: string): Promise<void>;
    claim<T>(kind: RecordKind, key: string, flag: string): Promise<{
        value: T;
        claimed: boolean;
    } | undefined>;
    deleteMatching(kind: RecordKind, match: Record<string, string | number | boolean>): Promise<number>;
    count(kind: RecordKind): Promise<number>;
    entries<T>(kind: RecordKind): Promise<Array<[string, T]>>;
}
export {};
