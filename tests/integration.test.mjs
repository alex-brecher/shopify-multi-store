import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PasswordDeleteError } from "cross-keychain";
import { getAccessToken } from "../dist/config.js";
import { isMissingCredentialError } from "../dist/credentials.js";
import { parseLegacyStores, verifyAccessToken } from "../scripts/config-helpers.mjs";

const pluginRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("lists two stores and routes a shop query to the selected store", async () => {
  const requests = [];
  let throttleAttempts = 0;
  let graphqlThrottleAttempts = 0;
  const mock = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsedBody = JSON.parse(body);
      const storeId = request.headers["x-shopify-access-token"] === "test-second-token" ? "2" : "1";
      requests.push({ url: request.url, token: request.headers["x-shopify-access-token"], userAgent: request.headers["user-agent"], body: parsedBody });
      if (parsedBody.query.includes("ThrottleThenSucceed")) {
        throttleAttempts += 1;
        if (throttleAttempts === 1) {
          response.writeHead(429, { "content-type": "application/json", "x-request-id": "throttled-request", "retry-after": "0" });
          response.end(JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }));
          return;
        }
      }
      if (parsedBody.query.includes("NonJsonResponse")) {
        response.writeHead(502, { "content-type": "text/html", "x-request-id": "html-response" });
        response.end("<html>Bad gateway</html>");
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "x-request-id": "mock-request" });
      if (parsedBody.query.includes("GraphqlBudgetRetry")) {
        graphqlThrottleAttempts += 1;
        response.end(JSON.stringify(graphqlThrottleAttempts === 1
          ? { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }
          : { data: { shop: { name: "First Store" } } }));
      } else if (parsedBody.query.includes("OversizedResponse")) {
        response.end(JSON.stringify({ data: { oversized: "x".repeat(51_000) } }));
      } else if (parsedBody.query.includes("ThrottleThenSucceed")) {
        response.end(JSON.stringify({ data: { shop: { name: "First Store" } } }));
      } else if (parsedBody.query.includes("CompareInventory")) {
        const secondPage = parsedBody.variables.after === "inventory-page-1";
        const variantId = secondPage ? 2 : 1;
        response.end(JSON.stringify({ data: { productVariants: { nodes: [{ id: `gid://shopify/ProductVariant/${storeId}${variantId}`, sku: "SKU-1", title: secondPage ? "Second" : "Default", inventoryQuantity: secondPage ? 7 : 5, price: "10.00", compareAtPrice: null, product: { id: `gid://shopify/Product/${storeId}`, title: "Example", handle: "example", status: "ACTIVE", vendor: "Example Vendor", productType: "Example" } }], pageInfo: { hasNextPage: !secondPage, endCursor: secondPage ? null : "inventory-page-1" } } } }));
      } else if (parsedBody.query.includes("UnfulfilledOrders")) {
        response.end(JSON.stringify({ data: { orders: { nodes: [{ id: "gid://shopify/Order/1", name: "#1001", createdAt: "2026-08-21T00:00:00Z", updatedAt: "2026-08-21T00:00:00Z", displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", totalPriceSet: { shopMoney: { amount: "25.00", currencyCode: "USD" } } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      } else if (parsedBody.query.includes("CatalogVariantsPage")) {
        response.end(JSON.stringify({ data: { product: { variants: { nodes: [{ id: `gid://shopify/ProductVariant/${storeId}2`, sku: "SKU-2", title: "Second", price: "12.00", compareAtPrice: null, inventoryQuantity: 3 }], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
      } else if (parsedBody.query.includes("CompareCatalog")) {
        const missingPageInfo = String(parsedBody.variables.query).includes("missing-page-info");
        response.end(JSON.stringify({ data: { products: { nodes: [{ id: `gid://shopify/Product/${storeId}`, handle: missingPageInfo ? "missing-page-info" : "example", title: "Example", status: "ACTIVE", vendor: "Example Vendor", productType: "Example", totalInventory: 8, updatedAt: "2026-08-21T00:00:00Z", variants: missingPageInfo ? { nodes: [] } : { nodes: [{ id: `gid://shopify/ProductVariant/${storeId}1`, sku: "SKU-1", title: "Default", price: "10.00", compareAtPrice: null, inventoryQuantity: 5 }], pageInfo: { hasNextPage: true, endCursor: "catalog-variant-page-1" } } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      } else if (parsedBody.query.includes("PortfolioSnapshot")) {
        response.end(JSON.stringify({ data: { shop: { name: "First Store", myshopifyDomain: "first-store.myshopify.com", currencyCode: "USD", timezoneAbbreviation: "EDT", plan: { displayName: "Shopify" } }, productsCount: { count: 1, precision: "EXACT" }, activeProducts: { count: 1, precision: "EXACT" }, draftProducts: { count: 0, precision: "EXACT" }, ordersCount: { count: 1, precision: "EXACT" }, unfulfilledOrders: { count: 1, precision: "EXACT" }, customersCount: { count: 1, precision: "EXACT" }, locationsCount: { count: 1, precision: "EXACT" } } }));
      } else if (parsedBody.query.includes("OrderSummary")) {
        response.end(JSON.stringify({ data: { orders: { nodes: [{ id: "gid://shopify/Order/2", name: "#1002", createdAt: "2026-08-21T00:00:00Z", cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", currentTotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } }, currentTotalDiscountsSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } }, currentShippingPriceSet: { shopMoney: { amount: "5.00", currencyCode: "USD" } }, currentTotalTaxSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      } else if (parsedBody.query.includes("LowStockReport")) {
        response.end(JSON.stringify({ data: { productVariants: { nodes: [{ id: "gid://shopify/ProductVariant/3", sku: "LOW-1", barcode: null, title: "Default", inventoryQuantity: 0, price: "9.00", inventoryPolicy: "DENY", product: { id: "gid://shopify/Product/3", title: "Low Stock", handle: "low-stock", status: "ACTIVE", vendor: "Vendor", productType: "Type" } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      } else if (parsedBody.query.includes("CatalogHealth")) {
        response.end(JSON.stringify({ data: { products: { nodes: [{ id: "gid://shopify/Product/4", title: "Needs Work", handle: "needs-work", status: "ACTIVE", vendor: "", productType: "", totalInventory: 0, tracksInventory: true, updatedAt: "2026-08-21T00:00:00Z", seo: { title: "", description: "" }, featuredMedia: null, variantsCount: { count: 1, precision: "EXACT" } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      } else if (parsedBody.query.includes("RecentProductChanges")) {
        response.end(JSON.stringify({ data: { products: { nodes: [{ id: "gid://shopify/Product/5", title: "Changed", handle: "changed", status: "ACTIVE", vendor: "Vendor", productType: "Type", totalInventory: 5, createdAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-21T00:00:00Z" }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      } else if (parsedBody.query.includes("CustomerGrowth")) {
        response.end(JSON.stringify({ data: { shop: { currencyCode: "USD" }, totalCustomers: { count: 100, precision: "EXACT" }, currentCustomers: { count: 12, precision: "EXACT" }, previousCustomers: { count: 10, precision: "EXACT" } } }));
      } else if (parsedBody.query.includes("CompareCollections")) {
        response.end(JSON.stringify({ data: { collections: { nodes: [{ id: "gid://shopify/Collection/1", handle: "featured", title: "Featured", updatedAt: "2026-08-21T00:00:00Z", sortOrder: "BEST_SELLING", productsCount: { count: 4, precision: "EXACT" }, seo: { title: "Featured", description: "Featured products" }, image: { altText: "Featured", url: "https://cdn.example.com/featured.jpg" } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      } else if (parsedBody.query.includes("StoreLocations")) {
        response.end(JSON.stringify({ data: { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Warehouse", deactivatedAt: null, addressVerified: true, fulfillsOnlineOrders: true, hasActiveInventory: true, address: { address1: "1 Main St", address2: null, city: "Albany", province: "New York", provinceCode: "NY", country: "United States", countryCode: "US", zip: "12201", formatted: ["1 Main St", "Albany NY 12201"] } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      } else if (parsedBody.query.includes("DuplicateSkuReport")) {
        response.end(JSON.stringify({ data: { productVariants: { nodes: [{ id: "gid://shopify/ProductVariant/4", sku: "DUP-1", title: "First", product: { id: "gid://shopify/Product/6", title: "Duplicate One", handle: "duplicate-one", status: "ACTIVE" } }, { id: "gid://shopify/ProductVariant/5", sku: "DUP-1", title: "Second", product: { id: "gid://shopify/Product/7", title: "Duplicate Two", handle: "duplicate-two", status: "ACTIVE" } }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
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
      "shopify_catalog_health",
      "shopify_compare_catalog",
      "shopify_compare_collections",
      "shopify_compare_inventory",
      "shopify_compare_prices",
      "shopify_customer_growth",
      "shopify_duplicate_sku_report",
      "shopify_get_shop_info",
      "shopify_graphql_mutation",
      "shopify_graphql_query",
      "shopify_graphql_query_many",
      "shopify_list_stores",
      "shopify_list_unfulfilled_orders",
      "shopify_low_stock_report",
      "shopify_order_summary",
      "shopify_portfolio_snapshot",
      "shopify_recent_product_changes",
      "shopify_store_locations"
    ]);

    const stores = await client.callTool({ name: "shopify_list_stores", arguments: {} });
    assert.equal(stores.isError, undefined);
    assert.equal(stores.structuredContent.count, 2);

    const info = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "first-store" } });
    assert.equal(info.isError, undefined);
    assert.equal(info.structuredContent.store, "first-store");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].token, "test-first-token");
    assert.match(requests[0].userAgent, /^shopify-multi-store-mcp-server\/\d+\.\d+\.\d+$/);
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
    assert.equal(inventory.structuredContent.matrix[0].stores["first-store"][1].inventoryQuantity, 7);
    assert.equal(inventory.structuredContent.results[0].result.data.productVariants.pageInfo.hasNextPage, false);
    assert.equal(requests.length, 10);

    const orders = await client.callTool({
      name: "shopify_list_unfulfilled_orders",
      arguments: { stores: ["first-store", "second-store"], days: 7, first: 10 }
    });
    assert.equal(orders.isError, undefined);
    assert.equal(orders.structuredContent.succeeded, 2);
    assert.equal(orders.structuredContent.summaries[0].complete, true);
    assert.equal(requests.length, 12);

    const catalog = await client.callTool({
      name: "shopify_compare_catalog",
      arguments: { stores: ["first-store", "second-store"], handles: ["example"] }
    });
    assert.equal(catalog.isError, undefined);
    assert.equal(catalog.structuredContent.matrix[0].consistent, true);
    assert.equal(catalog.structuredContent.matrix[0].stores["first-store"].variants.nodes.length, 2);
    assert.equal(catalog.structuredContent.matrix[0].stores["first-store"].variants.pageInfo.hasNextPage, false);
    assert.equal(requests.length, 16);

    const orderSummary = await client.callTool({
      name: "shopify_order_summary",
      arguments: { stores: ["first-store", "second-store"], days: 30, first: 100 }
    });
    assert.equal(orderSummary.isError, undefined);
    assert.equal(orderSummary.structuredContent.summaries[0].currencyTotals.USD.currentOrderValue, 100);
    assert.equal(orderSummary.structuredContent.summaries[0].currencyTotals.USD.averageOrderValue, 100);
    assert.equal(requests.length, 18);

    const lowStock = await client.callTool({
      name: "shopify_low_stock_report",
      arguments: { stores: ["first-store", "second-store"], threshold: 10 }
    });
    assert.equal(lowStock.isError, undefined);
    assert.equal(lowStock.structuredContent.summaries[0].outOfStock, 1);
    assert.equal(requests.length, 20);

    const health = await client.callTool({
      name: "shopify_catalog_health",
      arguments: { stores: ["first-store", "second-store"], first: 100 }
    });
    assert.equal(health.isError, undefined);
    assert.equal(health.structuredContent.summaries[0].productsWithIssues, 1);
    assert.ok(health.structuredContent.summaries[0].issues[0].issues.includes("missing_vendor"));
    assert.equal(requests.length, 22);

    const recent = await client.callTool({
      name: "shopify_recent_product_changes",
      arguments: { stores: ["first-store", "second-store"], days: 7, first: 100 }
    });
    assert.equal(recent.isError, undefined);
    assert.equal(recent.structuredContent.summaries[0].returnedProducts, 1);
    assert.equal(requests.length, 24);

    const growth = await client.callTool({
      name: "shopify_customer_growth",
      arguments: { stores: ["first-store", "second-store"], days: 30 }
    });
    assert.equal(growth.isError, undefined);
    assert.equal(growth.structuredContent.summaries[0].change, 2);
    assert.equal(growth.structuredContent.summaries[0].growthRate, 0.2);
    assert.equal(requests.length, 26);

    const collections = await client.callTool({
      name: "shopify_compare_collections",
      arguments: { stores: ["first-store", "second-store"], handles: ["featured"] }
    });
    assert.equal(collections.isError, undefined);
    assert.equal(collections.structuredContent.matrix[0].consistent, true);
    assert.equal(requests.length, 28);

    const locations = await client.callTool({
      name: "shopify_store_locations",
      arguments: { stores: ["first-store", "second-store"] }
    });
    assert.equal(locations.isError, undefined);
    assert.equal(locations.structuredContent.summaries[0].fulfillsOnlineOrders, 1);
    assert.equal(requests.length, 30);

    const duplicates = await client.callTool({
      name: "shopify_duplicate_sku_report",
      arguments: { stores: ["first-store", "second-store"], first: 250 }
    });
    assert.equal(duplicates.isError, undefined);
    assert.equal(duplicates.structuredContent.summaries[0].duplicateSkus.length, 1);
    assert.equal(duplicates.structuredContent.crossStoreSkus.length, 1);
    assert.equal(requests.length, 32);

    const prices = await client.callTool({
      name: "shopify_compare_prices",
      arguments: { stores: ["first-store", "second-store"], skus: ["SKU-1"] }
    });
    assert.equal(prices.isError, undefined);
    assert.equal(prices.structuredContent.matrix[0].consistent, true);
    assert.equal(prices.structuredContent.matrix[0].stores["first-store"][0].price, "10.00");
    assert.equal(requests.length, 36);

    const throttled = await client.callTool({
      name: "shopify_graphql_query",
      arguments: { store: "first-store", query: "query ThrottleThenSucceed { shop { name } }", variables: {} }
    });
    assert.equal(throttled.isError, undefined);
    assert.equal(throttleAttempts, 2);
    assert.equal(requests.length, 38);

    const graphqlThrottled = await client.callTool({
      name: "shopify_graphql_query",
      arguments: { store: "first-store", query: "query GraphqlBudgetRetry { shop { name } }", variables: {} }
    });
    assert.equal(graphqlThrottled.isError, undefined);
    assert.equal(graphqlThrottleAttempts, 2);
    assert.equal(requests.length, 40);

    const oversized = await client.callTool({
      name: "shopify_graphql_query",
      arguments: { store: "first-store", query: "query OversizedResponse { shop { name } }", variables: {} }
    });
    assert.equal(oversized.isError, true);
    assert.match(oversized.content[0].text, /more than 50000 characters/);
    assert.equal(requests.length, 41);

    const nonJson = await client.callTool({
      name: "shopify_graphql_query",
      arguments: { store: "first-store", query: "query NonJsonResponse { shop { name } }", variables: {} }
    });
    assert.equal(nonJson.isError, true);
    assert.match(nonJson.content[0].text, /non-JSON response.*HTTP 502/);
    assert.equal(requests.length, 42);

    const incompleteCatalog = await client.callTool({
      name: "shopify_compare_catalog",
      arguments: { stores: ["first-store", "second-store"], handles: ["missing-page-info"] }
    });
    assert.equal(incompleteCatalog.isError, undefined);
    assert.equal(incompleteCatalog.structuredContent.failed, 2);
    assert.match(incompleteCatalog.structuredContent.results[0].error, /no variant page information/i);
    assert.equal(requests.length, 44);
  } finally {
    await client.close();
    await new Promise((resolveClose) => mock.close(resolveClose));
  }
});

test("classifies only a missing credential as safe to ignore", () => {
  assert.equal(isMissingCredentialError(new PasswordDeleteError("Password not found")), true);
  assert.equal(isMissingCredentialError(new PasswordDeleteError("Keychain operation failed with code 36")), false);
  assert.equal(isMissingCredentialError(new Error("Password not found")), false);
});

test("parses array and Hermes object legacy store formats", () => {
  assert.deepEqual(parseLegacyStores({ stores: [{ label: "Retail", domain: "retail.myshopify.com", access_token: "token" }] }), [{
    alias: "retail",
    shop: "retail.myshopify.com",
    auth: { type: "access_token" },
    credential: "token"
  }]);

  assert.deepEqual(parseLegacyStores({
    stores: { retail: "retail.myshopify.com", "Wholesale Store": { domain: "wholesale.myshopify.com" } },
    plus_app: { client_id: "client-id", client_secret: "client-secret" }
  }), [{
    alias: "retail",
    shop: "retail.myshopify.com",
    auth: { type: "client_credentials", clientId: "client-id" },
    credential: "client-secret"
  }, {
    alias: "wholesale-store",
    shop: "wholesale.myshopify.com",
    auth: { type: "client_credentials", clientId: "client-id" },
    credential: "client-secret"
  }]);
});

test("OAuth errors identify non-JSON responses", async () => {
  const originalFetch = globalThis.fetch;
  process.env.SHOPIFY_CLIENT_SECRET_OAUTH_ERROR = "client-secret";
  globalThis.fetch = async () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  try {
    await assert.rejects(getAccessToken({
      alias: "oauth-error",
      shop: "oauth-error.myshopify.com",
      apiVersion: "2026-07",
      auth: { type: "client_credentials", clientId: "client-id" }
    }), /non-JSON response.*HTTP 502/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SHOPIFY_CLIENT_SECRET_OAUTH_ERROR;
  }
});

test("OAuth cache changes when client credentials change", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests += 1;
    const secret = new URLSearchParams(String(options.body)).get("client_secret");
    return Response.json({ access_token: `token-for-${secret}`, expires_in: 86_399 });
  };
  try {
    process.env.SHOPIFY_CLIENT_SECRET_OAUTH_CACHE = "first-secret";
    const store = { alias: "oauth-cache", shop: "oauth-cache.myshopify.com", apiVersion: "2026-07", auth: { type: "client_credentials", clientId: "client-id" } };
    assert.equal(await getAccessToken(store), "token-for-first-secret");
    process.env.SHOPIFY_CLIENT_SECRET_OAUTH_CACHE = "second-secret";
    assert.equal(await getAccessToken(store), "token-for-second-secret");
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SHOPIFY_CLIENT_SECRET_OAUTH_CACHE;
  }
});

test("setup token verification rejects a token for another store", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: { shop: { name: "Other Store", myshopifyDomain: "other-store.myshopify.com" } } });
  try {
    await assert.rejects(verifyAccessToken({
      shop: "expected-store.myshopify.com",
      apiVersion: "2026-07",
      token: "test-token"
    }), /belongs to other-store\.myshopify\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
