import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
/** Every record kind, for stores that enumerate them. */
export const RECORD_KINDS = ["client", "pending", "code", "access", "refresh", "consent", "approval", "session", "shopify_state", "shopify_token", "revoked_family", "counter"];
/** Every field in `match` equals the value's field of the same name. */
export function matches(value, match) {
    if (!value || typeof value !== "object")
        return false;
    return Object.entries(match).every(([field, expected]) => value[field] === expected);
}
function emptyData() {
    return Object.fromEntries(RECORD_KINDS.map((kind) => [kind, {}]));
}
/**
 * In-memory store. All operations are synchronous against the map, so take() is atomic
 * within one Node process. Subclasses persist after each change.
 */
export class MemoryStore {
    now;
    data = emptyData();
    constructor(now = Date.now) {
        this.now = now;
    }
    live(kind, key) {
        const entry = Object.hasOwn(this.data[kind], key) ? this.data[kind][key] : undefined;
        if (!entry)
            return undefined;
        if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
            delete this.data[kind][key];
            return undefined;
        }
        return entry;
    }
    async get(kind, key) {
        return this.live(kind, key)?.value;
    }
    async put(kind, key, value, expiresAt) {
        this.data[kind][key] = { value, ...(expiresAt !== undefined ? { expiresAt } : {}) };
        await this.changed();
    }
    async take(kind, key) {
        const entry = this.live(kind, key);
        if (!entry)
            return undefined;
        delete this.data[kind][key];
        await this.changed();
        return entry.value;
    }
    async claim(kind, key, flag) {
        // Read and write with no await in between, so no other operation can run in the gap.
        const entry = this.live(kind, key);
        if (!entry)
            return undefined;
        const value = entry.value;
        if (value[flag] === true)
            return { value: value, claimed: false };
        const next = { ...value, [flag]: true };
        this.data[kind][key] = { value: next, ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}) };
        await this.changed();
        return { value: next, claimed: true };
    }
    async increment(kind, key, options = {}) {
        // Read and write with no await in between, as in claim().
        const entry = this.live(kind, key);
        const current = typeof entry?.value === "number" ? entry.value : 0;
        if (options.max !== undefined && current + 1 > options.max)
            return { value: current, applied: false };
        const expiresAt = entry ? entry.expiresAt : options.expiresAt;
        this.data[kind][key] = { value: current + 1, ...(expiresAt !== undefined ? { expiresAt } : {}) };
        await this.changed();
        return { value: current + 1, applied: true };
    }
    async delete(kind, key) {
        if (!Object.hasOwn(this.data[kind], key))
            return;
        delete this.data[kind][key];
        await this.changed();
    }
    async deleteMatching(kind, match) {
        let removed = 0;
        for (const [key, entry] of Object.entries(this.data[kind])) {
            if (matches(entry.value, match)) {
                delete this.data[kind][key];
                removed += 1;
            }
        }
        if (removed)
            await this.changed();
        return removed;
    }
    async count(kind) {
        this.purgeExpired();
        return Object.keys(this.data[kind]).length;
    }
    async entries(kind) {
        this.purgeExpired();
        return Object.entries(this.data[kind]).map(([key, entry]) => [key, entry.value]);
    }
    purgeExpired() {
        const now = this.now();
        for (const kind of Object.keys(this.data)) {
            for (const [key, entry] of Object.entries(this.data[kind])) {
                if (entry.expiresAt !== undefined && entry.expiresAt <= now)
                    delete this.data[kind][key];
            }
        }
    }
    async changed() { }
}
export const nodeDurableFs = {
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
export async function writeFileDurable(path, data, fs = nodeDurableFs) {
    const temp = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
        // "wx": a fresh file opened for writing. Windows rejects FlushFileBuffers on a read-only handle.
        handle = await fs.open(temp, "wx", 0o600);
        await handle.writeFile(data, { encoding: "utf8" });
        await handle.sync();
        const opened = handle;
        handle = undefined;
        await opened.close();
        await fs.rename(temp, path);
    }
    catch (error) {
        if (handle)
            await handle.close().catch(() => { });
        await fs.unlink(temp).catch(() => { });
        throw error;
    }
    if (fs.platform === "win32")
        return;
    const directory = await fs.open(dirname(path), "r");
    try {
        await directory.sync();
    }
    catch (error) {
        if (!DIRECTORY_SYNC_UNSUPPORTED.has(error.code ?? ""))
            throw error;
    }
    finally {
        await directory.close();
    }
}
/**
 * JSON file store for a single server process. Each change rewrites the file through
 * writeFileDurable (temporary file, fsync, rename, directory fsync), so a crash never leaves
 * a partial file. Do not point two running servers at the same file.
 */
export class FileStore extends MemoryStore {
    path;
    fs;
    writing = Promise.resolve();
    dirty = false;
    constructor(path, now, fs) {
        super(now);
        this.path = path;
        this.fs = fs;
    }
    static async open(path, now = Date.now, fs = nodeDurableFs) {
        const store = new FileStore(path, now, fs);
        try {
            const parsed = JSON.parse(await readFile(path, "utf8"));
            store.data = { ...emptyData(), ...parsed };
            store.purgeExpired();
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        return store;
    }
    async changed() {
        this.dirty = true;
        // Coalesce: one write in flight, one queued. Every caller waits until its change is on disk.
        const next = this.writing.then(() => this.flush());
        this.writing = next.catch(() => { });
        return next;
    }
    async flush() {
        if (!this.dirty)
            return;
        this.dirty = false;
        this.purgeExpired();
        try {
            await writeFileDurable(this.path, JSON.stringify(this.data), this.fs);
        }
        catch (error) {
            // The change is still in memory; the next write retries it.
            this.dirty = true;
            throw error;
        }
    }
}
//# sourceMappingURL=store.js.map