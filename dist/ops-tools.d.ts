import type { McpServer } from "@modelcontextprotocol/server";
/**
 * One-step bulk exports.
 *
 * shopify_bulk_export starts a Shopify bulk query for a whole resource (orders, products,
 * customers, ...) with an optional search filter, waits for it, and returns the download URL
 * of the JSONL file. No pagination, no response size limit.
 */
type Data = Record<string, any>;
/** One bulk query per resource. FILTER is replaced by the search filter argument, or removed. */
export declare const EXPORT_QUERIES: Readonly<Record<string, string>>;
export declare function exportQuery(resource: string, filter?: string): string;
/** The read scope each export needs (custom: whatever the query reads, checked by Shopify). */
export declare const EXPORT_SCOPES: Readonly<Record<string, readonly string[]>>;
export declare function exportTicket(user: string, shop: string, id: string, key: string): string;
export declare function bulkExport(a: Data, sleep?: (ms: number) => Promise<void>): Promise<Data>;
export declare function registerOpsTools(server: McpServer): void;
export {};
