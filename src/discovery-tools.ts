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
}
