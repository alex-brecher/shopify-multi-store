/** Record kinds kept by the authorization server. Secrets (codes, tokens) are stored only as sha256 keys. */
export type RecordKind = "client" | "pending" | "code" | "access" | "refresh" | "consent" | "approval" | "pat" | "session";
export interface OAuthStore {
    get<T>(kind: RecordKind, key: string): Promise<T | undefined>;
    put<T>(kind: RecordKind, key: string, value: T, expiresAt?: number): Promise<void>;
    /** Read and delete in one step. Used for single-use authorization codes and login state. */
    take<T>(kind: RecordKind, key: string): Promise<T | undefined>;
    delete(kind: RecordKind, key: string): Promise<void>;
    /**
     * Conditional update in one step: read the live record and, only if it still exists, replace
     * it with what `change` returns (keeping its expiry). Returns the new value, or undefined when
     * there was no record or `change` returned undefined. `change` must be synchronous.
     */
    update<T>(kind: RecordKind, key: string, change: (current: T) => T | undefined): Promise<T | undefined>;
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
    update<T>(kind: RecordKind, key: string, change: (current: T) => T | undefined): Promise<T | undefined>;
    delete(kind: RecordKind, key: string): Promise<void>;
    deleteWhere<T>(kind: RecordKind, predicate: (value: T) => boolean): Promise<number>;
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
