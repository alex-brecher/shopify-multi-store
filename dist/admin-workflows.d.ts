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
export declare function textResult(value: Data, isError?: boolean): {
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
export declare function toolError(error: unknown): {
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
