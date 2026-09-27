import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, validate } from "graphql";
import { CATEGORIES, actionCatalog, buildDocument, classifyMutation, isDestructive, mutationFields } from "../dist/actions/catalog.js";
import { registerActionTools } from "../dist/actions/tools.js";
import { adminSchema } from "../dist/schema.js";

const BUNDLED = ["2026-04", "2026-07"];

function header(init, name) {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

/**
 * Two stores on 2026-04 and a mocked Shopify. `respond` gets each GraphQL request and returns the
 * JSON body; by default nodes() echoes each id as a Product and mutations succeed.
 */
async function fixture(t, respond) {
  const directory = await mkdtemp(join(tmpdir(), "shopify-actions-"));
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.SHOPIFY_MULTI_STORE_CONFIG = join(directory, "stores.json");
  delete process.env.STORES_JSON;
  process.env.SHOPIFY_TOKEN_MAIN = "main-token";
  process.env.SHOPIFY_TOKEN_WHOLESALE = "wholesale-token";
  await writeFile(process.env.SHOPIFY_MULTI_STORE_CONFIG, JSON.stringify({ stores: [
    { alias: "main", shop: "main.myshopify.com", apiVersion: "2026-04" },
    { alias: "wholesale", shop: "wholesale.myshopify.com", apiVersion: "2026-04" }
  ] }));
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const request = { url: String(url), token: header(init, "X-Shopify-Access-Token"), query: body.query, variables: body.variables ?? {} };
    requests.push(request);
    const payload = (respond && await respond(request)) ?? defaultResponse(request);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(directory, { recursive: true, force: true });
  });
  const tools = new Map();
  registerActionTools({ registerTool: (name, definition, callback) => tools.set(name, { definition, callback }) });
  const callTool = (name, args) => {
    const tool = tools.get(name);
    return tool.callback(tool.definition.inputSchema.parse(args));
  };
  return { requests, callTool, tools };
}

