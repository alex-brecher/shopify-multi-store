import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "graphql";
import { registerParityTools } from "../dist/parity-tools.js";

const gid = (type, id = 1) => `gid://shopify/${type}/${id}`;
const connection = (nodes) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "shopify-parity-tools-"));
  const originalFetch = globalThis.fetch,
    config = process.env.SHOPIFY_MULTI_STORE_CONFIG,
    token = process.env.SHOPIFY_TOKEN_FIXTURE;
  process.env.SHOPIFY_MULTI_STORE_CONFIG = join(directory, "stores.json");
  process.env.SHOPIFY_TOKEN_FIXTURE = "fixture-token";
  await writeFile(
    process.env.SHOPIFY_MULTI_STORE_CONFIG,
    JSON.stringify({
      stores: [
        { alias: "fixture", shop: "fixture.myshopify.com", apiVersion: "2026-07" },
        { alias: "second", shop: "second.myshopify.com", apiVersion: "2026-07" },
      ],
    }),
  );
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (config === undefined) delete process.env.SHOPIFY_MULTI_STORE_CONFIG;
    else process.env.SHOPIFY_MULTI_STORE_CONFIG = config;
    if (token === undefined) delete process.env.SHOPIFY_TOKEN_FIXTURE;
    else process.env.SHOPIFY_TOKEN_FIXTURE = token;
    process.env.SHOPIFY_TOKEN_SECOND = undefined;
    delete process.env.SHOPIFY_TOKEN_SECOND;
    await rm(directory, { recursive: true, force: true });
  });
  process.env.SHOPIFY_TOKEN_SECOND = "second-token";

  const tools = new Map();
  const server = {
    registerTool: (name, definition, callback) =>
      tools.set(name, { definition, callback }),
  };
  registerParityTools(server);

  const state = {
    requests: [],
    scopes: [
      "read_products", "write_products", "write_inventory", "read_inventory",
      "read_metaobjects", "write_metaobjects", "read_online_store_navigation",
      "write_online_store_navigation", "read_shipping", "write_shipping",
      "read_themes", "write_themes", "read_files", "write_files",
      "write_draft_orders", "write_orders", "write_customers",
      "write_fulfillments", "read_content", "write_content", "read_markets",
    ],
    reject: undefined,
    deliveryRatePersists: true,
    themeRole: "UNPUBLISHED",
    variants: {
      "SKU-FOUND": {
        id: gid("ProductVariant", 1),
        sku: "SKU-FOUND",
        price: "10.00",
        compareAtPrice: null,
        product: { id: gid("Product", 1), title: "Fixture product" },
        inventoryItem: {
          id: gid("InventoryItem", 1),
          sku: "SKU-FOUND",
          unitCost: { amount: "5.00", currencyCode: "USD" },
        },
      },
    },
  };

  globalThis.fetch = async (url, options) => {
    const b = JSON.parse(options.body);
    state.requests.push({ url: String(url), ...b });
    const op = parse(b.query).definitions.find((d) => d.kind === "OperationDefinition");
    const name = op.name?.value;
    const root = op.selectionSet.selections[0].name.value;
    const v = b.variables;
    if (state.reject === name)
      return Response.json({
        data: { [root]: { userErrors: [{ message: "Rejected fixture", field: ["input"] }] } },
      });
    let data;
    switch (name) {
      case "ParityCapabilities":
      case "StoreCapabilities":
        data = {
          shop: { id: gid("Shop"), name: "Fixture", myshopifyDomain: `${url.includes("second") ? "second" : "fixture"}.myshopify.com` },
          currentAppInstallation: { id: gid("AppInstallation"), accessScopes: state.scopes.map((handle) => ({ handle })) },
        };
        break;
      case "FindVariantsBySku": {
        const match = /sku:"([^"]*)"/.exec(v.query)?.[1];
        if (match === "SKU-AMBIGUOUS") {
          data = { productVariants: connection([
            { ...state.variants["SKU-FOUND"], id: gid("ProductVariant", 8), sku: "SKU-AMBIGUOUS" },
            { ...state.variants["SKU-FOUND"], id: gid("ProductVariant", 9), sku: "SKU-AMBIGUOUS" },
          ]) };
        } else if (state.variants[match]) {
          data = { productVariants: connection([state.variants[match]]) };
        } else {
          data = { productVariants: connection([]) };
        }
        break;
      }
      case "UpdatePricesBulk":
        data = {
          productVariantsBulkUpdate: {
            productVariants: v.variants.map((variant) => ({
              id: variant.id,
              sku: state.variants["SKU-FOUND"].sku,
              price: state.mismatchPrice ?? variant.price ?? state.variants["SKU-FOUND"].price,
              compareAtPrice: variant.compareAtPrice ?? null,
              inventoryItem: { id: gid("InventoryItem", 1), unitCost: { amount: variant.inventoryItem?.cost ?? "5.00", currencyCode: "USD" } },
            })),
            userErrors: [],
          },
        };
        break;
      case "ListDeliveryProfiles":
        data = {
          deliveryProfiles: connection([
            {
              id: gid("DeliveryProfile", 1),
              name: "General",
              default: true,
              profileLocationGroups: [
                {
                  locationGroup: { id: gid("DeliveryLocationGroup", 1), locations: connection([]) },
                  locationGroupZones: connection([
                    {
                      zone: { id: gid("DeliveryZone", 1), name: "Domestic", countries: [] },
                      methodDefinitions: connection([
                        {
                          id: gid("DeliveryMethodDefinition", 1),
                          name: "Standard",
                          active: true,
                          rateProvider: {
                            id: gid("DeliveryRateDefinition", 1),
                            price: { amount: state.deliveryRatePersists ? (state.appliedAmount ?? "5.00") : "5.00", currencyCode: "USD" },
                          },
                        },
                      ]),
                    },
                  ]),
                },
              ],
            },
          ]),
        };
        break;
      case "UpdateDeliveryRate":
        if (state.deliveryRatePersists) state.appliedAmount = v.profile.locationGroupsToUpdate[0].zonesToUpdate[0].methodDefinitionsToUpdate[0].rateDefinition.price.amount;
        data = { deliveryProfileUpdate: { profile: { id: v.id }, userErrors: [] } };
        break;
      case "ListThemes":
        data = { themes: connection([{ id: gid("OnlineStoreTheme", 1), name: "Fixture theme", role: state.themeRole, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }]) };
        break;
      case "UpsertThemeFiles":
        data = { themeFilesUpsert: { upsertedThemeFiles: v.files.map((f) => ({ filename: f.filename })), userErrors: [] } };
        break;
      case "GetMetafields":
        data = { node: { id: v.id, metafields: connection([{ id: gid("Metafield", 1), namespace: "custom", key: "note", value: "hi", type: "single_line_text_field" }]) } };
        break;
      case "SetMetafields":
        data = { metafieldsSet: { metafields: v.metafields.map((m, i) => ({ id: gid("Metafield", i + 1), ...m })), userErrors: [] } };
        break;
      case "ListMetaobjects":
        data = { metaobjects: connection([{ id: gid("Metaobject", 1), handle: "fixture", type: v.type, displayName: "Fixture", updatedAt: "2026-01-01T00:00:00Z", fields: [] }]) };
        break;
      case "UpsertMetaobject":
        data = { metaobjectUpsert: { metaobject: { id: gid("Metaobject", 1), handle: v.handle.handle, type: v.handle.type, fields: v.metaobject.fields }, userErrors: [] } };
        break;
      case "ListRedirects":
        data = { urlRedirects: connection([{ id: gid("UrlRedirect", 1), path: "/old", target: "/new" }]) };
        break;
      case "CreateRedirect":
        data = { urlRedirectCreate: { urlRedirect: { id: gid("UrlRedirect", 2), ...v.urlRedirect }, userErrors: [] } };
        break;
      case "DeleteRedirect":
        data = { urlRedirectDelete: { deletedUrlRedirectId: v.id, userErrors: [] } };
        break;
      case "ListFiles":
        data = { files: connection([{ id: gid("MediaImage", 1), alt: null, fileStatus: "READY", createdAt: "2026-01-01T00:00:00Z" }]) };
        break;
      case "DeleteFiles":
        data = { fileDelete: { deletedFileIds: v.fileIds, userErrors: [] } };
        break;
      case "GetOrderTagsNote":
        data = { order: { id: v.id, name: "#1001", tags: ["old"], note: null, email: "a@example.com" } };
        break;
      case "UpdateOrder":
        data = { orderUpdate: { order: { id: v.input.id, name: "#1001", tags: v.input.tags ?? ["old"], note: v.input.note ?? null, email: v.input.email ?? "a@example.com" }, userErrors: [] } };
        break;
      case "CreateDraftOrder":
        data = { draftOrderCreate: { draftOrder: { id: gid("DraftOrder", 1), name: "#D1", invoiceUrl: "https://fixture.myshopify.com/invoice", totalPriceSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } } }, userErrors: [] } };
        break;
      case "GetOrderFulfillmentOrders":
        data = { order: { id: v.id, name: "#1001", fulfillmentOrders: connection([{ id: gid("FulfillmentOrder", 1), status: "OPEN", lineItems: connection([{ id: gid("FulfillmentOrderLineItem", 1), remainingQuantity: 1 }]) }]) } };
        break;
      case "CreateFulfillment":
        data = { fulfillmentCreateV2: { fulfillment: { id: gid("Fulfillment", 1), status: "SUCCESS", trackingInfo: [] }, userErrors: [] } };
        break;
      case "AddTags":
        data = { tagsAdd: { node: { id: v.id, tags: v.tags }, userErrors: [] } };
        break;
      case "RemoveTags":
        data = { tagsRemove: { node: { id: v.id, tags: [] }, userErrors: [] } };
        break;
      case "GetCustomer":
        data = { customer: { id: v.id, displayName: "Fixture Customer", email: "c@example.com", tags: [], note: null } };
        break;
      case "UpdateCustomer":
        data = { customerUpdate: { customer: { id: v.input.id, displayName: "Fixture Customer", email: v.input.email ?? "c@example.com", tags: v.input.tags ?? [], note: v.input.note ?? null }, userErrors: [] } };
        break;
      case "ListPages":
        data = { pages: connection([{ id: gid("Page", 1), handle: "about", title: "About", isPublished: true, updatedAt: "2026-01-01T00:00:00Z" }]) };
        break;
      case "GetPage":
        data = { page: { id: v.id, handle: "about", title: "About", body: "<p>Hi</p>", isPublished: true } };
        break;
      case "CreatePage":
        data = { pageCreate: { page: { id: gid("Page", 2), handle: v.page.handle ?? "new-page", title: v.page.title, isPublished: v.page.isPublished ?? false }, userErrors: [] } };
        break;
      case "UpdatePage":
        data = { pageUpdate: { page: { id: v.id, handle: "about", title: v.page.title ?? "About", isPublished: v.page.isPublished ?? true }, userErrors: [] } };
        break;
      case "ListBlogArticles":
        data = { blog: { id: v.id, title: "News", articles: connection([{ id: gid("Article", 1), handle: "hello", title: "Hello", isPublished: true, publishedAt: "2026-01-01T00:00:00Z" }]) } };
        break;
      case "ListMarkets":
        data = { markets: connection([{ id: gid("Market", 1), name: "United States", handle: "us", type: "REGULAR", status: "ACTIVE", enabled: true, primary: true }]) };
        break;
      case "DeleteMetafields":
        data = { metafieldsDelete: { deletedMetafields: v.metafields, userErrors: [] } };
        break;
      default:
        throw Error(`Unmocked operation ${name}`);
    }
    return Response.json({ data });
  };

  const call = async (name, args = {}, alias = "fixture") => {
    const tool = tools.get(`shopify_${name}`);
    assert.ok(tool, name);
    const parsed = tool.definition.inputSchema.parse({ store: alias, ...args });
    return tool.callback(parsed);
  };
  const callMulti = async (name, args = {}) => {
    const tool = tools.get(`shopify_${name}`);
    assert.ok(tool, name);
    const parsed = tool.definition.inputSchema.parse(args);
    return tool.callback(parsed);
  };
  return { state, tools, call, callMulti };
}

