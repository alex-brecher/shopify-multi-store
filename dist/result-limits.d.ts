type MultiStoreResult = Record<string, unknown> & {
    store?: unknown;
    ok?: unknown;
    result?: unknown;
};
export declare function fitMultiStoreResults(results: MultiStoreResult[], characterLimit: number): Record<string, unknown>;
export {};