function defaultResponse(request) {
  if (/nodes\(ids:/.test(request.query)) {
    return { data: { nodes: request.variables.ids.map((id) => ({ __typename: id.split("/")[3], id, title: `Title of ${id}` })) } };
  }
  if (/productVariantsBulkUpdate/.test(request.query)) {
    return { data: { productVariantsBulkUpdate: { product: { id: request.variables.productId }, productVariants: [], userErrors: [] } } };
  }
  if (/orderCancel/.test(request.query)) {
    return { data: { orderCancel: { job: { id: "gid://shopify/Job/1" }, orderCancelUserErrors: [], userErrors: [] } } };
  }
  if (/giftCardCreate/.test(request.query)) {
    return { data: { giftCardCreate: { giftCard: { id: "gid://shopify/GiftCard/9" }, giftCardCode: "ABCD", userErrors: [] } } };
  }
  return { data: {} };
}

const mutationRequests = (requests) => requests.filter((request) => /^\s*mutation\b/.test(request.query));

test("every mutation in both bundled schemas gets a category and a valid default document", async () => {
  for (const version of BUNDLED) {
    const schema = await adminSchema(version);
    const fields = mutationFields(schema);
    assert.ok(fields.length >= 514, `${version} has ${fields.length} mutations`);
    const unclassified = fields.filter((field) => classifyMutation(field.name) === undefined).map((field) => field.name);
    assert.deepEqual(unclassified, [], `${version} unclassified`);
    for (const field of fields) assert.ok(CATEGORIES.includes(classifyMutation(field.name)));
    const invalid = fields.filter((field) => validate(schema, parse(buildDocument(field))).length).map((field) => field.name);
    assert.deepEqual(invalid, [], `${version} default documents`);
  }
  const catalog = await actionCatalog("2026-04");
  assert.equal(catalog.length, 514);
  for (const category of CATEGORIES) assert.ok(catalog.some((entry) => entry.category === category), category);
  assert.ok(isDestructive("orderCancel") && isDestructive("productDelete") && isDestructive("refundCreate") && !isDestructive("productCreate"));
});

test("shopify_find_actions ranks by keyword, filters by category, pages, and flags dedicated tools", async (t) => {
  const { callTool } = await fixture(t);
  const cancel = (await callTool("shopify_find_actions", { query: "cancel order", apiVersion: "2026-04" })).structuredContent;
  assert.equal(cancel.actions[0].name, "orderCancel");
  assert.equal(cancel.actions[0].destructive, true);
  assert.equal(cancel.actions[0].category, "orders");
  const gift = (await callTool("shopify_find_actions", { query: "gift card", apiVersion: "2026-04" })).structuredContent;
  assert.ok(gift.actions.some((action) => action.name === "giftCardCreate"));
  const bulk = (await callTool("shopify_find_actions", { query: "productVariantsBulkUpdate", apiVersion: "2026-04" })).structuredContent;
  assert.equal(bulk.actions[0].name, "productVariantsBulkUpdate");
  assert.ok(bulk.actions[0].dedicatedTools.includes("shopify_update_prices"));
  const pos = (await callTool("shopify_find_actions", { category: "pos", apiVersion: "2026-04", limit: 3 })).structuredContent;
  assert.equal(pos.actions.length, 3);
  assert.ok(pos.actions.every((action) => action.category === "pos"));
  assert.equal(pos.nextOffset, 3);
  const page2 = (await callTool("shopify_find_actions", { category: "pos", apiVersion: "2026-04", limit: 3, offset: 3 })).structuredContent;
  assert.notEqual(page2.actions[0].name, pos.actions[0].name);
  const app = (await callTool("shopify_find_actions", { query: "uninstall", apiVersion: "2026-04" })).structuredContent;
  assert.equal(app.actions.find((action) => action.name === "appUninstall")?.denied, true);
  const byStore = (await callTool("shopify_find_actions", { query: "gift card", store: "main" })).structuredContent;
  assert.equal(byStore.apiVersion, "2026-04");
});

test("shopify_describe_action expands productVariantsBulkUpdate", async (t) => {
  const { callTool } = await fixture(t);
  const result = await callTool("shopify_describe_action", { mutation: "productVariantsBulkUpdate", apiVersion: "2026-04" });
  assert.notEqual(result.isError, true, result.content[0].text);
  const described = result.structuredContent;
  assert.equal(described.category, "products");
  assert.equal(described.destructive, false);
  assert.ok(described.dedicatedTools.includes("shopify_update_prices_many"));
  assert.deepEqual(described.scopeHint, ["write_products"]);
  const variants = described.arguments.find((arg) => arg.name === "variants");
  assert.equal(variants.type, "[ProductVariantsBulkInput!]!");
  assert.equal(variants.required, true);
  const price = variants.fields.find((field) => field.name === "price");
  assert.equal(price.type, "Money");
  assert.equal(price.required, false);
  const inventoryItem = variants.fields.find((field) => field.name === "inventoryItem");
  assert.ok(inventoryItem.fields.some((field) => field.name === "cost"), "nested input expanded");
  const policy = variants.fields.find((field) => field.name === "inventoryPolicy");
  assert.ok(policy.enumValues.includes("DENY") && policy.enumValues.includes("CONTINUE"));
  assert.equal(described.arguments.find((arg) => arg.name === "productId").required, true);
  assert.ok(described.returns.fields.some((field) => field.name === "productVariants"));
  assert.match(described.document, /^mutation ProductVariantsBulkUpdate\(/);
  assert.match(described.document, /userErrors \{ field message code \}/);
  assert.equal(validate(await adminSchema("2026-04"), parse(described.document)).length, 0);
  assert.equal(described.variablesTemplate.productId, "gid://shopify/Product/<id>");
  assert.ok(Array.isArray(described.variablesTemplate.variants));
});

test("shopify_describe_action marks orderCancel destructive and selects its own error list", async (t) => {
  const { callTool } = await fixture(t);
  const described = (await callTool("shopify_describe_action", { mutation: "orderCancel", apiVersion: "2026-04" })).structuredContent;
  assert.equal(described.destructive, true);
  assert.equal(described.confirmRequired, "orderCancel");
  assert.deepEqual(described.scopeHint, ["write_orders"]);
  const reason = described.arguments.find((arg) => arg.name === "reason");
  assert.equal(reason.required, true);
  assert.ok(reason.enumValues.includes("CUSTOMER") && reason.enumValues.includes("FRAUD"));
  assert.equal(described.arguments.find((arg) => arg.name === "restock").required, true);
  assert.equal(described.arguments.find((arg) => arg.name === "notifyCustomer").required, false);
  assert.match(described.document, /orderCancelUserErrors \{ field message code \}/);
  assert.deepEqual(described.variablesTemplate, { orderId: "gid://shopify/Order/<id>", restock: false, reason: "CUSTOMER" });
  const unknown = await callTool("shopify_describe_action", { mutation: "orderExplode", apiVersion: "2026-04" });
  assert.equal(unknown.isError, true);
});

test("dry run validates, resolves every GID through nodes(), and never sends the mutation", async (t) => {
  const { callTool, requests } = await fixture(t);
  const result = await callTool("shopify_run_action", {
    stores: ["main"],
    mutation: "productVariantsBulkUpdate",
    variables: { productId: "gid://shopify/Product/1", variants: [{ id: "gid://shopify/ProductVariant/11", price: "19.99" }, { id: "gid://shopify/ProductVariant/12", price: "24.99" }] }
  });
  assert.notEqual(result.isError, true, result.content[0].text);
  const preview = result.structuredContent;
  assert.equal(preview.dryRun, true);
  assert.equal(preview.destructive, false);
  assert.equal(mutationRequests(requests).length, 0, "no mutation reached Shopify");
  assert.equal(requests.length, 1);
  assert.match(requests[0].query, /nodes\(ids: \$ids\)/);
  assert.match(requests[0].query, /\.\.\. on ProductVariant \{ title displayName sku \}/);
  assert.deepEqual(requests[0].variables.ids.sort(), ["gid://shopify/Product/1", "gid://shopify/ProductVariant/11", "gid://shopify/ProductVariant/12"]);
  const store = preview.results[0];
  assert.equal(store.ok, true);
  assert.equal(store.touchedRecords.length, 3);
  assert.ok(store.touchedRecords.some((record) => record.title === "Title of gid://shopify/ProductVariant/12"));
  assert.match(store.document, /^mutation ProductVariantsBulkUpdate/);
  assert.equal(store.variables.productId, "gid://shopify/Product/1");
  assert.match(preview.nextStep, /dryRun: false/);

  // Variable errors are reported per store, still with no mutation.
  const bad = await callTool("shopify_run_action", { stores: ["main"], mutation: "orderCancel", variables: { orderId: "gid://shopify/Order/1", restock: "yes", reason: "BORED" } });
  assert.equal(bad.isError, true);
  assert.ok(bad.structuredContent.results[0].errors.some((error) => /reason|BORED/.test(error)));
  assert.equal(mutationRequests(requests).length, 0);
});

test("destructive actions are refused without the exact confirm, then applied once", async (t) => {
  const { callTool, requests } = await fixture(t);
  const args = { stores: ["main"], mutation: "orderCancel", dryRun: false, variables: { orderId: "gid://shopify/Order/5", restock: true, reason: "CUSTOMER" } };
  const missing = await callTool("shopify_run_action", args);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /confirm: "orderCancel"/);
  const wrong = await callTool("shopify_run_action", { ...args, confirm: "yes" });
  assert.equal(wrong.isError, true);
  assert.equal(requests.length, 0);

  const applied = await callTool("shopify_run_action", { ...args, confirm: "orderCancel" });
  assert.notEqual(applied.isError, true, applied.content[0].text);
  assert.equal(mutationRequests(requests).length, 1);
  assert.equal(applied.structuredContent.results[0].outcome, "applied");
  assert.equal(requests[0].token, "main-token");
});

test("variablesByStore routes each store's own IDs, applying across two stores", async (t) => {
  const { callTool, requests } = await fixture(t);
  const args = {
    stores: ["main", "wholesale"],
    mutation: "productVariantsBulkUpdate",
    dryRun: false,
    variablesByStore: {
      main: { productId: "gid://shopify/Product/100", variants: [{ id: "gid://shopify/ProductVariant/101", price: "10.00" }] },
      WHOLESALE: { productId: "gid://shopify/Product/200", variants: [{ id: "gid://shopify/ProductVariant/201", price: "8.00" }] }
    }
  };
  const result = await callTool("shopify_run_action", args);
  assert.notEqual(result.isError, true, result.content[0].text);
  const sent = mutationRequests(requests);
  assert.equal(sent.length, 2);
  const main = sent.find((request) => request.token === "main-token");
  const wholesale = sent.find((request) => request.token === "wholesale-token");
  assert.equal(main.variables.productId, "gid://shopify/Product/100");
  assert.equal(wholesale.variables.productId, "gid://shopify/Product/200");
  assert.equal(wholesale.variables.variants[0].price, "8.00");
  assert.equal(result.structuredContent.succeeded, 2);

  const stray = await callTool("shopify_run_action", { ...args, variablesByStore: { ...args.variablesByStore, other: {} } });
  assert.equal(stray.isError, true);
  assert.match(stray.content[0].text, /not in stores: other/);

  // One store failing preflight stops every store.
  const before = mutationRequests(requests).length;
  const partial = await callTool("shopify_run_action", { ...args, variablesByStore: { main: args.variablesByStore.main, wholesale: { productId: "gid://shopify/Product/200" } } });
  assert.equal(partial.isError, true);
  assert.match(partial.content[0].text, /Nothing was changed/);
  assert.equal(mutationRequests(requests).length, before);
});

test("denylisted mutations are refused, including behind a fragment, and ACTIONS_DENYLIST replaces the list", async (t) => {
  const { callTool, requests } = await fixture(t);
  for (const mutation of ["appUninstall", "delegateAccessTokenCreate", "appSubscriptionCreate", "storefrontAccessTokenCreate"]) {
    const refused = await callTool("shopify_run_action", { stores: ["main"], mutation });
    assert.equal(refused.isError, true, mutation);
    assert.match(refused.content[0].text, /denylist/);
  }
  const hidden = "mutation M($input: DelegateAccessTokenInput!) { ...F } fragment F on Mutation { delegateAccessTokenCreate(input: $input) { shop { id } } }";
  const refused = await callTool("shopify_run_action", { stores: ["main"], document: hidden, dryRun: false });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /delegateAccessTokenCreate .*denylist/);
  assert.equal(requests.length, 0);

  process.env.ACTIONS_DENYLIST = "giftCard*";
  const custom = await callTool("shopify_run_action", { stores: ["main"], mutation: "giftCardCreate" });
  assert.equal(custom.isError, true);
  assert.match(custom.content[0].text, /denylist/);
  // ACTIONS_DENYLIST adds to the defaults; the defaults still apply.
  assert.match((await callTool("shopify_run_action", { stores: ["main"], mutation: "appUninstall" })).content[0].text, /denylist/);
  // Only ACTIONS_DENYLIST_REPLACE=1 replaces them.
  process.env.ACTIONS_DENYLIST_REPLACE = "1";
  const replaced = await callTool("shopify_run_action", { stores: ["main"], mutation: "tagsAdd", variables: { id: "gid://shopify/Product/1", tags: ["x"] } });
  assert.notEqual(replaced.isError, true, replaced.content[0].text);
  assert.doesNotMatch((await callTool("shopify_run_action", { stores: ["main"], mutation: "appUninstall" })).content[0].text, /denylist/);
  delete process.env.ACTIONS_DENYLIST_REPLACE;
  delete process.env.ACTIONS_DENYLIST;

  const query = await callTool("shopify_run_action", { stores: ["main"], document: "query { shop { name } }" });
  assert.equal(query.isError, true);
  assert.match(query.content[0].text, /mutations only/);
  const two = await callTool("shopify_run_action", { stores: ["main"], document: "mutation A { a: tagsAdd(id: \"x\", tags: []) { node { id } } } mutation B { tagsRemove(id: \"x\", tags: []) { node { id } } }" });
  assert.equal(two.isError, true);
  assert.match(two.content[0].text, /exactly one GraphQL operation/);
});

