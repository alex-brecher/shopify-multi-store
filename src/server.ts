import { registerAdminTools } from "./admin-tools.js";
import { registerParityTools } from "./parity-tools.js";
import { mapConcurrent } from "./concurrency.js";
import { registerDiscoveryTools } from "./discovery-tools.js";
import { registerReportTools } from "./report-tools.js";
import { registerReadTools } from "./read-tools.js";
import { actionPolicyError, destructiveMutations, registerActionTools, parseActionDocument, sendMutationWithOutcome } from "./actions/tools.js";
import { currentUserAccess } from "./runtime.js";
import { DOCS } from "./admin-documents.js";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { findStore, loadStores, resolveStoreTargets, unconnectedStores } from "./config.js";
import { adminGraphql, hasGraphqlErrors, PACKAGE_VERSION, requireMutation, requireQuery } from "./shopify.js";
import { fitMultiStoreResults } from "./result-limits.js";

const StoreAliasSchema = z.string().min(1).max(64).describe("Configured store alias, such as main-store or wholesale-store");
const StoreAliasesSchema = z.array(StoreAliasSchema).min(1).max(100).describe("One to one hundred configured store aliases");
const VariablesSchema = z.record(z.string(), z.unknown()).default({}).describe("GraphQL variables as a JSON object");
const MULTI_STORE_CHARACTER_LIMIT = 100_000;

function success(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
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

export interface CreateServerOptions {
  /**
   * Runs after the server is constructed and before any tool is registered.
   * Hosted mode uses it to wrap registerTool with policy, audit, and safety checks.
   * Stdio mode passes nothing, so local behavior is unchanged.
   */
  beforeRegister?: (server: McpServer) => void;
  /** Display name reported as serverInfo.title. Hosted mode sets it from SERVER_DISPLAY_NAME; stdio leaves it unset. */
  title?: string;
}

/** Build a fully registered MCP server. Used by stdio (one per process) and HTTP (one per request). */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "shopify-multi-store-mcp-server",
    version: PACKAGE_VERSION,
    ...(options.title ? { title: options.title } : {})
  });
  options.beforeRegister?.(server);
  registerAdminTools(server);
  registerParityTools(server);
  registerReadTools(server);
  registerReportTools(server);
  registerDiscoveryTools(server);
  registerActionTools(server);

  server.registerTool(
    "shopify_list_stores",
    {
      title: "List Shopify Stores",
      description: "List every Shopify Admin store that remains connected to this plugin. On a hosted server in per-user mode, lists only the stores you have connected with your own Shopify account and names the others with a link to connect them. This tool does not expose access tokens.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const stores = await loadStores();
        const notConnected = await unconnectedStores();
        return success({
          count: stores.length,
          stores: stores.map((store) => ({ alias: store.alias, shop: store.shop, apiVersion: store.apiVersion })),
          ...(notConnected.length ? {
            notConnected,
            hint: currentUserAccess()?.blockedReason ?? `These stores are not connected with your Shopify account, or the connection expired: ${notConnected.map((store) => store.alias).join(", ")}. Connect them at ${new URL("/stores", notConnected[0]!.connectUrl).toString()}.`
          } : {})
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
        const result = await adminGraphql(selected, DOCS.shop, {});
        return { ...success(result as unknown as Record<string, unknown>), ...(hasGraphqlErrors(result) ? { isError: true } : {}) };
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
        return { ...success(result as unknown as Record<string, unknown>), ...(hasGraphqlErrors(result) ? { isError: true } : {}) };
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
        const targets = await resolveStoreTargets(stores);
        const results = await mapConcurrent(targets, async ({ requestedAlias: store, store: selected, error }) => {
          try {
            if (!selected) throw new Error(error ?? `Unknown store "${store}".`);
            const result = await adminGraphql(selected, query, variables);
            return { store: selected.alias, ok: !hasGraphqlErrors(result), result,
              ...(hasGraphqlErrors(result) ? { error: "Shopify returned GraphQL errors. See result.errors." } : {}) };
          } catch (error) {
            return {
              store,
              ok: false as const,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        });
        const value = fitMultiStoreResults(results, MULTI_STORE_CHARACTER_LIMIT);
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
      description: "Run one GraphQL Admin API mutation against one named store. Set confirm to true only after the user authorizes the exact store and change. Destructive mutations (see shopify_describe_action; some are destructive only with certain arguments, such as a product status of ARCHIVED or notifyCustomer true) need confirm set to the mutation name instead, and denylisted mutations are refused, exactly as in shopify_run_action. The result reports each top-level mutation field as applied, rejected, or unknown, and the store as applied, rejected, partial, or unknown; after partial or unknown, retry only the rejected fields in a new document.",
      inputSchema: z.object({
        store: StoreAliasSchema,
        mutation: z.string().min(1).max(50_000).describe("A GraphQL mutation document."),
        variables: VariablesSchema,
        confirm: z.union([z.literal(true), z.string().min(1).max(2_000)]).describe("True after the user authorizes the exact change and store. Destructive mutations need the mutation name instead (several: comma-separated, in document order).")
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async ({ store, mutation, variables, confirm }) => {
      try {
        requireMutation(mutation);
        // Every mode (local stdio, hosted app token, hosted per-user) applies the same write
        // policy as shopify_run_action: denylisted mutations are refused, and destructive ones,
        // by name or by argument values, need confirm set to the mutation names.
        const parsed = parseActionDocument(mutation);
        const refusal = actionPolicyError(parsed.rootFields, confirm, true, destructiveMutations(parsed, [variables]));
        if (refusal) throw new Error(refusal);
        const selected = await findStore(store);
        // Each root field is judged on its own (applied, rejected, unknown); see docs/ACTIONS.md.
        const result = await sendMutationWithOutcome(selected, mutation, variables);
        // Every result carries a per-root outcome, even when the schema could not be loaded; only
        // "applied" is success.
        const failed = result.outcome !== "applied";
        return { ...success(result), ...(failed ? { isError: true } : {}) };
      } catch (error) {
        return failure(error);
      }
    }
  );

  return server;
}