test("update_prices: resolves SKUs, flags duplicates and not-found, and previews under dryRun", async (t) => {
  const { call } = await fixture(t);
  const result = await call("update_prices", {
    skus: [
      { sku: "SKU-FOUND", price: "12.00" },
      { sku: "SKU-FOUND", price: "13.00" },
      { sku: "SKU-MISSING", price: "9.00" },
    ],
  });
  const body = result.structuredContent;
  assert.equal(body.dryRun, true);
  assert.equal(body.wouldApply.length, 1);
  assert.equal(body.wouldApply[0].sku, "SKU-FOUND");
  assert.equal(body.wouldApply[0].requested.price, "12.00");
  assert.deepEqual(body.duplicateSkus, ["SKU-FOUND"]);
  assert.deepEqual(body.notFound, ["SKU-MISSING"]);
});

test("update_prices: dryRun:false applies and reports a mismatch when the readback disagrees", async (t) => {
  const { call, state } = await fixture(t);
  const applied = await call("update_prices", {
    skus: [{ sku: "SKU-FOUND", price: "12.00" }],
    dryRun: false,
  });
  assert.equal(applied.structuredContent.dryRun, false);
  assert.equal(applied.structuredContent.results[0].outcome, "applied");
  assert.equal(applied.structuredContent.succeeded, 1);

  state.mismatchPrice = "99.99";
  const mismatched = await call("update_prices", {
    skus: [{ sku: "SKU-FOUND", price: "12.00" }],
    dryRun: false,
  });
  assert.equal(mismatched.structuredContent.results[0].outcome, "mismatch");
  assert.equal(mismatched.structuredContent.failed, 1);
});

