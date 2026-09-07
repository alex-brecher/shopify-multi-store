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