test("ACCESS_DENIED becomes a sentence naming the missing scope and the store", async (t) => {
  const { callTool } = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { errors: [{ message: "Access denied for giftCardCreate field. Required access: `write_gift_cards` access scope.", extensions: { code: "ACCESS_DENIED" } }], data: { giftCardCreate: null } }
    : undefined);
  const result = await callTool("shopify_run_action", { stores: ["main"], mutation: "giftCardCreate", dryRun: false, variables: { input: { initialValue: "25.00" } } });
  assert.equal(result.isError, true);
  const outcome = result.structuredContent.results[0];
  assert.equal(outcome.ok, false);
  assert.equal(outcome.outcome, "failed");
  assert.equal(outcome.error, "Your Shopify account or the app lacks write_gift_cards on main. Add the scope to the app and reinstall or re-authorize it.");
});

test("userErrors from any *UserErrors list mark the store as rejected", async (t) => {
  const { callTool } = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { data: { orderCancel: { job: null, orderCancelUserErrors: [{ field: ["orderId"], message: "Order is already cancelled", code: "INVALID" }], userErrors: [] } } }
    : undefined);
  const result = await callTool("shopify_run_action", { stores: ["main"], mutation: "orderCancel", dryRun: false, confirm: "orderCancel", variables: { orderId: "gid://shopify/Order/5", restock: false, reason: "OTHER" } });
  assert.equal(result.isError, true);
  const outcome = result.structuredContent.results[0];
  assert.equal(outcome.outcome, "rejected");
  assert.equal(outcome.userErrors[0].error.message, "Order is already cancelled");
});

