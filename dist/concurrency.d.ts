export declare function mapConcurrent<T, R>(items: T[], handler: (item: T, index: number) => Promise<R>, concurrency?: number): Promise<R[]>;
export declare function serializeStore<T>(key: string, run: () => Promise<T>): Promise<T>;
/** Cross-process exclusion for durable creation receipts. Stale locks require inspection. */
export declare function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T>;
