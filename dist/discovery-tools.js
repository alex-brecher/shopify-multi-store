import { sampleProducts } from "./samples.js";
import { UI_META } from "./ui.js";
import { z } from "zod/v4";
import { textResult, toolError } from "./admin-workflows.js";
export function registerDiscoveryTools(server) {
    server.registerTool("shopify_search_docs_chunks", {
        description: "Search Shopify documentation and return source links. No store credentials are sent.",
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
    }, async (a) => {
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
                throw Error(`Shopify documentation search failed: HTTP ${response.status}.`);
            const results = await response.json();
            if (!Array.isArray(results))
                throw Error("Unexpected documentation search response.");
            return textResult({ results: results.slice(0, a.max_num_results) });
        }
        catch (e) {
            return toolError(e);
        }
    });
    server.registerTool("shopify_find_sample_product", {
        _meta: UI_META,
        description: "Find sample products across published Shopify demo catalogs. For categories without suitable samples, generate original product concepts from the user query and pass generatedCandidates to display draft-creation cards. Label concepts as examples, never supplier offers or verified products. Images are optional; use only available relevant image URLs.",
        inputSchema: z
            .object({
            query: z.string().min(1).max(500),
            limit: z.number().int().min(1).max(10).default(5),
            generatedCandidates: z
                .array(z
                .object({
                title: z.string().min(1).max(255),
                description: z.string().max(2000),
                imageUrl: z
                    .url()
                    .startsWith("https://cdn.shopify.com/")
                    .optional(),
                imageAlt: z.string().max(1000).optional(),
            })
                .strict())
                .min(1)
                .max(10)
                .optional(),
        })
            .strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (a) => {
        try {
            if (a.generatedCandidates)
                return textResult({
                    query: a.query,
                    sampleData: true,
                    generatedConcepts: true,
                    catalogOnly: false,
                    notice: "AI-generated product concepts. Review details and prices before use.",
                    sampleProducts: a.generatedCandidates
                        .slice(0, a.limit)
                        .map((p, i) => ({
                        id: `concept-${i + 1}`,
                        title: p.title,
                        description: p.description,
                        ...(p.imageUrl
                            ? {
                                featuredImage: {
                                    url: p.imageUrl,
                                    altText: p.imageAlt ?? p.title,
                                },
                            }
                            : {}),
                    })),
                });
            return textResult(await sampleProducts(a.query, a.limit));
        }
        catch (e) {
            return toolError(e);
        }
    });
}
//# sourceMappingURL=discovery-tools.js.map