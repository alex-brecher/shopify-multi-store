#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { findStore, loadStores } from "./config.js";
import { adminGraphql, requireMutation, requireQuery } from "./shopify.js";

const server = new McpServer({
  name: "shopify-multi-store-mcp-server",
  version: "1.1.0"
});

const StoreAliasSchema = z.string().min(1).max(64).describe("Configured store alias, such as main-store or wholesale-store");
const StoreAliasesSchema = z.array(StoreAliasSchema).min(1).max(10).describe("One to ten configured store aliases");
const VariablesSchema = z.record(z.string(), z.unknown()).default({}).describe("GraphQL variables as a JSON object");
const MULTI_STORE_CHARACTER_LIMIT = 100_000;

function success(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: error instanceof Error ? error.message : String(error)
    }]
  };
}

server.registerTool(
  "shopify_list_stores",
  {
    title: "List Shopify Stores",
    description: "List every Shopify Admin store that remains connected to this plugin. This tool does not expose access tokens.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async () => {
    try {
      const stores = await loadStores();
      return success({
        count: stores.length,
        stores: stores.map((store) => ({ alias: store.alias, shop: store.shop, apiVersion: store.apiVersion }))
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "shopify_get_shop_info",
  {
    title: "Get Shopify Store Information",
    description: "Get identity and account information from one named Shopify Admin store. Use this tool before a sensitive change to make sure that the selected store is correct.",
    inputSchema: z.object({ store: StoreAliasSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ store }) => {
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
      return success(result as unknown as Record<string, unknown>);
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "shopify_graphql_query",
  {
    title: "Query a Shopify Store",
    description: "Run one read-only GraphQL Admin API query against one named store. Use cursor pagination and request only necessary fields.",
    inputSchema: z.object({
      store: StoreAliasSchema,
      query: z.string().min(1).max(50_000).describe("A GraphQL query document. Mutations are rejected."),
      variables: VariablesSchema
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ store, query, variables }) => {
    try {
      requireQuery(query);
      const selected = await findStore(store);
      const result = await adminGraphql(selected, query, variables);
      return success(result as unknown as Record<string, unknown>);
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "shopify_graphql_query_many",
  {
    title: "Query Multiple Shopify Stores",
    description: "Run the same read-only GraphQL Admin API query across multiple named stores in parallel. Each store returns its own success or error result.",
    inputSchema: z.object({
      stores: StoreAliasesSchema,
      query: z.string().min(1).max(50_000).describe("A read-only GraphQL query document. Mutations are rejected."),
      variables: VariablesSchema
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ stores, query, variables }) => {
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
          return { store: selected.alias, ok: true as const, result };
        } catch (error) {
          return {
            store,
            ok: false as const,
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
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "shopify_graphql_mutation",
  {
    title: "Change a Shopify Store",
    description: "Run one GraphQL Admin API mutation against one named store. Set confirm to true only after the user authorizes the exact store and change.",
    inputSchema: z.object({
      store: StoreAliasSchema,
      mutation: z.string().min(1).max(50_000).describe("A GraphQL mutation document."),
      variables: VariablesSchema,
      confirm: z.literal(true).describe("Must be true after the user authorizes the exact change and store.")
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  async ({ store, mutation, variables }) => {
    try {
      requireMutation(mutation);
      const selected = await findStore(store);
      const result = await adminGraphql(selected, mutation, variables);
      return success(result as unknown as Record<string, unknown>);
    } catch (error) {
      return failure(error);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
