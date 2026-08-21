#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { findStore, loadStores } from "./config.js";
import { compareCatalog, compareInventory, listUnfulfilledOrders, portfolioSnapshot } from "./reports.js";
import { adminGraphql, requireMutation, requireQuery } from "./shopify.js";
const server = new McpServer({
    name: "shopify-multi-store-mcp-server",
    version: "1.2.0"
});
const StoreAliasSchema = z.string().min(1).max(64).describe("Configured store alias, such as main-store or wholesale-store");
const StoreAliasesSchema = z.array(StoreAliasSchema).min(1).max(10).describe("One to ten configured store aliases");
const SkuSchema = z.string().trim().min(1).max(255);
const HandleSchema = z.string().trim().min(1).max(255).regex(/^[a-z0-9][a-z0-9-]*$/i);
const VariablesSchema = z.record(z.string(), z.unknown()).default({}).describe("GraphQL variables as a JSON object");
const MULTI_STORE_CHARACTER_LIMIT = 100_000;
function success(value) {
    return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        structuredContent: value
    };
}
function failure(error) {
    return {
        isError: true,
        content: [{
                type: "text",
                text: error instanceof Error ? error.message : String(error)
            }]
    };
}
server.registerTool("shopify_list_stores", {
    title: "List Shopify Stores",
    description: "List every Shopify Admin store that remains connected to this plugin. This tool does not expose access tokens.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => {
    try {
        const stores = await loadStores();
        return success({
            count: stores.length,
            stores: stores.map((store) => ({ alias: store.alias, shop: store.shop, apiVersion: store.apiVersion }))
        });
    }
    catch (error) {
        return failure(error);
    }
});
server.registerTool("shopify_get_shop_info", {
    title: "Get Shopify Store Information",
    description: "Get identity and account information from one named Shopify Admin store. Use this tool before a sensitive change to make sure that the selected store is correct.",
    inputSchema: z.object({ store: StoreAliasSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
}, async ({ store }) => {
    try {
        const selected = await findStore(store);
        const result = await adminGraphql(selected, `query MultiStoreShopInfo {
        shop {
          id
          name
          myshopifyDomain
          email
          currencyCode
          timezoneAbbreviation
        }
      }`, {});
        return success(result);
    }
    catch (error) {
        return failure(error);
    }
});
server.registerTool("shopify_graphql_query", {
    title: "Query a Shopify Store",
    description: "Run one read-only GraphQL Admin API query against one named store. Use cursor pagination and request only necessary fields.",
    inputSchema: z.object({
        store: StoreAliasSchema,
        query: z.string().min(1).max(50_000).describe("A GraphQL query document. Mutations are rejected."),
        variables: VariablesSchema
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
}, async ({ store, query, variables }) => {
    try {
        requireQuery(query);
        const selected = await findStore(store);
        const result = await adminGraphql(selected, query, variables);
        return success(result);
    }
    catch (error) {
        return failure(error);
    }
});
server.registerTool("shopify_graphql_query_many", {
    title: "Query Multiple Shopify Stores",
    description: "Run the same read-only GraphQL Admin API query across multiple named stores in parallel. Each store returns its own success or error result.",
    inputSchema: z.object({
        stores: StoreAliasesSchema,
        query: z.string().min(1).max(50_000).describe("A read-only GraphQL query document. Mutations are rejected."),
        variables: VariablesSchema
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
}, async ({ stores, query, variables }) => {
    try {
        requireQuery(query);
        const requestedStores = [...new Set(stores)];
        const configuredStores = await loadStores();
        const storesByAlias = new Map(configuredStores.map((store) => [store.alias.toLowerCase(), store]));
        const results = await Promise.all(requestedStores.map(async (store) => {
            try {
                const selected = storesByAlias.get(store.toLowerCase());
                if (!selected) {
                    throw new Error(`Unknown store "${store}". Available stores: ${configuredStores.map((configured) => configured.alias).join(", ")}`);
                }
                const result = await adminGraphql(selected, query, variables);
                return { store: selected.alias, ok: true, result };
            }
            catch (error) {
                return {
                    store,
                    ok: false,
                    error: error instanceof Error ? error.message : String(error)
                };
            }
        }));
        const value = {
            count: results.length,
            succeeded: results.filter((result) => result.ok).length,
            failed: results.filter((result) => !result.ok).length,
            results
        };
        if (JSON.stringify(value).length > MULTI_STORE_CHARACTER_LIMIT) {
            throw new Error(`The combined response exceeded ${MULTI_STORE_CHARACTER_LIMIT} characters. Request fewer fields, fewer stores, or use cursor pagination.`);
        }
        return success(value);
    }
    catch (error) {
        return failure(error);
    }
});
server.registerTool("shopify_graphql_mutation", {
    title: "Change a Shopify Store",
    description: "Run one GraphQL Admin API mutation against one named store. Set confirm to true only after the user authorizes the exact store and change.",
    inputSchema: z.object({
        store: StoreAliasSchema,
        mutation: z.string().min(1).max(50_000).describe("A GraphQL mutation document."),
        variables: VariablesSchema,
        confirm: z.literal(true).describe("Must be true after the user authorizes the exact change and store.")
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, async ({ store, mutation, variables }) => {
    try {
        requireMutation(mutation);
        const selected = await findStore(store);
        const result = await adminGraphql(selected, mutation, variables);
        return success(result);
    }
    catch (error) {
        return failure(error);
    }
});
server.registerTool("shopify_portfolio_snapshot", {
    title: "Create Shopify Portfolio Snapshot",
    description: "Create a read-only operating snapshot across selected stores or every configured store. Includes shop identity and product, order, customer, and location counts when scopes permit.",
    inputSchema: z.object({
        stores: StoreAliasesSchema.optional().describe("Stores to include. Omit this field to include every configured store.")
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
}, async ({ stores }) => {
    try {
        return success(await portfolioSnapshot(stores));
    }
    catch (error) {
        return failure(error);
    }
});
server.registerTool("shopify_compare_inventory", {
    title: "Compare Shopify Inventory",
    description: "Compare inventory, price, product status, and catalog details for selected SKUs across multiple Shopify stores.",
    inputSchema: z.object({
        stores: StoreAliasesSchema,
        skus: z.array(SkuSchema).min(1).max(50).describe("One to fifty exact SKUs to compare.")
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
}, async ({ stores, skus }) => {
    try {
        return success(await compareInventory(stores, skus));
    }
    catch (error) {
        return failure(error);
    }
});
server.registerTool("shopify_list_unfulfilled_orders", {
    title: "List Unfulfilled Orders Across Stores",
    description: "List recent open, unfulfilled orders across multiple Shopify stores with independent per-store results.",
    inputSchema: z.object({
        stores: StoreAliasesSchema,
        days: z.number().int().min(1).max(365).default(7).describe("Lookback window in days."),
        first: z.number().int().min(1).max(100).default(25).describe("Maximum orders returned per store.")
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
}, async ({ stores, days, first }) => {
    try {
        return success(await listUnfulfilledOrders(stores, days, first));
    }
    catch (error) {
        return failure(error);
    }
});
server.registerTool("shopify_compare_catalog", {
    title: "Compare Shopify Catalogs",
    description: "Compare product titles, status, vendor, product type, and inventory for exact handles across multiple Shopify stores.",
    inputSchema: z.object({
        stores: StoreAliasesSchema,
        handles: z.array(HandleSchema).min(1).max(50).describe("One to fifty exact product handles to compare.")
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
}, async ({ stores, handles }) => {
    try {
        return success(await compareCatalog(stores, handles));
    }
    catch (error) {
        return failure(error);
    }
});
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=index.js.map