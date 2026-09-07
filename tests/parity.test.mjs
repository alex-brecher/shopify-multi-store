import { uploadImage } from "../dist/media.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "graphql";
import { registerAdminTools } from "../dist/admin-tools.js";
import { registerDiscoveryTools } from "../dist/discovery-tools.js";
import { DOCS } from "../dist/admin-documents.js";
import { validateDocument } from "../dist/schema.js";
import { operation, mutationErrors } from "../dist/operations.js";
import { retryDelay, adminGraphql } from "../dist/shopify.js";
import { mapConcurrent, serializeStore } from "../dist/concurrency.js";

const gid = (type, id = 1) => `gid://shopify/${type}/${id}`;
const connection = (nodes) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "shopify-parity-"));
  const originalFetch = globalThis.fetch,
    config = process.env.SHOPIFY_MULTI_STORE_CONFIG,
    token = process.env.SHOPIFY_TOKEN_FIXTURE;
  process.env.SHOPIFY_MULTI_STORE_CONFIG = join(directory, "stores.json");
  process.env.SHOPIFY_TOKEN_FIXTURE = "fixture-token";
  await writeFile(
    process.env.SHOPIFY_MULTI_STORE_CONFIG,
    JSON.stringify({
      stores: [
        {
          alias: "fixture",
          shop: "fixture.myshopify.com",
          apiVersion: "2026-07",
        },
      ],
    }),
  );
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (config === undefined) delete process.env.SHOPIFY_MULTI_STORE_CONFIG;
    else process.env.SHOPIFY_MULTI_STORE_CONFIG = config;
    if (token === undefined) delete process.env.SHOPIFY_TOKEN_FIXTURE;
    else process.env.SHOPIFY_TOKEN_FIXTURE = token;
    await rm(directory, { recursive: true, force: true });
  });
  const tools = new Map();
  const server = {
    registerTool: (name, definition, callback) =>
      tools.set(name, { definition, callback }),
  };
  registerAdminTools(server);
  registerDiscoveryTools(server);
  const state = {
    requests: [],
    quantity: 5,
    scopes: [
      "write_products",
      "write_inventory",
      "read_orders",
      "read_customers",
      "write_discounts",
      "write_files",
      "read_reports",
      "write_publications",
    ],
    reject: undefined,
    failReadback: false,
    product: {
      id: gid("Product"),
      title: "Fixture product",
      status: "DRAFT",
      variants: connection([
        { id: gid("ProductVariant"), sku: "SKU-1", price: "10.00" },
      ]),
      media: connection([]),
    },
    collection: {
      id: gid("Collection"),
      title: "Fixture collection",
      ruleSet: null,
      products: connection([{ id: gid("Product") }]),
    },
  };
  globalThis.fetch = async (url, options) => {
    const b = JSON.parse(options.body);
    state.requests.push({ url: String(url), ...b });
    if (String(url).includes("/assistant/search"))
      return Response.json([
        {
          title: "Docs",
          url: "https://shopify.dev/docs/api",
          content: "Fixture",
        },
      ]);
    if (String(url).includes("mock.shop"))
      return Response.json({
        data: {
          products: connection([
            { id: gid("Product"), title: "Shirt", description: "A shirt" },
          ]),
        },
      });
    const op = parse(b.query).definitions.find(
      (d) => d.kind === "OperationDefinition",
    );
    const name = op.name?.value;
    const root = op.selectionSet.selections[0].name.value;
    const v = b.variables;
    if (state.reject === name)
      return Response.json({
        data: {
          [root]: {
            userErrors: [{ message: "Rejected fixture", field: ["input"] }],
          },
        },
      });
    const product = () => ({ ...state.product });
    const collection = () => ({ ...state.collection });
    let data;
    switch (name) {
      case "StoreCapabilities":
        data = {
          shop: { myshopifyDomain: "fixture.myshopify.com" },
          currentAppInstallation: {
            accessScopes: state.scopes.map((handle) => ({ handle })),
          },
        };
        break;
      case "StoreIdentity":
        data = {
          shop: { id: gid("Shop"), myshopifyDomain: "fixture.myshopify.com" },
        };
        break;
      case "SearchProducts":
        data = { products: connection([product()]) };
        break;
      case "GetProduct":
        if (
          state.failReadback &&
          state.requests.some((r) => r.query.includes("mutation UpdateProduct"))
        )
          throw Error("readback failed");
        data = { product: product() };
        break;
      case "SearchCollections":
        data = { collections: connection([collection()]) };
        break;
      case "GetCollection":
        data = { collection: collection() };
        break;
      case "ListOrders":
        data = { orders: connection([{ id: gid("Order"), name: "#1" }]) };
        break;
      case "GetOrder":
        data = { order: { id: gid("Order"), lineItems: connection([]) } };
        break;
      case "ListCustomers":
        data = {
          customers: connection([
            { id: gid("Customer"), displayName: "Customer" },
          ]),
        };
        break;
      case "ProductInventory":
        data = {
          product: {
            id: gid("Product"),
            variants: connection([
              {
                inventoryItem: {
                  id: gid("InventoryItem"),
                  tracked: true,
                  inventoryLevels: connection([]),
                },
              },
            ]),
          },
        };
        break;
      case "InventoryItemLevels":
        data = {
          inventoryItem: {
            id: gid("InventoryItem"),
            inventoryLevels: connection([]),
          },
        };
        break;
      case "InventoryAtLocation":
        data = {
          inventoryItem: {
            id: gid("InventoryItem"),
            tracked: true,
            inventoryLevel: {
              location: { id: gid("Location") },
              quantities: [{ name: "available", quantity: state.quantity }],
            },
          },
        };
        break;
      case "SetInventory":
        assert.equal(v.input.quantities[0].changeFromQuantity, state.quantity);
        state.quantity = v.input.quantities[0].quantity;
        data = {
          inventorySetQuantities: {
            inventoryAdjustmentGroup: {},
            userErrors: [],
          },
        };
        break;
      case "CreateProduct":
        state.product = { ...state.product, ...v.input };
        data = { productCreate: { product: product(), userErrors: [] } };
        break;
      case "UpdateProduct":
        state.product = { ...state.product, ...v.input };
        data = { productUpdate: { product: product(), userErrors: [] } };
        break;
      case "CreateVariants":
      case "UpdateVariants":
        data = { [root]: { productVariants: v.variants, userErrors: [] } };
        break;
      case "DeleteProductMedia":
        data = {
          productDeleteMedia: {
            deletedMediaIds: v.mediaIds,
            mediaUserErrors: [],
          },
        };
        break;
      case "CreateCollection":
        state.collection = { ...state.collection, ...v.input };
        data = {
          collectionCreate: { collection: collection(), userErrors: [] },
        };
        break;
      case "UpdateCollection":
        state.collection = { ...state.collection, ...v.input };
        data = {
          collectionUpdate: { collection: collection(), userErrors: [] },
        };
        break;
      case "AddToCollection":
        data = {
          collectionAddProducts: { collection: collection(), userErrors: [] },
        };
        break;
      case "Publications":
        data = {
          publications: connection([
            { id: gid("Publication"), name: "Online Store" },
          ]),
        };
        break;
      case "PublicationRead":
        data = {
          node: { id: gid("Collection"), publishedOnPublication: true },
        };
        break;
      case "PublishResource":
        data = { publishablePublish: { userErrors: [] } };
        break;
      case "Segments":
        data = { segments: connection([{ id: gid("Segment"), name: "VIP" }]) };
        break;
      case "CreateDiscount":
        data = {
          discountCodeBasicCreate: {
            codeDiscountNode: { id: gid("DiscountCodeNode") },
            userErrors: [],
          },
        };
        break;
      case "ReadDiscount":
        data = {
          codeDiscountNode: {
            id: gid("DiscountCodeNode"),
            codeDiscount: { title: "Fixture discount" },
          },
        };
        break;
      case "Analytics":
        data = {
          shop: { currencyCode: "USD" },
          shopifyqlQuery: {
            parseErrors: [],
            tableData: {
              columns: [
                { name: "day", dataType: "date" },
                { name: "sales", dataType: "money" },
              ],
              rows: [["2026-09-01", "12.00"]],
            },
          },
        };
        break;
      case "CreateFile":
        data = {
          fileCreate: {
            files: [{ id: gid("MediaImage"), fileStatus: "READY" }],
            userErrors: [],
          },
        };
        break;
      case "GetFile":
        data = {
          node: {
            id: gid("MediaImage"),
            fileStatus: "READY",
            image: { url: "https://cdn.shopify.com/fixture.png" },
          },
        };
        break;
      case "StartBulkQuery":
        data = {
          bulkOperationRunQuery: {
            bulkOperation: { id: gid("BulkOperation"), status: "CREATED" },
            userErrors: [],
          },
        };
        break;
      case "BulkStatus":
        data = {
          node: {
            id: gid("BulkOperation"),
            status: "FAILED",
            errorCode: "INTERNAL_SERVER_ERROR",
            partialDataUrl: "https://storage.googleapis.com/partial",
          },
        };
        break;
      default:
        throw Error(`Unmocked operation ${name}`);
    }
    return Response.json({ data });
  };
  const call = async (name, args = {}) => {
    const tool = tools.get(`shopify_${name}`);
    assert.ok(tool, name);
    const parsed = tool.definition.inputSchema.parse({
      store: "fixture",
      ...args,
    });
    return tool.callback(parsed);
  };
  return { state, tools, call };
}

