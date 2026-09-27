import { type StoreConfig } from "./config.js";
export type Data = Record<string, any>;
export declare class WorkflowError extends Error {
    details: Data;
    constructor(message: string, details: Data);
}
export declare class Workflow {
    store: StoreConfig;
    readonly completed: Data[];
    constructor(store: StoreConfig);
    run(document: string, variables?: Data): Promise<Data>;
    requireScopes(scopes: string[]): Promise<Data>;
    all(document: string, variables: Data, field: string, limit?: number): Promise<Data[]>;
    product(id: string, first?: number, after?: string, mediaAfter?: string): Promise<Data>;
    collection(id: string, first?: number, after?: string): Promise<Data>;
    publish(id: string, publicationIds: string[]): Promise<void>;
}
export declare function workflow(alias: string): Promise<Workflow>;
/**
 * A tool result. Reads that exceed the limit are refused with advice to request fewer rows.
 * Writes (write: true) are never dropped: fitWriteResult trims them instead, so a caller always
 * learns what a write did.
 */
export declare function textResult(value: Data, isError?: boolean, write?: boolean): {
    isError: boolean;
    content: {
        type: "text";
        text: string;
    }[];
} | {
    isError?: boolean | undefined;
    content: {
        type: "text";
        text: string;
    }[];
    structuredContent: Data;
};
export declare function toolError(error: unknown, write?: boolean): {
    isError: boolean;
    content: {
        type: "text";
        text: string;
    }[];
} | {
    isError?: boolean | undefined;
    content: {
        type: "text";
        text: string;
    }[];
    structuredContent: Data;
};
/** Tag arguments shared by the product, order and customer update tools. */
export interface TagArgs {
    replaceTags?: string[];
    addTags?: string[];
    removeTags?: string[];
}
/** Refuse replaceTags together with addTags or removeTags: the result would depend on order. */
export declare function checkTagArgs(a: TagArgs): void;
/** The tag change a preview shows: the full new list for replaceTags, else what is added and removed. */
export declare function tagPreview(a: TagArgs, currentTags: unknown): Data;
/** Add and remove tags with tagsAdd and tagsRemove, leaving every other tag alone. */
export declare function applyTagChanges(w: Workflow, id: string, a: TagArgs): Promise<void>;
