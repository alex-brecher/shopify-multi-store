import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "graphql";
import { registerParityTools, sameMoney } from "../dist/parity-tools.js";
import { registerReadTools } from "../dist/read-tools.js";

const gid = (type, id = 1) => `gid://shopify/${type}/${id}`;
const connection = (nodes) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});

async function fixture(t, { extraStores = [] } = {}) {
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
        ...extraStores,
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
  registerReadTools(server);

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
    byId: new Map(),
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
    if (state.networkFailOn === name) throw new Error("simulated network reset");
    if (state.readbackFailsAfterWrite && name === "VariantsForPricing" && state.requests.some((r) => r.url === String(url) && /UpdatePricesBulk/.test(r.query)))
      throw new Error("simulated readback failure");
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
      case "VariantsForPricing":
        data = { nodes: v.ids.map((id) => state.byId.get(id) ?? null) };
        break;
      case "FindVariantsBySku": {
        const match = /sku:"([^"]*)"/.exec(v.query)?.[1];
        if (state.skuPages?.[match]) {
          const pages = state.skuPages[match];
          const index = v.after ? Number(v.after) : 0;
          data = { productVariants: { nodes: pages[index], pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: index + 1 < pages.length ? String(index + 1) : null } } };
        } else if (match === "SKU-AMBIGUOUS") {
          data = { productVariants: connection([
            { ...state.variants["SKU-FOUND"], id: gid("ProductVariant", 8), sku: "SKU-AMBIGUOUS" },
            { ...state.variants["SKU-FOUND"], id: gid("ProductVariant", 9), sku: "SKU-AMBIGUOUS" },
          ]) };
        } else if (state.variants[match]) {
          data = { productVariants: connection([state.variants[match]]) };
        } else {
          data = { productVariants: connection([]) };
        }
        for (const node of data.productVariants.nodes) state.byId.set(node.id, node);
        data.productVariants.nodes = data.productVariants.nodes.map(({ id, sku }) => ({ id, sku }));
        break;
      }
      case "UpdatePricesBulk":
        // The mutation response always "looks fine" (reflects what was requested). The
        // separately-stored state (read back afterward by VariantsForPricing, used as the
        // independent verification query) is what state.mismatchPrice / state.readbackCost
        // can make disagree with it, simulating Shopify accepting a write that didn't
        // actually persist as reported.
        data = {
          productVariantsBulkUpdate: {
            productVariants: v.variants.map((variant) => {
              const stored = state.byId.get(variant.id) ?? state.variants["SKU-FOUND"];
              const looksLike = {
                id: variant.id,
                sku: stored.sku,
                price: variant.price ?? stored.price,
                compareAtPrice: variant.compareAtPrice !== undefined ? variant.compareAtPrice : stored.compareAtPrice,
                inventoryItem: {
                  id: stored.inventoryItem?.id ?? gid("InventoryItem", 1),
                  unitCost: { amount: variant.inventoryItem?.cost ?? stored.inventoryItem?.unitCost?.amount ?? "5.00", currencyCode: "USD" },
                },
              };
              state.byId.set(variant.id, {
                ...stored,
                id: variant.id,
                price: state.mismatchPrice ?? looksLike.price,
                compareAtPrice: looksLike.compareAtPrice,
                inventoryItem: {
                  id: looksLike.inventoryItem.id,
                  sku: stored.sku,
                  unitCost: { amount: state.readbackCost ?? looksLike.inventoryItem.unitCost.amount, currencyCode: "USD" },
                },
              });
              return looksLike;
            }),
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
      case "GetDeliveryRate":
        state.deliveryReadbacks = (state.deliveryReadbacks ?? 0) + 1;
        data = {
          deliveryProfile: v.profileId === gid("DeliveryProfile", 1) ? { id: v.profileId } : null,
          method: v.methodId === gid("DeliveryMethodDefinition", 1)
            ? { id: v.methodId, name: "Standard", rateProvider: { id: gid("DeliveryRateDefinition", 1), price: { amount: state.deliveryRatePersists ? (state.appliedAmount ?? "5.00") : "5.00", currencyCode: "USD" } } }
            : null,
        };
        break;
      case "UpdateDeliveryRate":
        if (state.deliveryRatePersists) state.appliedAmount = (state.persistFormat ?? ((x) => x))(v.profile.locationGroupsToUpdate[0].zonesToUpdate[0].methodDefinitionsToUpdate[0].rateDefinition.price.amount);
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
        data = { order: { id: v.id, name: "#1001", fulfillmentOrders: connection(state.fulfillmentOrders ?? [{ id: gid("FulfillmentOrder", 1), status: "OPEN", lineItems: connection([{ id: gid("FulfillmentOrderLineItem", 1), remainingQuantity: 1 }]) }]) } };
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

test("update_prices: resolves SKUs, flags not-found, and previews under dryRun", async (t) => {
  const { call } = await fixture(t);
  const result = await call("update_prices", {
    skus: [
      { sku: "SKU-FOUND", price: "12.00" },
      { sku: "SKU-MISSING", price: "9.00" },
    ],
  });
  const body = result.structuredContent;
  assert.equal(body.dryRun, true);
  assert.equal(body.wouldApply.length, 1);
  assert.equal(body.wouldApply[0].sku, "SKU-FOUND");
  assert.equal(body.wouldApply[0].requested.price, "12.00");
  assert.deepEqual(body.notFound, ["SKU-MISSING"]);
});

test("update_prices: conflicting duplicate SKU rows are rejected before any write", async (t) => {
  const { call, state } = await fixture(t);
  const result = await call("update_prices", {
    skus: [
      { sku: "SKU-FOUND", price: "12.00" },
      { sku: "SKU-FOUND", price: "13.00" },
    ],
    dryRun: false,
  });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /conflicting values/i);
  assert.deepEqual(
    result.structuredContent.conflicts.map((c) => c.sku),
    ["SKU-FOUND"],
  );
  assert.equal(sentVariables(state, "UpdatePricesBulk").length, 0);
});

test("update_prices: identical duplicate SKU rows are collapsed with a note", async (t) => {
  const { call } = await fixture(t);
  const result = await call("update_prices", {
    skus: [
      { sku: "SKU-FOUND", price: "12.00" },
      { sku: "SKU-FOUND", price: "12.00" },
    ],
  });
  const body = result.structuredContent;
  assert.equal(body.dryRun, true);
  assert.equal(body.wouldApply.length, 1);
  assert.deepEqual(body.collapsedDuplicateSkus, ["SKU-FOUND"]);
});

test("update_prices: dryRun:false applies and verifies with a separate readback query", async (t) => {
  const { call, state } = await fixture(t);
  const applied = await call("update_prices", {
    skus: [{ sku: "SKU-FOUND", price: "12.00" }],
    dryRun: false,
  });
  assert.equal(applied.structuredContent.dryRun, false);
  assert.equal(applied.structuredContent.results[0].outcome, "applied");
  assert.equal(applied.structuredContent.results[0].verification, "verified");
  assert.equal(applied.structuredContent.status, "ok");
  assert.equal(applied.structuredContent.succeeded, 1);
  // The readback is a genuinely separate query, not just an inspection of the mutation response.
  assert.ok(sentVariables(state, "VariantsForPricing").length >= 1);
});

test("update_prices: a mutation response that looks fine but the readback disagrees is reported as mismatch", async (t) => {
  const { call, state } = await fixture(t);
  state.mismatchPrice = "99.99";
  const mismatched = await call("update_prices", {
    skus: [{ sku: "SKU-FOUND", price: "12.00" }],
    dryRun: false,
  });
  assert.equal(mismatched.structuredContent.results[0].outcome, "mismatch");
  assert.equal(mismatched.structuredContent.results[0].verification, "mismatch");
  assert.equal(mismatched.structuredContent.status, "failed");
  assert.equal(mismatched.structuredContent.failed, 1);
});

test("update_prices: a network error after the write was sent is reported as unknown, never rejected", async (t) => {
  const { call, state } = await fixture(t);
  state.networkFailOn = "UpdatePricesBulk";
  const result = await call("update_prices", {
    skus: [{ sku: "SKU-FOUND", price: "12.00" }],
    dryRun: false,
  });
  const item = result.structuredContent.results[0];
  assert.equal(item.outcome, "unknown");
  assert.ok(item.doNotBlindlyRetry);
  assert.equal(result.structuredContent.status, "unknown");
});

test("update_prices: a failed verification read is applied_unverified and the store is not ok", async (t) => {
  const { call, callMulti, state } = await fixture(t);
  state.readbackFailsAfterWrite = true;
  const result = await call("update_prices", {
    skus: [{ sku: "SKU-FOUND", price: "12.00" }],
    dryRun: false,
  });
  const item = result.structuredContent.results[0];
  assert.equal(item.outcome, "applied_unverified");
  assert.equal(item.verification, "verification_failed");
  assert.equal(result.structuredContent.status, "unverified");
  assert.equal(result.structuredContent.succeeded, 0);
  assert.equal(result.structuredContent.unverified, 1);
  assert.ok(result.structuredContent.verificationNotice);

  state.requests.length = 0;
  const many = await callMulti("update_prices", {
    stores: ["fixture", "second"],
    skus: [{ sku: "SKU-FOUND", price: "12.00" }],
    dryRun: false,
  });
  for (const store of many.structuredContent.stores) {
    assert.equal(store.status, "unverified");
    assert.equal(store.ok, false, "an unverified write is never ok");
  }
  assert.equal(many.structuredContent.succeeded, 0);
  assert.equal(many.structuredContent.unverified, 2);
  assert.equal(many.structuredContent.failed, 2);

  const { deriveStatus } = await import("../dist/parity-tools.js");
  assert.equal(deriveStatus(["applied", "applied_unverified"]), "unverified");
  assert.equal(deriveStatus(["applied_unverified", "not_found"]), "partial");
  assert.equal(deriveStatus(["applied", "skipped"]), "ok");
});

test("update_prices: a partial failure (userErrors on some variants) yields a partial store status", async (t) => {
  const { call, state } = await fixture(t);
  state.skuPages = {
    "OK-1": [[variantWithSku(50, "OK-1", 5)]],
    "OK-2": [[variantWithSku(51, "OK-2", 5)]],
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const b = JSON.parse(options.body);
    const op = parse(b.query).definitions.find((d) => d.kind === "OperationDefinition");
    if (op.name?.value === "UpdatePricesBulk") {
      // Both variants belong to the same product; Shopify applies one and rejects the
      // other with a userError, all in a single (non-throwing) mutation response.
      const first = b.variables.variants.find((v) => v.id === gid("ProductVariant", 50));
      const applied = first
        ? { id: first.id, sku: "OK-1", price: first.price, compareAtPrice: null, inventoryItem: { id: gid("InventoryItem", 50), unitCost: { amount: "5.00", currencyCode: "USD" } } }
        : undefined;
      if (applied) state.byId.set(applied.id, { ...state.byId.get(applied.id), ...applied });
      return Response.json({
        data: {
          productVariantsBulkUpdate: {
            productVariants: applied ? [applied] : [],
            userErrors: [{ field: ["variants", "1"], message: "Price must be positive" }],
          },
        },
      });
    }
    return original(url, options);
  };
  const result = await call("update_prices", {
    skus: [
      { sku: "OK-1", price: "12.00" },
      { sku: "OK-2", price: "8.00" },
    ],
    dryRun: false,
  });
  const body = result.structuredContent;
  assert.equal(body.results.find((r) => r.sku === "OK-1").outcome, "applied");
  assert.equal(body.results.find((r) => r.sku === "OK-2").outcome, "rejected");
  assert.match(body.results.find((r) => r.sku === "OK-2").error, /Price must be positive/);
  assert.equal(body.status, "partial");
});

test("update_prices: a price-only request does not require write_inventory", async (t) => {
  const { call, state } = await fixture(t);
  state.scopes = ["read_products", "write_products"];
  const result = await call("update_prices", {
    skus: [{ sku: "SKU-FOUND", price: "12.00" }],
    dryRun: false,
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(result.structuredContent.status, "ok");
});

test("update_prices: a unitCost request requires write_inventory", async (t) => {
  const { call, state } = await fixture(t);
  state.scopes = ["read_products", "write_products"];
  const result = await call("update_prices", {
    skus: [{ sku: "SKU-FOUND", unitCost: "6.00" }],
    dryRun: false,
  });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /access scopes/i);
});

test("update_prices: ambiguous SKU matches are reported, not applied", async (t) => {
  const { call } = await fixture(t);
  const result = await call("update_prices", {
    skus: [{ sku: "SKU-AMBIGUOUS", price: "1.00" }],
  });
  assert.deepEqual(result.structuredContent.ambiguousSkus, ["SKU-AMBIGUOUS"]);
  assert.equal(result.structuredContent.wouldApply.length, 0);
});

test("update_prices with stores: applies the same SKU list across stores independently", async (t) => {
  const { callMulti } = await fixture(t);
  const result = await callMulti("update_prices", {
    stores: ["fixture", "second"],
    skus: [{ sku: "SKU-FOUND", price: "12.00" }],
  });
  assert.equal(result.structuredContent.stores.length, 2);
  assert.ok(result.structuredContent.stores.every((s) => s.ok));
  assert.equal(result.structuredContent.succeeded, 2);
});

test("multi-store tools refuse two aliases for one shop and never run an action twice", async (t) => {
  const { callMulti, state } = await fixture(t, {
    extraStores: [{ alias: "fixture-copy", shop: "FIXTURE.myshopify.com", apiVersion: "2026-07" }],
  });
  const result = await callMulti("update_prices", {
    stores: ["fixture", "fixture-copy"],
    skus: [{ sku: "SKU-FOUND", price: "12.00" }],
    dryRun: false,
  });
  assert.equal(result.isError, true, JSON.stringify(result));
  const text = JSON.parse(result.content[0].text).error;
  assert.match(text, /"fixture" and "fixture-copy" both point to/);
  assert.equal(state.requests.length, 0, "nothing was sent to Shopify");

  // With no stores named, each shop is checked once.
  const all = await callMulti("check_access", {});
  assert.deepEqual(all.structuredContent.stores.map((s) => s.store).sort(), ["fixture", "second"]);

  const { resolveStoreTargets } = await import("../dist/config.js");
  await assert.rejects(resolveStoreTargets(["FIXTURE-COPY", "second", "fixture"]), /"fixture-copy" and "fixture" both point to/i);
  assert.deepEqual((await resolveStoreTargets(["fixture", "FIXTURE", "second"])).map((target) => target.store.alias), ["fixture", "second"]);
});

test("update_prices with stores: aggregates mixed outcomes across stores into an ok/status per store", async (t) => {
  const { callMulti } = await fixture(t);
  const result = await callMulti("update_prices", {
    stores: ["fixture", "second"],
    skus: [
      { sku: "SKU-FOUND", price: "12.00" },
      { sku: "SKU-MISSING", price: "9.00" },
    ],
    dryRun: false,
  });
  const body = result.structuredContent;
  assert.equal(body.stores.length, 2);
  for (const store of body.stores) {
    assert.equal(store.status, "partial");
    assert.equal(store.ok, false, "ok must not be true when a SKU was not found");
    assert.equal(store.results.find((r) => r.sku === "SKU-FOUND").outcome, "applied");
    assert.deepEqual(store.notFound, ["SKU-MISSING"]);
  }
  assert.equal(body.succeeded, 0);
  assert.equal(body.failed, 2);
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
  const readOnlyProductTool = report.failingTools.find((f) => f.tool === "shopify_search:products");
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
  const got = await call("get", { resource: "metafields", id: owner });
  assert.equal(got.structuredContent.metafields.length, 1);
  const setPreview = await call("metafields", {
    set: [{ ownerId: owner, namespace: "custom", key: "note", value: "hi" }],
  });
  assert.equal(setPreview.structuredContent.dryRun, true);
  const setApplied = await call("metafields", {
    set: [{ ownerId: owner, namespace: "custom", key: "note", value: "hi" }],
    dryRun: false,
  });
  assert.equal(setApplied.structuredContent.metafields.length, 1);
  const deleted = await call("metafields", {
    delete: [{ ownerId: owner, namespace: "custom", key: "note" }],
    dryRun: false,
  });
  assert.equal(deleted.structuredContent.deletedMetafields.length, 1);
  const neither = await call("metafields", {});
  assert.equal(neither.isError, true);
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

const sentVariables = (state, operation) =>
  state.requests
    .filter((r) => parse(r.query).definitions.find((d) => d.kind === "OperationDefinition").name?.value === operation)
    .map((r) => r.variables);

test("update_order: dryRun:false sends only OrderInput fields", async (t) => {
  const { call, state } = await fixture(t);
  const result = await call("update_order", {
    id: gid("Order", 1),
    replaceTags: ["x"],
    note: null,
    shippingAddress: { city: "Albany" },
    dryRun: false,
  });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(sentVariables(state, "UpdateOrder"), [
    { input: { id: gid("Order", 1), tags: ["x"], note: null, shippingAddress: { city: "Albany" } } },
  ]);
});

test("update_customer: dryRun:false sends only CustomerInput fields", async (t) => {
  const { call, state } = await fixture(t);
  const result = await call("update_customer", { id: gid("Customer", 1), note: "n", dryRun: false });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(sentVariables(state, "UpdateCustomer"), [
    { input: { id: gid("Customer", 1), note: "n" } },
  ]);
});

const variantWithSku = (id, sku, productId = 1) => ({
  id: gid("ProductVariant", id),
  sku,
  price: "10.00",
  compareAtPrice: null,
  product: { id: gid("Product", productId), title: "Fixture product" },
  inventoryItem: { id: gid("InventoryItem", id), sku, unitCost: { amount: "5.00", currencyCode: "USD" } },
});

test("update_prices: SKU lookup fetches 250 per page and keeps only exact, case-sensitive matches", async (t) => {
  const { call, state } = await fixture(t);
  state.skuPages = {
    "AB-1": [[variantWithSku(1, "AB-10"), variantWithSku(2, "ab-1"), variantWithSku(3, " AB-1 "), variantWithSku(4, "AB-1X")]],
  };
  const result = await call("update_prices", { skus: [{ sku: " AB-1", price: "12.00" }] });
  const [lookup] = sentVariables(state, "FindVariantsBySku");
  assert.equal(lookup.query, 'sku:"AB-1"');
  assert.match(state.requests.find((r) => r.query.includes("FindVariantsBySku")).query, /first:250/);
  assert.deepEqual(result.structuredContent.wouldApply.map((p) => p.variantId), [gid("ProductVariant", 3)]);
  assert.deepEqual(result.structuredContent.ambiguousSkus, []);
});

test("update_prices: a full page is paginated so a later exact match is found", async (t) => {
  const { call, state } = await fixture(t);
  state.skuPages = {
    "PG": [
      Array.from({ length: 250 }, (_, i) => variantWithSku(100 + i, `PG-${i}`)),
      [variantWithSku(7, "PG")],
    ],
  };
  const result = await call("update_prices", { skus: [{ sku: "PG", price: "12.00" }] });
  const lookups = sentVariables(state, "FindVariantsBySku");
  assert.equal(lookups.length, 2, JSON.stringify(result.structuredContent).slice(0, 500));
  assert.equal(lookups[1].after, "1");
  assert.deepEqual(result.structuredContent.wouldApply.map((p) => p.variantId), [gid("ProductVariant", 7)]);
});

test("update_prices: duplicate exact SKUs are reported and only updated with allowDuplicates:true", async (t) => {
  const { call, state } = await fixture(t);
  state.skuPages = { DUP: [[variantWithSku(8, "DUP", 1), variantWithSku(9, "DUP", 2)]] };
  const refused = await call("update_prices", { skus: [{ sku: "DUP", price: "12.00" }], dryRun: false });
  assert.deepEqual(refused.structuredContent.ambiguousSkus, ["DUP"]);
  assert.equal(refused.structuredContent.results.length, 0);
  assert.equal(sentVariables(state, "UpdatePricesBulk").length, 0);

  const allowed = await call("update_prices", { skus: [{ sku: "DUP", price: "12.00" }], allowDuplicates: true, dryRun: false });
  assert.deepEqual(allowed.structuredContent.ambiguousSkus, []);
  assert.deepEqual(
    sentVariables(state, "UpdatePricesBulk").map((v) => [v.productId, v.variants.map((x) => x.id)]),
    [[gid("Product", 1), [gid("ProductVariant", 8)]], [gid("Product", 2), [gid("ProductVariant", 9)]]],
  );
});

test("update_prices: readback compares money as decimals, not strings", async (t) => {
  const { call, state } = await fixture(t);
  state.mismatchPrice = "12.00";
  state.readbackCost = "6.0";
  const applied = await call("update_prices", { skus: [{ sku: "SKU-FOUND", price: "12", unitCost: "6.000" }], dryRun: false });
  assert.equal(applied.structuredContent.results[0].outcome, "applied", JSON.stringify(applied.structuredContent));
  state.mismatchPrice = "12.01";
  const mismatched = await call("update_prices", { skus: [{ sku: "SKU-FOUND", price: "12" }], dryRun: false });
  assert.equal(mismatched.structuredContent.results[0].outcome, "mismatch");
});

test("sameMoney: decimal equality without float rounding", () => {
  assert.ok(sameMoney("12", "12.00"));
  assert.ok(sameMoney("0", "0.00"));
  assert.ok(sameMoney("-0.0", "0"));
  assert.ok(sameMoney("007.50", "7.5"));
  assert.ok(sameMoney(null, undefined));
  assert.ok(!sameMoney("10", "1"));
  assert.ok(!sameMoney("0.1", "0.10000000000000001"));
  assert.ok(!sameMoney(null, "0.00"));
  assert.ok(!sameMoney("abc", "abc"));
});

test("create_fulfillment: works with merchant-managed fulfillment order scopes and no write_fulfillments", async (t) => {
  const { call, state } = await fixture(t);
  state.scopes = ["read_merchant_managed_fulfillment_orders", "write_merchant_managed_fulfillment_orders"];
  const applied = await call("create_fulfillment", { orderId: gid("Order", 1), dryRun: false });
  assert.equal(applied.isError, undefined, applied.content[0].text);
  assert.equal(applied.structuredContent.fulfillment.status, "SUCCESS");
});

test("create_fulfillment: includes IN_PROGRESS fulfillment orders and fulfills remaining quantities", async (t) => {
  const { call, state } = await fixture(t);
  state.fulfillmentOrders = [
    { id: gid("FulfillmentOrder", 1), status: "IN_PROGRESS", lineItems: connection([
      { id: gid("FulfillmentOrderLineItem", 1), remainingQuantity: 2 },
      { id: gid("FulfillmentOrderLineItem", 2), remainingQuantity: 0 },
    ]) },
    { id: gid("FulfillmentOrder", 2), status: "OPEN", lineItems: connection([{ id: gid("FulfillmentOrderLineItem", 3), remainingQuantity: 1 }]) },
    { id: gid("FulfillmentOrder", 3), status: "CLOSED", lineItems: connection([{ id: gid("FulfillmentOrderLineItem", 4), remainingQuantity: 0 }]) },
  ];
  const applied = await call("create_fulfillment", { orderId: gid("Order", 1), trackingNumber: "1Z", dryRun: false });
  assert.equal(applied.isError, undefined, applied.content[0].text);
  assert.deepEqual(sentVariables(state, "CreateFulfillment"), [{
    fulfillment: {
      notifyCustomer: false,
      lineItemsByFulfillmentOrder: [
        { fulfillmentOrderId: gid("FulfillmentOrder", 1), fulfillmentOrderLineItems: [{ id: gid("FulfillmentOrderLineItem", 1), quantity: 2 }] },
        { fulfillmentOrderId: gid("FulfillmentOrder", 2), fulfillmentOrderLineItems: [{ id: gid("FulfillmentOrderLineItem", 3), quantity: 1 }] },
      ],
      trackingInfo: { number: "1Z" },
    },
  }]);
});

function addBulkVariants(state, count) {
  const skus = [];
  for (let i = 1; i <= count; i++) {
    const sku = `BULK-${i}`;
    state.variants[sku] = {
      id: gid("ProductVariant", 1000 + i),
      sku,
      price: "10.00",
      compareAtPrice: null,
      product: { id: gid("Product", 1000 + i), title: `Bulk product ${i} ${"x".repeat(400)}` },
      inventoryItem: { id: gid("InventoryItem", 1000 + i), sku, unitCost: { amount: "5.00", currencyCode: "USD" } },
    };
    skus.push({ sku, price: "12.00" });
  }
  return skus;
}

test("update_prices with 250 SKUs applies, verifies, and reports success instead of a size error", async (t) => {
  const { call, state } = await fixture(t);
  const skus = addBulkVariants(state, 249);
  skus.push({ sku: "SKU-MISSING", price: "1.00" });
  const result = await call("update_prices", { skus, dryRun: false });
  assert.notEqual(result.isError, true, result.content[0].text.slice(0, 300));
  const body = result.structuredContent;
  assert.ok(result.content[0].text.length <= 150_000, `result is ${result.content[0].text.length} characters`);
  assert.equal(body.dryRun, false);
  assert.equal(body.status, "partial");
  assert.equal(body.succeeded, 249);
  assert.equal(body.failed, 0);
  assert.deepEqual(body.notFound, ["SKU-MISSING"]);
  assert.ok(body.responseTrimmed, "the trim is reported");
  // Every applied item is still accounted for, either in results or as a summary line.
  const summarized = body.resultsAppliedSummary?.length ?? 0;
  assert.equal(body.results.length + summarized + (body.responseTrimmed.appliedSummaryLinesOmitted ?? 0), 249);
  const writes = state.requests.filter((r) => /UpdatePricesBulk/.test(r.query));
  assert.equal(writes.length, 249);
});

test("update_prices with stores and 250 SKUs on two stores keeps every store's status and counts", async (t) => {
  const { callMulti, state } = await fixture(t);
  const skus = addBulkVariants(state, 250);
  const result = await callMulti("update_prices", { stores: ["fixture", "second"], skus, dryRun: false });
  assert.notEqual(result.isError, true, result.content[0].text.slice(0, 300));
  assert.ok(result.content[0].text.length <= 150_000);
  const body = result.structuredContent;
  assert.equal(body.succeeded, 2);
  for (const store of body.stores) {
    assert.equal(store.status, "ok");
    assert.equal(store.succeeded, 250);
  }
});

test("fitWriteResult trims applied items but keeps status, counts and every non-applied item in full", async () => {
  const { fitWriteResult } = await import("../dist/result-limits.js");
  const big = "y".repeat(2_000);
  const results = [];
  for (let i = 0; i < 200; i++) {
    results.push({ sku: `S-${i}`, variantId: gid("ProductVariant", i), requested: { price: "2.00" }, outcome: "applied", verification: "verified", mutationResponse: { id: gid("ProductVariant", i), price: "2.00", blob: big }, verifiedState: { id: gid("ProductVariant", i), price: "2.00", product: { title: big } } });
  }
  results.push({ sku: "S-BAD", variantId: gid("ProductVariant", 999), requested: { price: "2.00" }, outcome: "mismatch", verification: "mismatch", mutationResponse: { id: "x", price: "2.00", blob: big }, verifiedState: { id: "x", price: "1.00", blob: big } });
  results.push({ sku: "S-UNKNOWN", variantId: gid("ProductVariant", 998), outcome: "unknown", error: "network reset" });
  const value = { dryRun: false, status: "partial", succeeded: 200, failed: 2, results };
  const fitted = fitWriteResult(value, 20_000);
  assert.ok(JSON.stringify(fitted).length <= 20_000);
  assert.equal(fitted.status, "partial");
  assert.equal(fitted.succeeded, 200);
  assert.equal(fitted.failed, 2);
  const bad = fitted.results.find((r) => r.sku === "S-BAD");
  assert.equal(bad.outcome, "mismatch");
  assert.deepEqual(bad.verifiedState, { id: "x", price: "1.00" }, "trimmed to the changed field");
  assert.ok(fitted.results.some((r) => r.sku === "S-UNKNOWN" && r.error === "network reset"));
  assert.ok(fitted.responseTrimmed.notice);
  // Small results pass through unchanged.
  const small = { status: "ok", results: [{ sku: "A", outcome: "applied" }] };
  assert.equal(fitWriteResult(small), small);
});

test("redirects create and delete carry applied, rejected and unknown per item and derive status", async (t) => {
  const { call } = await fixture(t);
  const mocked = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const path = body.variables?.urlRedirect?.path;
    const id = body.variables?.id;
    if (path === "/net" || id === gid("UrlRedirect", 99)) throw new Error("simulated network reset");
    if (path === "/rej") return Response.json({ data: { urlRedirectCreate: { urlRedirect: null, userErrors: [{ field: ["path"], message: "Path already taken" }] } } });
    return mocked(url, options);
  };
  const created = await call("redirects", {
    create: [{ path: "/ok", target: "/new" }, { path: "/rej", target: "/new" }, { path: "/net", target: "/new" }],
    dryRun: false,
  });
  const body = created.structuredContent;
  assert.deepEqual(body.results.map((r) => r.outcome), ["applied", "rejected", "unknown"]);
  assert.deepEqual(body.results.map((r) => r.ok), [true, false, false]);
  assert.equal(body.status, "partial");
  assert.equal(body.succeeded, 1);
  assert.equal(body.failed, 1);
  assert.equal(body.unknown, 1);
  assert.ok(body.results[2].doNotBlindlyRetry);

  const onlyUnknown = await call("redirects", { delete: [gid("UrlRedirect", 99)], dryRun: false });
  assert.equal(onlyUnknown.structuredContent.status, "unknown", "an unknown outcome is not flattened into failed");
  const deleted = await call("redirects", { delete: [gid("UrlRedirect", 1)], dryRun: false });
  assert.equal(deleted.structuredContent.status, "ok");
  assert.equal(deleted.structuredContent.results[0].outcome, "applied");
});

test("update_order and update_customer add and remove tags without replacing the list", async (t) => {
  const { call, state } = await fixture(t);
  const preview = await call("update_order", { id: gid("Order", 1), addTags: ["vip"] });
  assert.equal(preview.structuredContent.dryRun, true);
  assert.deepEqual(preview.structuredContent.before.tags, ["old"]);
  assert.deepEqual(preview.structuredContent.wouldApply.addTags, ["vip"]);
  const order = await call("update_order", { id: gid("Order", 1), addTags: ["vip"], removeTags: ["old"], dryRun: false });
  assert.equal(order.isError, undefined, order.content[0].text);
  assert.equal(sentVariables(state, "UpdateOrder").length, 0, "orderUpdate (a full tag replace) is not sent for tag-only changes");
  assert.deepEqual(sentVariables(state, "AddTags"), [{ id: gid("Order", 1), tags: ["vip"] }]);
  assert.deepEqual(sentVariables(state, "RemoveTags"), [{ id: gid("Order", 1), tags: ["old"] }]);
  const replace = await call("update_order", { id: gid("Order", 1), replaceTags: ["a"] });
  assert.deepEqual(replace.structuredContent.wouldApply.tagsRemoved, ["old"]);
  const customer = await call("update_customer", { id: gid("Customer", 1), note: "n", addTags: ["vip"], dryRun: false });
  assert.equal(customer.isError, undefined, customer.content[0].text);
  assert.deepEqual(sentVariables(state, "UpdateCustomer"), [{ input: { id: gid("Customer", 1), note: "n" } }]);
  assert.deepEqual(sentVariables(state, "AddTags").at(-1), { id: gid("Customer", 1), tags: ["vip"] });
  const both = await call("update_customer", { id: gid("Customer", 1), replaceTags: ["a"], removeTags: ["b"] });
  assert.equal(both.isError, true);
});

test("every parity document validates against the pinned API version", async () => {
  const { PDOCS } = await import("../dist/parity-documents.js");
  const { PARITY_API_VERSION } = await import("../dist/api-versions.js");
  const { validateDocument } = await import("../dist/schema.js");
  for (const [name, document] of Object.entries(PDOCS)) {
    assert.deepEqual(await validateDocument(document, PARITY_API_VERSION), [], name);
  }
});

test("guided tools run on the default API version (the one a Worker bundles); only legacy ruleSet writes do not", async () => {
  const { DOCS } = await import("../dist/admin-documents.js");
  const { PARITY_API_VERSION, COLLECTION_API_VERSION, LEGACY_COLLECTION_API_VERSION } = await import("../dist/api-versions.js");
  const { DEFAULT_API_VERSION } = await import("../dist/constants.js");
  const { validateDocument } = await import("../dist/schema.js");
  assert.equal(PARITY_API_VERSION, DEFAULT_API_VERSION);
  assert.equal(COLLECTION_API_VERSION, DEFAULT_API_VERSION);
  const legacy = new Set(["collectionCreateLegacy", "collectionUpdateLegacy"]);
  for (const [name, document] of Object.entries(DOCS)) {
    if (typeof document !== "string") continue;
    if (legacy.has(name)) {
      assert.deepEqual(await validateDocument(document, LEGACY_COLLECTION_API_VERSION), [], name);
      continue;
    }
    assert.deepEqual(await validateDocument(document, DEFAULT_API_VERSION), [], name);
  }
});
