export async function mapConcurrent<T, R>(
  items: T[],
  handler: (item: T, index: number) => Promise<R>,
  concurrency = 5,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await handler(items[index], index);
      }
    }),
  );
  return results;
}
const queues = new Map<string, Promise<void>>();
export async function serializeStore<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(key, current);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

/** Cross-process exclusion for durable creation receipts. Stale locks require inspection. */
export async function withFileLock<T>(
  path: string,
  run: () => Promise<T>,
): Promise<T> {
  const { open, mkdir, unlink } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw Error(
        "A preview workflow holds this lock, or an interrupted workflow needs inspection before recovery.",
      );
    throw e;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    return await run();
  } finally {
    await handle.close();
    await unlink(path);
  }
}

/** Replace a JSON receipt without exposing a truncated file to concurrent readers. */
export async function atomicJson(path: string, value: unknown, exclusive = false): Promise<void> {
  const { writeFile, rename, rm, link } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    if (exclusive) await link(temp, path);
    else await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
