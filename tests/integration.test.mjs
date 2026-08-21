import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const pluginRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("lists two stores and routes a shop query to the selected store", async () => {
  const requests = [];
  const mock = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsedBody = JSON.parse(body);
      requests.push({ url: request.url, token: request.headers["x-shopify-access-token"], body: parsedBody });
      response.writeHead(200, { "content-type": "application/json", "x-request-id": "mock-request" });
      if (parsedBody.query.includes("CompareInventory")) {
        response.end(JSON.stringify({ data: { productVariants: { nodes: [{ id: "gid://shopify/ProductVariant/1", sku: "SKU-1", title: "Default", inventoryQuantity: 5, price: "10.00", compareAtPrice: null, product: { id: "gid://shopify/Product/1", title: "Example", handle: "example", status: "ACTIVE", vendor: "Example Vendor", productType: "Example" } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      } else if (parsedBody.query.includes("UnfulfilledOrders")) {
        response.end(JSON.stringify({ data: { orders: { nodes: [{ id: "gid://shopify/Order/1", name: "#1001", createdAt: "2026-08-21T00:00:00Z", updatedAt: "2026-08-21T00:00:00Z", displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", totalPriceSet: { shopMoney: { amount: "25.00", currencyCode: "USD" } } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      } else if (parsedBody.query.includes("CompareCatalog")) {
        response.end(JSON.stringify({ data: { products: { nodes: [{ id: "gid://shopify/Product/1", handle: "example", title: "Example", status: "ACTIVE", vendor: "Example Vendor", productType: "Example", totalInventory: 5, updatedAt: "2026-08-21T00:00:00Z", variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", sku: "SKU-1", title: "Default", price: "10.00", compareAtPrice: null, inventoryQuantity: 5 }], pageInfo: { hasNextPage: false, endCursor: null } } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      } else if (parsedBody.query.includes("PortfolioSnapshot")) {
        response.end(JSON.stringify({ data: { shop: { name: "First Store", myshopifyDomain: "first-store.myshopify.com", currencyCode: "USD", timezoneAbbreviation: "EDT", plan: { displayName: "Shopify" } }, productsCount: { count: 1, precision: "EXACT" }, activeProducts: { count: 1, precision: "EXACT" }, draftProducts: { count: 0, precision: "EXACT" }, ordersCount: { count: 1, precision: "EXACT" }, unfulfilledOrders: { count: 1, precision: "EXACT" }, customersCount: { count: 1, precision: "EXACT" }, locationsCount: { count: 1, precision: "EXACT" } } }));
      } else {
        response.end(JSON.stringify({ data: { shop: { id: "gid://shopify/Shop/1", name: "First Store", myshopifyDomain: "first-store.myshopify.com", email: "owner@example.com", currencyCode: "USD", timezoneAbbreviation: "EDT" } } }));
      }
    });
  });
  await new Promise((resolveListen) => mock.listen(0, "127.0.0.1", resolveListen));
  const address = mock.address();
  assert.ok(address && typeof address === "object");

  const directory = await mkdtemp(join(tmpdir(), "shopify-multi-store-"));
  const config = join(directory, "stores.json");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(config, JSON.stringify({ stores: [
    { alias: "first-store", shop: "first-store.myshopify.com", apiVersion: "2026-07", tokenEnv: "FIRST_TEST_TOKEN", baseUrl },
    { alias: "second-store", shop: "second-store.myshopify.com", apiVersion: "2026-07", tokenEnv: "SECOND_TEST_TOKEN", baseUrl }
  ] }));

  const client = new Client({ name: "shopify-multi-store-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(pluginRoot, "dist", "index.js")],
    env: {
      ...process.env,
      SHOPIFY_MULTI_STORE_CONFIG: config,
      SHOPIFY_MULTI_STORE_ALLOW_INSECURE_HTTP: "1",
      FIRST_TEST_TOKEN: "test-first-token",
      SECOND_TEST_TOKEN: "test-second-token"
    }
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "shopify_compare_catalog",
      "shopify_compare_inventory",
      "shopify_get_shop_info",
      "shopify_graphql_mutation",
      "shopify_graphql_query",
      "shopify_graphql_query_many",
      "shopify_list_stores",
      "shopify_list_unfulfilled_orders",
      "shopify_portfolio_snapshot"
    ]);

    const stores = await client.callTool({ name: "shopify_list_stores", arguments: {} });
    assert.equal(stores.isError, undefined);
    assert.equal(stores.structuredContent.count, 2);

    const info = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "first-store" } });
    assert.equal(info.isError, undefined);
    assert.equal(info.structuredContent.store, "first-store");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].token, "test-first-token");
    assert.match(requests[0].url, /\/admin\/api\/2026-07\/graphql\.json$/);

    const rejected = await client.callTool({
      name: "shopify_graphql_query",
      arguments: { store: "first-store", query: "mutation Bad { productDelete(input: {}) { deletedProductId } }", variables: {} }
    });
    assert.equal(rejected.isError, true);
    assert.equal(requests.length, 1);

    const comparison = await client.callTool({
      name: "shopify_graphql_query_many",
      arguments: {
        stores: ["first-store", "second-store"],
        query: "query CompareShops { shop { name currencyCode } }",
        variables: {}
      }
    });
    assert.equal(comparison.isError, undefined);
    assert.equal(comparison.structuredContent.count, 2);
    assert.equal(comparison.structuredContent.succeeded, 2);
    assert.equal(comparison.structuredContent.failed, 0);
    assert.deepEqual(comparison.structuredContent.results.map((result) => result.store), ["first-store", "second-store"]);
    assert.equal(requests.length, 3);
    assert.deepEqual(new Set(requests.slice(1).map((request) => request.token)), new Set(["test-first-token", "test-second-token"]));

    const partial = await client.callTool({
      name: "shopify_graphql_query_many",
      arguments: {
        stores: ["first-store", "missing-store"],
        query: "query PartialComparison { shop { name } }",
        variables: {}
      }
    });
    assert.equal(partial.isError, undefined);
    assert.equal(partial.structuredContent.succeeded, 1);
    assert.equal(partial.structuredContent.failed, 1);
    assert.equal(partial.structuredContent.results[1].store, "missing-store");
    assert.match(partial.structuredContent.results[1].error, /Unknown store/);
    assert.equal(requests.length, 4);

    const rejectedComparison = await client.callTool({
      name: "shopify_graphql_query_many",
      arguments: {
        stores: ["first-store", "second-store"],
        query: "mutation BadComparison { productDelete(input: {}) { deletedProductId } }",
        variables: {}
      }
    });
    assert.equal(rejectedComparison.isError, true);
    assert.equal(requests.length, 4);

    const snapshot = await client.callTool({
      name: "shopify_portfolio_snapshot",
      arguments: { stores: ["first-store", "second-store"] }
    });
    assert.equal(snapshot.isError, undefined);
    assert.equal(snapshot.structuredContent.succeeded, 2);
    assert.equal(requests.length, 6);

    const inventory = await client.callTool({
      name: "shopify_compare_inventory",
      arguments: { stores: ["first-store", "second-store"], skus: ["SKU-1"] }
    });
    assert.equal(inventory.isError, undefined);
    assert.equal(inventory.structuredContent.matrix[0].stores["first-store"][0].inventoryQuantity, 5);
    assert.equal(requests.length, 8);

    const orders = await client.callTool({
      name: "shopify_list_unfulfilled_orders",
      arguments: { stores: ["first-store", "second-store"], days: 7, first: 10 }
    });
    assert.equal(orders.isError, undefined);
    assert.equal(orders.structuredContent.succeeded, 2);
    assert.equal(requests.length, 10);

    const catalog = await client.callTool({
      name: "shopify_compare_catalog",
      arguments: { stores: ["first-store", "second-store"], handles: ["example"] }
    });
    assert.equal(catalog.isError, undefined);
    assert.equal(catalog.structuredContent.matrix[0].consistent, true);
    assert.equal(requests.length, 12);
  } finally {
    await client.close();
    await new Promise((resolveClose) => mock.close(resolveClose));
  }
});
