import { UI_META } from "./ui.js";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { textResult, toolError } from "./admin-workflows.js";

export function registerDiscoveryTools(server: McpServer) {
  server.registerTool(
    "shopify_search_docs_chunks",
    {
      description:
        "Search Shopify documentation and return source links. No store credentials are sent.",
      inputSchema: z
        .object({
          prompt: z.string().min(1).max(2000),
          api_name: z.string().max(100).default("admin"),
          max_num_results: z.number().int().min(1).max(20).default(5),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (a) => {
      try {
        // Protocol from Shopify AI Toolkit search_docs.mjs, MIT. No usage telemetry is sent.
        const response = await fetch("https://shopify.dev/assistant/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Surface": "skills",
          },
          body: JSON.stringify({ query: a.prompt, api_name: a.api_name }),
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        if (!response.ok)
          throw Error(
            `Shopify documentation search failed: HTTP ${response.status}.`,
          );
        const results = await response.json();
        if (!Array.isArray(results))
          throw Error("Unexpected documentation search response.");
        return textResult({ results: results.slice(0, a.max_num_results) });
      } catch (e) {
        return toolError(e);
      }
    },
  );
  server.registerTool(
    "shopify_find_sample_product",
    {
      _meta: UI_META,
      description:
        "Browse sample products from Shopify mock.shop. These are demo products, not verified supplier offers. Use create_product to add a selected sample as a draft.",
      inputSchema: z
        .object({
          query: z.string().min(1).max(500),
          limit: z.number().int().min(1).max(10).default(5),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (a) => {
      try {
        const response = await fetch("https://mock.shop/api", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query:
              "query Samples($query:String!,$first:Int!){products(first:$first,query:$query){nodes{id title description featuredImage{url altText} priceRange{minVariantPrice{amount currencyCode}}}}}",
            variables: { query: a.query, first: 100 },
          }),
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        const result = (await response.json()) as {
          data?: { products?: { nodes?: unknown[] } };
          errors?: unknown;
        };
        if (
          !response.ok ||
          result.errors ||
          !Array.isArray(result.data?.products?.nodes)
        )
          throw Error("Shopify sample product search failed.");
        const terms = a.query.toLowerCase().split(/\s+/).filter(Boolean);
        const candidates = result.data.products.nodes as Array<
          Record<string, any>
        >;
        const matching = candidates.filter((p) =>
          terms.every((term) =>
            `${p.title ?? ""} ${p.description ?? ""}`
              .toLowerCase()
              .includes(term),
          ),
        );
        return textResult({
          query: a.query,
          sampleProducts: matching.slice(0, a.limit),
          sampleData: true,
          source: "https://mock.shop/api",
          catalogOnly: true,
          ...(!matching.length
            ? {
                notice:
                  "No matching products exist in the public demo catalog. This endpoint does not generate new sample products.",
              }
            : {}),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
