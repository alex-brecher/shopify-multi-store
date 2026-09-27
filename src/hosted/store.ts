import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, open } from "node:fs/promises";
import { dirname } from "node:path";

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

/**
 * JSON file store for a single server process. Each change rewrites the file through a
 * temporary file, fsync, and rename, so a crash never leaves a partial file.
 * Do not point two running servers at the same file.
 */
export class FileStore extends MemoryStore {
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  private constructor(private readonly path: string, now: () => number) {
    super(now);
  }

  static async open(path: string, now: () => number = Date.now): Promise<FileStore> {
    const store = new FileStore(path, now);
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
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.data), { mode: 0o600 });
    const handle = await open(temp, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, this.path);
  }
}
