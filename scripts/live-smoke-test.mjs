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
} finally {
  await client.close();
}

if (failed) process.exitCode = 1;
