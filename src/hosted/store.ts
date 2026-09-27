import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** Record kinds kept by the authorization server. Secrets (codes, tokens) are stored only as sha256 keys. */
export type RecordKind = "client" | "pending" | "code" | "access" | "refresh" | "consent" | "approval" | "pat" | "session" | "shopify_state" | "shopify_token";

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

function emptyData(): Data {
  return { client: {}, pending: {}, code: {}, access: {}, refresh: {}, consent: {}, approval: {}, pat: {}, session: {}, shopify_state: {}, shopify_token: {} };
}

/**
 * In-memory store. All operations are synchronous against the map, so take() is atomic
 * within one Node process. Subclasses persist after each change.
 */
export class MemoryStore implements OAuthStore {
  protected data: Data = emptyData();

  constructor(protected readonly now: () => number = Date.now) {}

  private live(kind: RecordKind, key: string): Entry | undefined {
    const entry = Object.hasOwn(this.data[kind], key) ? this.data[kind][key] : undefined;
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      delete this.data[kind][key];
      return undefined;
    }
    return entry;
  }

  async get<T>(kind: RecordKind, key: string): Promise<T | undefined> {
    return this.live(kind, key)?.value as T | undefined;
  }

  async put<T>(kind: RecordKind, key: string, value: T, expiresAt?: number): Promise<void> {
    this.data[kind][key] = { value, ...(expiresAt !== undefined ? { expiresAt } : {}) };
    await this.changed();
  }

  async take<T>(kind: RecordKind, key: string): Promise<T | undefined> {
    const entry = this.live(kind, key);
    if (!entry) return undefined;
    delete this.data[kind][key];
    await this.changed();
    return entry.value as T;
  }

  async update<T>(kind: RecordKind, key: string, change: (current: T) => T | undefined): Promise<T | undefined> {
    // Read and write with no await in between, so no other operation can run in the gap.
    const entry = this.live(kind, key);
    if (!entry) return undefined;
    const next = change(entry.value as T);
    if (next === undefined) return undefined;
    this.data[kind][key] = { value: next, ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}) };
    await this.changed();
    return next;
  }

  async delete(kind: RecordKind, key: string): Promise<void> {
    if (!Object.hasOwn(this.data[kind], key)) return;
    delete this.data[kind][key];
    await this.changed();
  }

  async deleteWhere<T>(kind: RecordKind, predicate: (value: T) => boolean): Promise<number> {
    let removed = 0;
    for (const [key, entry] of Object.entries(this.data[kind])) {
      if (predicate(entry.value as T)) {
        delete this.data[kind][key];
        removed += 1;
      }
    }
    if (removed) await this.changed();
    return removed;
  }

  async count(kind: RecordKind): Promise<number> {
    this.purgeExpired();
    return Object.keys(this.data[kind]).length;
  }

  async entries<T>(kind: RecordKind): Promise<Array<[string, T]>> {
    this.purgeExpired();
    return Object.entries(this.data[kind]).map(([key, entry]) => [key, entry.value as T]);
  }

  protected purgeExpired(): void {
    const now = this.now();
    for (const kind of Object.keys(this.data) as RecordKind[]) {
      for (const [key, entry] of Object.entries(this.data[kind])) {
        if (entry.expiresAt !== undefined && entry.expiresAt <= now) delete this.data[kind][key];
      }
    }
  }

  protected async changed(): Promise<void> {}
}

/** An open file: the handle the durable write path writes to, syncs, and closes. */
export interface DurableFileHandle {
  writeFile(data: string, options?: { encoding?: BufferEncoding }): Promise<void>;
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

export const nodeDurableFs: DurableFs = {
  open: (path, flags, mode) => open(path, flags, mode),
  rename,
  unlink,
  platform: process.platform
};

/** Errors a directory fsync may return on filesystems that do not support it. */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"]);

/**
 * Replace a file atomically and durably: write a temporary file through a handle opened for
 * writing, fsync that same handle, close it, rename it over the target, then fsync the
 * directory so the rename itself survives a crash. The directory step is skipped on Windows,
 * which cannot open a directory for flushing, and tolerated only where the filesystem reports
 * directory fsync as unsupported. Every other error propagates.
 */
export async function writeFileDurable(path: string, data: string, fs: DurableFs = nodeDurableFs): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  let handle: DurableFileHandle | undefined;
  try {
    // "wx": a fresh file opened for writing. Windows rejects FlushFileBuffers on a read-only handle.
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(data, { encoding: "utf8" });
    await handle.sync();
    const opened = handle;
    handle = undefined;
    await opened.close();
    await fs.rename(temp, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
  if (fs.platform === "win32") return;
  const directory = await fs.open(dirname(path), "r");
  try {
    await directory.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await directory.close();
  }
}

/**
 * JSON file store for a single server process. Each change rewrites the file through
 * writeFileDurable (temporary file, fsync, rename, directory fsync), so a crash never leaves
 * a partial file. Do not point two running servers at the same file.
 */
export class FileStore extends MemoryStore {
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  private constructor(private readonly path: string, now: () => number, private readonly fs: DurableFs) {
    super(now);
  }

  static async open(path: string, now: () => number = Date.now, fs: DurableFs = nodeDurableFs): Promise<FileStore> {
    const store = new FileStore(path, now, fs);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Data>;
      store.data = { ...emptyData(), ...parsed };
      store.purgeExpired();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return store;
  }

  protected override async changed(): Promise<void> {
    this.dirty = true;
    // Coalesce: one write in flight, one queued. Every caller waits until its change is on disk.
    const next = this.writing.then(() => this.flush());
    this.writing = next.catch(() => {});
    return next;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.purgeExpired();
    try {
      await writeFileDurable(this.path, JSON.stringify(this.data), this.fs);
    } catch (error) {
      // The change is still in memory; the next write retries it.
      this.dirty = true;
      throw error;
    }
  }
}
