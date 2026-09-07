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
//# sourceMappingURL=concurrency.js.map