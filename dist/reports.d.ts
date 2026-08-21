import { type GraphqlEnvelope } from "./shopify.js";
type StoreReportResult = {
    store: string;
    ok: boolean;
    result?: GraphqlEnvelope;
    error?: string;
};
export type MultiStoreReport = {
    count: number;
    succeeded: number;
    failed: number;
    results: StoreReportResult[];
    [key: string]: unknown;
};
export declare function portfolioSnapshot(aliases?: string[]): Promise<MultiStoreReport>;
export declare function compareInventory(aliases: string[], skus: string[]): Promise<MultiStoreReport>;
export declare function listUnfulfilledOrders(aliases: string[], days: number, first: number): Promise<MultiStoreReport>;
export declare function compareCatalog(aliases: string[], handles: string[]): Promise<MultiStoreReport>;
export {};