test("update_prices: ambiguous SKU matches are reported, not applied", async (t) => {
  const { call } = await fixture(t);
  const result = await call("update_prices", {
    skus: [{ sku: "SKU-AMBIGUOUS", price: "1.00" }],
  });
  assert.deepEqual(result.structuredContent.ambiguousSkus, ["SKU-AMBIGUOUS"]);
  assert.equal(result.structuredContent.wouldApply.length, 0);
});

test("update_prices_many: applies the same SKU list across stores independently", async (t) => {
  const { callMulti } = await fixture(t);
  const result = await callMulti("update_prices_many", {
    stores: ["fixture", "second"],
    skus: [{ sku: "SKU-FOUND", price: "12.00" }],
  });
  assert.equal(result.structuredContent.stores.length, 2);
  assert.ok(result.structuredContent.stores.every((s) => s.ok));
  assert.equal(result.structuredContent.succeeded, 2);
});

test("update_delivery_rate: detects Shopify's silent-discard (no userErrors, value not persisted)", async (t) => {
  const { call, state } = await fixture(t);
  state.deliveryRatePersists = false;
  const result = await call("update_delivery_rate", {
    deliveryProfileId: gid("DeliveryProfile", 1),
    locationGroupId: gid("DeliveryLocationGroup", 1),
    zoneId: gid("DeliveryZone", 1),
    methodDefinitionId: gid("DeliveryMethodDefinition", 1),
    rateDefinitionId: gid("DeliveryRateDefinition", 1),
    amount: "12.00",
    currencyCode: "USD",
    dryRun: false,
  });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /silent-discard|did not persist/i);
  assert.equal(result.structuredContent.persistedAmount, "5.00");
  assert.equal(result.structuredContent.requestedAmount, "12.00");
});