test("docs/ACTIONS.md covers per-user setup, the three tools with worked examples, and honest limits", async () => {
  const { readFile } = await import("node:fs/promises");
  const doc = await readFile(new URL("../docs/ACTIONS.md", import.meta.url), "utf8");
  for (const heading of ["## Per-user access", "### Denylist", "### 1. Change a price in two stores", "### 2. Cancel an order", "### 3. Create a gift card", "## What no third-party app can do", "## Shopify Admin setup"]) {
    assert.ok(doc.includes(heading), heading);
  }
  for (const text of ["variablesByStore", "\"confirm\": \"orderCancel\"", "giftCardCreate", "https://<host>/shopify/callback", "print-scopes.mjs --full", "ACTIONS_DENYLIST"]) assert.ok(doc.includes(text), text);
  assert.ok(!doc.includes("—"), "no em dashes");
});

test("webhook, server pixel, and bulk mutation subscriptions are denied by default", async (t) => {
  const { callTool, requests } = await fixture(t);
  for (const mutation of ["webhookSubscriptionCreate", "webhookSubscriptionUpdate", "webhookSubscriptionDelete", "pubSubWebhookSubscriptionCreate", "pubSubWebhookSubscriptionUpdate", "eventBridgeWebhookSubscriptionCreate", "eventBridgeWebhookSubscriptionUpdate", "eventBridgeServerPixelUpdate", "pubSubServerPixelUpdate", "bulkOperationRunMutation"]) {
    const refused = await callTool("shopify_run_action", { stores: ["main"], mutation });
    assert.equal(refused.isError, true, mutation);
    assert.match(refused.content[0].text, /denylist/, mutation);
  }
  assert.equal(requests.length, 0);
});

test("non-obvious destructive mutations need confirm", async (t) => {
  const { callTool, requests } = await fixture(t);
  for (const name of ["productSet", "themePublish", "customerSet", "inventorySetQuantities", "orderCapture", "draftOrderComplete"]) assert.ok(isDestructive(name), name);
  const refused = await callTool("shopify_run_action", { stores: ["main"], mutation: "themePublish", dryRun: false, variables: { id: "gid://shopify/OnlineStoreTheme/1" } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /confirm: "themePublish"/);
  assert.equal(requests.length, 0);
});
