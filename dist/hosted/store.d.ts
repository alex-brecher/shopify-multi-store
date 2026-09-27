/** Record kinds kept by the authorization server. Secrets (codes, tokens) are stored only as sha256 keys. */
export type RecordKind = "client" | "pending" | "code" | "access" | "refresh" | "consent" | "approval" | "pat" | "session" | "shopify_state" | "shopify_token";
export interface OAuthStore {
    get<T>(kind: RecordKind, key: string): Promise<T | undefined>;
    put<T>(kind: RecordKind, key: string, value: T, expiresAt?: number): Promise<void>;
    /** Read and delete in one step. Used for single-use authorization codes and login state. */
    take<T>(kind: RecordKind, key: string): Promise<T | undefined>;
    delete(kind: RecordKind, key: string): Promise<void>;
    /** Delete every record of a kind that matches. Returns the number removed. */
    deleteWhere<T>(kind: RecordKind, predicate: (value: T) => boolean): Promise<number>;
    count(kind: RecordKind): Promise<number>;
    /** Every live record of a kind, as [key, value] pairs. */
    entries<T>(kind: RecordKind): Promise<Array<[string, T]>>;
}
interface Entry {
    value: unknown;
    expiresAt?: number;
}
type Data = Record<RecordKind, Record<string, Entry>>;
/**
 * In-memory store. All operations are synchronous against the map, so take() is atomic
 * within one Node process. Subclasses persist after each change.
 */
export declare class MemoryStore implements OAuthStore {
    protected readonly now: () => number;
    protected data: Data;
    constructor(now?: () => number);
    private live;
    get<T>(kind: RecordKind, key: string): Promise<T | undefined>;
    put<T>(kind: RecordKind, key: string, value: T, expiresAt?: number): Promise<void>;
    take<T>(kind: RecordKind, key: string): Promise<T | undefined>;
    delete(kind: RecordKind, key: string): Promise<void>;
    deleteWhere<T>(kind: RecordKind, predicate: (value: T) => boolean): Promise<number>;
    count(kind: RecordKind): Promise<number>;
    entries<T>(kind: RecordKind): Promise<Array<[string, T]>>;
    protected purgeExpired(): void;
    protected changed(): Promise<void>;
}
/**
 * JSON file store for a single server process. Each change rewrites the file through a
 * temporary file, fsync, and rename, so a crash never leaves a partial file.
 * Do not point two running servers at the same file.
 */
export declare class FileStore extends MemoryStore {
    private readonly path;
    private writing;
    private dirty;
    private constructor();
    static open(path: string, now?: () => number): Promise<FileStore>;
    protected changed(): Promise<void>;
    private flush;
}
export {};