test("update_delivery_rate: succeeds when the readback confirms the new amount", async (t) => {
  const { call, state } = await fixture(t);
  state.deliveryRatePersists = true;
  const result = await call("update_delivery_rate", {
    deliveryProfileId: gid("DeliveryProfile", 1),
    locationGroupId: gid("DeliveryLocationGroup", 1),
    zoneId: gid("DeliveryZone", 1),
    methodDefinitionId: gid("DeliveryMethodDefinition", 1),
    rateDefinitionId: gid("DeliveryRateDefinition", 1),
    amount: "12.00",
    currencyCode: "USD",
    dryRun: false,
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.verified, true);
  assert.equal(result.structuredContent.appliedAmount, "12.00");
});

test("upsert_theme_files: refuses to write to the live (MAIN) theme without allowLiveTheme", async (t) => {
  const { call, state } = await fixture(t);
  state.themeRole = "MAIN";
  const result = await call("upsert_theme_files", {
    themeId: gid("OnlineStoreTheme", 1),
    files: [{ filename: "layout/theme.liquid", content: "<html></html>" }],
    dryRun: false,
  });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /live \(MAIN\) theme/i);
});

test("upsert_theme_files: allowLiveTheme:true permits writing to the live theme", async (t) => {
  const { call, state } = await fixture(t);
  state.themeRole = "MAIN";
  const result = await call("upsert_theme_files", {
    themeId: gid("OnlineStoreTheme", 1),
    files: [{ filename: "layout/theme.liquid", content: "<html></html>" }],
    allowLiveTheme: true,
    dryRun: false,
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.upserted.length, 1);
});

test("upsert_theme_files: a non-live theme applies without allowLiveTheme", async (t) => {
  const { call, state } = await fixture(t);
  state.themeRole = "UNPUBLISHED";
  const result = await call("upsert_theme_files", {
    themeId: gid("OnlineStoreTheme", 1),
    files: [{ filename: "layout/theme.liquid", content: "<html></html>" }],
    dryRun: false,
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.upserted.length, 1);
});

test("check_access: diffs granted scopes against every tool's requirement", async (t) => {
  const { callMulti, state } = await fixture(t);
  state.scopes = ["read_products"];
  const result = await callMulti("check_access", { stores: ["fixture"] });
  const [report] = result.structuredContent.stores;
  assert.equal(report.ok, true);
  assert.deepEqual(report.grantedScopes, ["read_products"]);
  assert.ok(report.missingScopes.includes("write_products"));
  const productTool = report.failingTools.find((f) => f.tool === "shopify_update_prices");
  assert.ok(productTool.missingScopes.includes("write_inventory"));
  const readOnlyProductTool = report.failingTools.find((f) => f.tool === "shopify_search_products");
  assert.equal(readOnlyProductTool, undefined);
  assert.ok(report.variableScopeTools.some((v) => v.tool === "shopify_tags"));
});

test("check_access: checks every configured store when none is named", async (t) => {
  const { callMulti } = await fixture(t);
  const result = await callMulti("check_access", {});
  assert.deepEqual(result.structuredContent.stores.map((s) => s.store).sort(), ["fixture", "second"]);
});

test("metafields: get, set and delete round-trip", async (t) => {
  const { call } = await fixture(t);
  const owner = gid("Product", 1);
  const got = await call("get_metafields", { ownerId: owner });
  assert.equal(got.structuredContent.metafields.length, 1);
  const setPreview = await call("set_metafields", {
    metafields: [{ ownerId: owner, namespace: "custom", key: "note", value: "hi" }],
  });
  assert.equal(setPreview.structuredContent.dryRun, true);
  const setApplied = await call("set_metafields", {
    metafields: [{ ownerId: owner, namespace: "custom", key: "note", value: "hi" }],
    dryRun: false,
  });
  assert.equal(setApplied.structuredContent.metafields.length, 1);
  const deleted = await call("delete_metafields", {
    metafields: [{ ownerId: owner, namespace: "custom", key: "note" }],
    dryRun: false,
  });
  assert.equal(deleted.structuredContent.deletedMetafields.length, 1);
});

test("tags: requires add or remove and previews under dryRun", async (t) => {
  const { call } = await fixture(t);
  const missing = await call("tags", { ownerId: gid("Product", 1) });
  assert.equal(missing.isError, true);
  assert.match(missing.structuredContent.error, /add and\/or remove/i);
  const preview = await call("tags", { ownerId: gid("Product", 1), add: ["vip"] });
  assert.equal(preview.structuredContent.dryRun, true);
  assert.deepEqual(preview.structuredContent.wouldAdd, ["vip"]);
});

test("create_fulfillment: fulfills open fulfillment orders and defaults notifyCustomer to false", async (t) => {
  const { call } = await fixture(t);
  const preview = await call("create_fulfillment", { orderId: gid("Order", 1) });
  assert.equal(preview.structuredContent.dryRun, true);
  assert.equal(preview.structuredContent.notifyCustomer, false);
  const applied = await call("create_fulfillment", { orderId: gid("Order", 1), dryRun: false });
  assert.equal(applied.structuredContent.fulfillment.status, "SUCCESS");
});