test("all fixed operations validate against their supported Shopify schema", async () => {
  for (const [name, document] of Object.entries(DOCS)) {
    const version = /^collection(Create|Update)$/.test(name)
      ? "2026-04"
      : "2026-07";
    assert.deepEqual(await validateDocument(document, version), [], name);
  }
});
test("AST guards support fragments and reject mixed or multiple operations", () => {
  assert.doesNotThrow(() =>
    operation("fragment S on Shop { name } query { shop {...S} }", "query"),
  );
  assert.throws(
    () =>
      operation(
        'query A{shop{name}} mutation B{productDelete(input:{id:"x"}){deletedProductId}}',
        "query",
      ),
    /exactly one/,
  );
  assert.throws(
    () => operation("mutation { x }", "query"),
    /does not accept mutations/,
  );
  assert.throws(() => operation("{shop{", "query"));
});
test("mutation errors follow aliases, inline fragments and named fragments", () => {
  const doc =
    'mutation M{ result:productUpdate(product:{id:"x"}){...Payload} } fragment Payload on ProductUpdatePayload{... on ProductUpdatePayload{problems:userErrors{message}}}';
  assert.equal(
    mutationErrors(doc, { result: { problems: [{ message: "No" }] } }).length,
    1,
  );
  assert.deepEqual(mutationErrors(doc, { result: { problems: [] } }), []);
  assert.equal(
    mutationErrors(
      'mutation{productDeleteMedia(productId:"x",mediaIds:[]){problems:mediaUserErrors{message}}}',
      { productDeleteMedia: { problems: [{ message: "No" }] } },
    ).length,
    1,
  );
});
test("cost-aware retry delay follows Shopify restore rate and Retry-After", () => {
  const cost = {
    extensions: {
      cost: {
        requestedQueryCost: 100,
        throttleStatus: { currentlyAvailable: 0, restoreRate: 10 },
      },
    },
  };
  assert.equal(retryDelay(undefined, 0, cost), 10050);
  assert.equal(
    retryDelay(new Response("", { headers: { "retry-after": "2" } }), 0, cost),
    2000,
  );
});
test("bounded concurrency preserves input ordering", async () => {
  let active = 0,
    max = 0;
  const values = await mapConcurrent(
    [3, 2, 1, 0],
    async (n) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n;
    },
    2,
  );
  assert.deepEqual(values, [3, 2, 1, 0]);
  assert.equal(max, 2);
});
test("store queues serialize same-store work and release after a failure", async () => {
  const calls = [];
  await Promise.allSettled([
    serializeStore("a", async () => {
      calls.push(1);
      throw Error("fixture");
    }),
    serializeStore("a", async () => {
      calls.push(2);
    }),
  ]);
  assert.deepEqual(calls, [1, 2]);
});
test("all read workflows return data through versioned schema validation", async (t) => {
  const { call } = await fixture(t);
  for (const [name, args] of [
    ["switch_shop", {}],
    ["get_store_capabilities", {}],
    ["search_products", { query: "shirt" }],
    ["get_product", { id: gid("Product") }],
    ["search_collections", {}],
    ["get_collection", { id: gid("Collection") }],
    ["list_orders", {}],
    ["get_order", { id: gid("Order") }],
    ["list_customers", {}],
    ["get_inventory_levels", { productId: gid("Product") }],
    ["get_inventory_levels", { inventoryItemId: gid("InventoryItem") }],
    ["list_publications", {}],
  ]) {
    const result = await call(name, args);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.store, "fixture");
  }
});
test("product creation includes options, variants, media and collection membership", async (t) => {
  const { call, state } = await fixture(t);
  const r = await call("create_product", {
    confirm: true,
    title: "Shirt",
    options: ["Size"],
    variants: [
      {
        price: "12.00",
        sku: "S",
        optionValues: [{ optionName: "Size", name: "Small" }],
      },
    ],
    images: [{ url: "https://cdn.shopify.com/fixture.png" }],
    collectionId: gid("Collection"),
  });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(r.structuredContent.product.status, "DRAFT");
  const create = state.requests.find((r) =>
    r.query.includes("mutation CreateProduct"),
  );
  assert.equal(
    create.variables.input.productOptions[0].values[0].name,
    "Small",
  );
  assert.equal(create.variables.media[0].mediaContentType, "IMAGE");
  const variants = state.requests.find((r) =>
    r.query.includes("mutation CreateVariants"),
  );
  assert.equal(variants.variables.variants[0].inventoryItem.sku, "S");
  assert.ok(
    state.requests.find((r) => r.query.includes("mutation AddToCollection")),
  );
});
test("product updates handle variant prices, media removal and readback", async (t) => {
  const { call } = await fixture(t);
  const r = await call("update_product", {
    confirm: true,
    id: gid("Product"),
    title: "Changed",
    variants: [{ id: gid("ProductVariant"), price: "20.00", sku: "NEW" }],
    removeMediaIds: [gid("MediaImage")],
  });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(r.structuredContent.after.title, "Changed");
  assert.equal(r.structuredContent.before.title, "Fixture product");
});
test("collection create and update use the supported legacy contract and explicit publication", async (t) => {
  const { call, state } = await fixture(t);
  const r = await call("create_collection", {
    confirm: true,
    title: "Manual",
    productIds: [gid("Product")],
    publicationIds: [gid("Publication")],
  });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.match(
    state.requests.find((r) => r.query.includes("mutation CreateCollection"))
      .url,
    /2026-04/,
  );
  assert.equal(
    (
      await call("update_collection", {
        confirm: true,
        id: gid("Collection"),
        title: "Updated",
      })
    ).isError,
    undefined,
  );
  assert.equal(
    (
      await call("add_to_collection", {
        confirm: true,
        collectionId: gid("Collection"),
        productIds: [gid("Product")],
      })
    ).isError,
    undefined,
  );
});
test("smart collections use rules and reject manual membership before a write", async (t) => {
  const { call, state } = await fixture(t);
  const r = await call("create_collection", {
    confirm: true,
    title: "Smart",
    ruleSet: {
      appliedDisjunctively: false,
      rules: [{ column: "TAG", relation: "EQUALS", condition: "featured" }],
    },
  });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const before = state.requests.length;
  const rejected = await call("add_to_collection", {
    confirm: true,
    collectionId: gid("Collection"),
    productIds: [gid("Product")],
  });
  assert.equal(rejected.isError, true);
  assert.ok(
    state.requests.slice(before).every((r) => !r.query.includes("mutation")),
  );
});
test("inventory uses server-side compare-and-set and refuses a stale read", async (t) => {
  const { call, state } = await fixture(t);
  const args = {
    confirm: true,
    inventoryItemId: gid("InventoryItem"),
    locationId: gid("Location"),
    quantity: 9,
    compareQuantity: 5,
  };
  const r = await call("set_inventory", args);
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(state.quantity, 9);
  const count = state.requests.filter((r) =>
    r.query.includes("mutation"),
  ).length;
  assert.equal((await call("set_inventory", args)).isError, true);
  assert.equal(
    state.requests.filter((r) => r.query.includes("mutation")).length,
    count,
  );
});
test("discounts map audiences and minimum requirements to current input types", async (t) => {
  const { call, state } = await fixture(t);
  const args = {
    confirm: true,
    title: "VIP offer",
    code: "VIP15",
    percentage: 15,
    startsAt: "2026-09-07T00:00:00Z",
    customerSegments: ["VIP"],
    minimumQuantity: 2,
  };
  const r = await call("create_discount", args);
  assert.equal(r.isError, undefined, JSON.stringify(r));
  let v = state.requests.find((r) =>
    r.query.includes("mutation CreateDiscount"),
  ).variables.input;
  assert.deepEqual(v.context.customerSegments.add, [gid("Segment")]);
  assert.equal(v.customerGets.value.percentage, 0.15);
  const all = await call("create_discount", {
    ...args,
    customerSegments: undefined,
    customerEligibility: "all_customers",
    minimumQuantity: undefined,
    minimumPurchaseAmount: 25,
  });
  assert.equal(all.isError, undefined, JSON.stringify(all));
});
test("bulk status updates reject oversized selections before writes and read back each item", async (t) => {
  const { call, state } = await fixture(t);
  assert.equal(
    (
      await call("bulk_update_product_status", {
        confirm: true,
        productIds: [gid("Product"), gid("Product", 2)],
        status: "ACTIVE",
        maxProducts: 1,
      })
    ).isError,
    true,
  );
  assert.ok(state.requests.every((r) => !r.query.includes("mutation")));
  const r = await call("bulk_update_product_status", {
    confirm: true,
    collectionId: gid("Collection"),
    status: "ACTIVE",
  });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(r.structuredContent.succeeded, 1);
});
test("partial writes preserve succeeded steps and do not replay mutations", async (t) => {
  const { call, state } = await fixture(t);
  state.reject = "CreateVariants";
  const r = await call("create_product", {
    confirm: true,
    title: "Partial",
    options: ["Size"],
    variants: [
      { price: "10", optionValues: [{ optionName: "Size", name: "S" }] },
    ],
  });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.completedSteps.length, 1);
  assert.equal(
    state.requests.filter((r) => r.query.includes("mutation CreateProduct"))
      .length,
    1,
  );
});
test("missing scopes and missing confirmation cannot send writes", async (t) => {
  const { call, state } = await fixture(t);
  await assert.rejects(call("create_product", { title: "No approval" }));
  state.scopes = [];
  const r = await call("create_product", { confirm: true, title: "No scope" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.structuredContent.missingScopes, ["write_products"]);
  assert.ok(state.requests.every((r) => !r.query.includes("mutation")));
});
test("readback failure keeps the successful mutation visible", async (t) => {
  const { call, state } = await fixture(t);
  state.failReadback = true;
  const r = await call("update_product", {
    confirm: true,
    id: gid("Product"),
    title: "Changed",
  });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.completedSteps.length, 1);
});
test("analytics returns tables and chart metadata", async (t) => {
  const { call } = await fixture(t);
  const r = await call("run_analytics_query", {
    query: "FROM sales SHOW total_sales TIMESERIES day SINCE -7d",
  });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(r.structuredContent.rowCount, 1);
  assert.equal(r.structuredContent.chartHint.type, "line");
});
test("image upload returns the processed CDN URL and can resume by ID", async (t) => {
  const { call } = await fixture(t);
  const r = await call("upload_image", {
    confirm: true,
    sourceUrl: "https://example.com/image.png",
  });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(r.structuredContent.status, "READY");
  assert.equal(
    (await call("get_uploaded_image", { id: gid("MediaImage") })).isError,
    undefined,
  );
});
test("bulk exports resume by ID without treating partial output as complete", async (t) => {
  const { call } = await fixture(t);
  const r = await call("bulk_export_start", {
    confirm: true,
    query: "{ products { edges { node { id } } } }",
  });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const status = await call("bulk_export_status", { id: gid("BulkOperation") });
  assert.equal(status.structuredContent.complete, false);
  assert.equal(status.structuredContent.partial, true);
});
test("schema tool catches nonexistent fields without a store API request", async (t) => {
  const { call, state } = await fixture(t);
  const r = await call("validate_graphql_codeblocks", {
    codeblocks: [{ content: "{shop{notAField}}" }],
  });
  assert.equal(r.structuredContent.valid, false);
  assert.equal(state.requests.length, 0);
  assert.equal(
    (await call("graphql_schema", { type_name: "Product" })).isError,
    undefined,
  );
});

