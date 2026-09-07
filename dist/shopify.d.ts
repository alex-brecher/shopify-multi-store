import type { StoreConfig } from "./config.js";
export declare const PACKAGE_VERSION: string;
export interface GraphqlEnvelope {
    store: string;
    shop: string;
    apiVersion: string;
    requestId?: string;
    elapsedMs: number;
    retryCount: number;
    data?: unknown;
    errors?: unknown;
    extensions?: unknown;
    userErrors?: unknown[];
}
export declare function retryDelay(response: Response | undefined, attempt: number, payload?: unknown): number;
export declare function adminGraphql(store: StoreConfig, document: string, variables: Record<string, unknown>): Promise<GraphqlEnvelope>;
export declare function requireQuery(document: string): void;
export declare function requireMutation(document: string): void;
/** Keep partial data available while marking GraphQL failures for MCP callers. */
export declare function hasGraphqlErrors(result: GraphqlEnvelope): boolean;
