import type { StoreConfig } from "./config.js";
export interface GraphqlEnvelope {
    store: string;
    shop: string;
    apiVersion: string;
    data?: unknown;
    errors?: unknown;
    extensions?: unknown;
}
export declare function adminGraphql(store: StoreConfig, document: string, variables: Record<string, unknown>): Promise<GraphqlEnvelope>;
export declare function requireQuery(document: string): void;
export declare function requireMutation(document: string): void;
