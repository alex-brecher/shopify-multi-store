/** Record kinds kept by the authorization server. Secrets (codes, tokens) are stored only as sha256 keys. */
export type RecordKind = "client" | "pending" | "code" | "access" | "refresh" | "consent" | "approval" | "session" | "shopify_state" | "shopify_token" | "revoked_family";
export interface OAuthStore {
    get<T>(kind: RecordKind, key: string): Promise<T | undefined>;
    put<T>(kind: RecordKind, key: string, value: T, expiresAt?: number): Promise<void>;
    /** Read and delete in one step. Used for single-use authorization codes and login state. */
    take<T>(kind: RecordKind, key: string): Promise<T | undefined>;
    delete(kind: RecordKind, key: string): Promise<void>;
    /**
     * Atomically claim a live record: if its boolean `flag` field is not set, set it (keeping the
     * record's expiry) and return { claimed: true }; if it is already set, return
     * { claimed: false } and change nothing. Undefined when there is no live record. Of several
     * concurrent claims of one record exactly one gets claimed: true. Used for refresh token
     * rotation, where a second use of a token is a reuse.
     */
    claim<T>(kind: RecordKind, key: string, flag: string): Promise<{
        value: T;
        claimed: boolean;
    } | undefined>;
    /**
     * Delete every record of a kind whose top-level fields equal all of `match`. Returns the
     * number removed. Declarative (not a callback), so a remote store such as a Durable Object
     * can run it in one step.
     */
    deleteMatching(kind: RecordKind, match: Record<string, string | number | boolean>): Promise<number>;
    count(kind: RecordKind): Promise<number>;
    /** Every live record of a kind, as [key, value] pairs. */
    entries<T>(kind: RecordKind): Promise<Array<[string, T]>>;
}
interface Entry {
    value: unknown;
    expiresAt?: number;
}
type Data = Record<RecordKind, Record<string, Entry>>;
/** Every field in `match` equals the value's field of the same name. */
export declare function matches(value: unknown, match: Record<string, string | number | boolean>): boolean;
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
    claim<T>(kind: RecordKind, key: string, flag: string): Promise<{
        value: T;
        claimed: boolean;
    } | undefined>;
    delete(kind: RecordKind, key: string): Promise<void>;
    deleteMatching(kind: RecordKind, match: Record<string, string | number | boolean>): Promise<number>;
    count(kind: RecordKind): Promise<number>;
    entries<T>(kind: RecordKind): Promise<Array<[string, T]>>;
    protected purgeExpired(): void;
    protected changed(): Promise<void>;
}
/** An open file: the handle the durable write path writes to, syncs, and closes. */
export interface DurableFileHandle {
    writeFile(data: string, options?: {
        encoding?: BufferEncoding;
    }): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
}
/** The filesystem calls the durable write path makes. Injectable so tests can observe them. */
export interface DurableFs {
    open(path: string, flags: string, mode?: number): Promise<DurableFileHandle>;
    rename(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
    platform: NodeJS.Platform;
}
export declare const nodeDurableFs: DurableFs;
/**
 * Replace a file atomically and durably: write a temporary file through a handle opened for
 * writing, fsync that same handle, close it, rename it over the target, then fsync the
 * directory so the rename itself survives a crash. The directory step is skipped on Windows,
 * which cannot open a directory for flushing, and tolerated only where the filesystem reports
 * directory fsync as unsupported. Every other error propagates.
 */
export declare function writeFileDurable(path: string, data: string, fs?: DurableFs): Promise<void>;
/**
 * JSON file store for a single server process. Each change rewrites the file through
 * writeFileDurable (temporary file, fsync, rename, directory fsync), so a crash never leaves
 * a partial file. Do not point two running servers at the same file.
 */
export declare class FileStore extends MemoryStore {
    private readonly path;
    private readonly fs;
    private writing;
    private dirty;
    private constructor();
    static open(path: string, now?: () => number, fs?: DurableFs): Promise<FileStore>;
    protected changed(): Promise<void>;
    private flush;
}
export {};
