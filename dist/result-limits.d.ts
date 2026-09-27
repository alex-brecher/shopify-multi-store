type MultiStoreResult = Record<string, unknown> & {
    store?: unknown;
    ok?: unknown;
    result?: unknown;
};
export declare function fitMultiStoreResults(results: MultiStoreResult[], characterLimit: number): Record<string, unknown>;
type Data = Record<string, unknown>;
/** Largest write-tool result, in JSON characters. */
export declare const WRITE_RESULT_CHARACTER_LIMIT = 150000;
/**
 * Fit a write tool's result under the character limit without ever dropping it: after a write,
 * the caller must learn what happened. Stages, each only when still too large: trim per-item
 * mutation responses and verified state to the changed fields (and before/after to the fields
 * that differ); replace applied items with one summary line each; drop the summary lines (the
 * counts stay); shorten long strings; cut non-applied items to identity, outcome and error.
 * Top-level status and counts, and every item that did not apply, are always kept.
 */
export declare function fitWriteResult<T extends Data>(value: T, characterLimit?: number): Data;
export {};
