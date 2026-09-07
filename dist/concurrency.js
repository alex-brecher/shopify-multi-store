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
//# sourceMappingURL=concurrency.js.map