export async function mapConcurrent(items, handler, concurrency = 5) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await handler(items[index], index);
        }
    }));
    return results;
}
const queues = new Map();
export async function serializeStore(key, run) {
    const previous = queues.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
        release = resolve;
    });
    queues.set(key, current);
    await previous;
    try {
        return await run();
    }
    finally {
        release();
        if (queues.get(key) === current)
            queues.delete(key);
    }
}
/** Cross-process exclusion for durable creation receipts. Stale locks require inspection. */
export async function withFileLock(path, run) {
    const { open, mkdir, unlink } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    let handle;
    try {
        handle = await open(path, "wx", 0o600);
    }
    catch (e) {
        if (e.code === "EEXIST")
            throw Error("A preview workflow holds this lock, or an interrupted workflow needs inspection before recovery.");
        throw e;
    }
    try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        return await run();
    }
    finally {
        await handle.close();
        await unlink(path);
    }
}
/** Replace a JSON receipt without exposing a truncated file to concurrent readers. */
export async function atomicJson(path, value, exclusive = false) {
    const { writeFile, rename, rm, link } = await import("node:fs/promises");
    const { randomUUID } = await import("node:crypto");
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
        if (exclusive)
            await link(temp, path);
        else {
            for (let attempt = 0;; attempt++) {
                try {
                    await rename(temp, path);
                    break;
                }
                catch (e) {
                    const code = e.code;
                    if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= 50)
                        throw e;
                    // Windows readers and antivirus can briefly hold a destination handle.
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
            }
        }
    }
    finally {
        await rm(temp, { force: true });
    }
}
//# sourceMappingURL=concurrency.js.map