test("default product price creates a default variant", async (t) => {
  const { call, state } = await fixture(t);
  const r = await call("create_product", {
    confirm: true,
    title: "Default",
    price: "12.00",
  });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const req = state.requests.find((r) =>
    r.query.includes("mutation CreateVariants"),
  );
  assert.equal(req.variables.variants[0].price, "12.00");
  assert.deepEqual(req.variables.variants[0].optionValues, [
    { optionName: "Title", name: "Default Title" },
  ]);
});
test("partial throttled mutations retain data without replay", async (t) => {
  await fixture(t);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      data: {
        productUpdate: { product: { id: gid("Product") }, userErrors: [] },
      },
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    });
  };
  const r = await adminGraphql(
    { alias: "fixture", shop: "fixture.myshopify.com", apiVersion: "2026-07" },
    DOCS.productUpdate,
    { input: { id: gid("Product"), title: "changed" } },
  );
  assert.equal(calls, 1);
  assert.equal(r.data.productUpdate.product.id, gid("Product"));
  assert.equal(r.errors[0].extensions.code, "THROTTLED");
});

test("local image upload stages bytes and confirms the file URL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shopify-image-"));
  const path = join(directory, "image.png");
  await writeFile(path, Buffer.from([137, 80, 78, 71]));
  const old = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = old;
    await rm(directory, { recursive: true, force: true });
  });
  let uploaded = false;
  globalThis.fetch = async (url, opts) => {
    assert.equal(String(url), "https://storage.googleapis.com/upload");
    assert.ok(opts.body instanceof FormData);
    assert.equal(opts.body.get("file").size, 4);
    uploaded = true;
    return new Response("", { status: 201 });
  };
  const w = {
    requireScopes: async () => {},
    run: async (doc) => {
      if (doc === DOCS.stage)
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: "https://storage.googleapis.com/upload",
                resourceUrl: "https://storage.googleapis.com/image.png",
                parameters: [],
              },
            ],
          },
        };
      if (doc === DOCS.file)
        return { fileCreate: { files: [{ id: gid("MediaImage") }] } };
      return {
        node: {
          fileStatus: "READY",
          image: {
            url: "https://cdn.shopify.com/image.png",
            altText: "Test image",
          },
        },
      };
    },
  };
  const r = await uploadImage(w, { imageFile: path, alt: "Test image" });
  assert.equal(uploaded, true);
  assert.equal(r.status, "READY");
  w.run = async () => ({
    stagedUploadsCreate: {
      stagedTargets: [{ url: "https://example.com/upload", parameters: [] }],
    },
  });
  await assert.rejects(
    uploadImage(w, { imageFile: path }),
    /Unexpected staged upload host/,
  );
});
test("image processing failure remains an error", async () => {
  const w = {
    requireScopes: async () => {},
    run: async (doc) =>
      doc === DOCS.file
        ? { fileCreate: { files: [{ id: gid("MediaImage") }] } }
        : {
            node: {
              fileStatus: "FAILED",
              fileErrors: [{ message: "Invalid image" }],
            },
          },
  };
  await assert.rejects(
    uploadImage(w, { sourceUrl: "https://cdn.shopify.com/image.png" }),
    /processing failed/,
  );
});
