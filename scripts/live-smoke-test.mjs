#!/usr/bin/env node
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = resolve(new URL("..", import.meta.url).pathname);
const serverPath = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "dist", "index.js");
const client = new Client({ name: "shopify-multi-store-live-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env }
});

let failed = false;
try {
  await client.connect(transport);
  const list = await client.callTool({ name: "shopify_list_stores", arguments: {} });
  if (list.isError || !list.structuredContent || !Array.isArray(list.structuredContent.stores)) {
    throw new Error("The server did not return the configured store list.");
  }

  for (const configured of list.structuredContent.stores) {
    const result = await client.callTool({
      name: "shopify_get_shop_info",
      arguments: { store: configured.alias }
    });
    if (result.isError) {
      failed = true;
      const message = result.content?.find((item) => item.type === "text")?.text ?? "Unknown error";
      process.stdout.write(`${configured.alias}\tFAIL\t${message}\n`);
      continue;
    }
    const shop = result.structuredContent?.data?.shop;
    process.stdout.write(`${configured.alias}\tOK\t${shop?.name ?? "unknown"}\t${shop?.myshopifyDomain ?? configured.shop}\n`);
  }

  const comparisonStores = list.structuredContent.stores.slice(0, 3).map((store) => store.alias);
  if (comparisonStores.length > 1) {
    const comparison = await client.callTool({
      name: "shopify_graphql_query_many",
      arguments: {
        stores: comparisonStores,
        query: "query MultiStoreLiveCheck { shop { name myshopifyDomain } }",
        variables: {}
      }
    });
    if (comparison.isError || comparison.structuredContent?.failed !== 0) {
      failed = true;
      const message = comparison.content?.find((item) => item.type === "text")?.text ?? "Unknown error";
      process.stdout.write(`cross-store\tFAIL\t${message}\n`);
    } else {
      process.stdout.write(`cross-store\tOK\t${comparison.structuredContent.succeeded} stores queried in parallel\n`);
    }

    const reportChecks = [
      ["portfolio-snapshot", "shopify_portfolio_snapshot", { stores: comparisonStores }],
      ["inventory-report", "shopify_compare_inventory", { stores: comparisonStores.slice(0, 2), skus: ["__codex_missing_sku__"] }],
      ["unfulfilled-orders", "shopify_list_unfulfilled_orders", { stores: comparisonStores.slice(0, 2), days: 1, first: 1 }],
      ["catalog-report", "shopify_compare_catalog", { stores: comparisonStores.slice(0, 2), handles: ["codex-missing-product"] }]
    ];
    for (const [label, name, argumentsValue] of reportChecks) {
      const report = await client.callTool({ name, arguments: argumentsValue });
      if (report.isError || !report.structuredContent || report.structuredContent.failed > 0) {
        failed = true;
        const message = report.content?.find((item) => item.type === "text")?.text ?? "Unknown error";
        process.stdout.write(`${label}\tFAIL\t${message}\n`);
      } else {
        process.stdout.write(`${label}\tOK\t${report.structuredContent.succeeded} stores\n`);
      }
    }
  }
} finally {
  await client.close();
}

if (failed) process.exitCode = 1;
