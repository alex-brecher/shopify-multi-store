import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, validate } from "graphql";
import { CATEGORIES, actionCatalog, buildDocument, classifyMutation, isDestructive, mutationFields } from "../dist/actions/catalog.js";
import { registerActionTools, sendMutationWithOutcome } from "../dist/actions/tools.js";
import { findStore } from "../dist/config.js";
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
 * JSON body; by default nodes() resolves each id (except ones ending in /404) and mutations succeed.
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
    // IDs ending in /404 do not exist, so nodes() returns null for them, as Shopify does.
    return { data: { nodes: request.variables.ids.map((id) => id.endsWith("/404") ? null : { __typename: id.split("/")[3], id, title: `Title of ${id}` }) } };
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
  assert.equal(outcome.outcome, "rejected");
  assert.equal(outcome.roots[0].reason, "access denied");
  assert.equal(outcome.error, "Your Shopify account or the app lacks write_gift_cards on main. Add the scope to the app and reinstall or re-authorize it.");
});

test("userErrors from any *UserErrors list mark the store as rejected", async (t) => {
  const { callTool } = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { data: { orderCancel: { job: null, orderCancelUserErrors: [{ field: ["orderId"], message: "Order is already cancelled", code: "INVALID" }], userErrors: [], smsUserErrors_orderCancelUserErrors: [{ field: ["orderId"], message: "Order is already cancelled", code: "INVALID" }], smsUserErrors_userErrors: [] } } }
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
  assert.ok(!doc.includes("\u2014"), "no em dashes");
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

test("a throttled mutation is not resent and is reported as not applied, safe to retry", async (t) => {
  let mutationCalls = 0;
  const { callTool, requests } = await fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/^\s*mutation/.test(JSON.parse(init.body).query)) {
      mutationCalls += 1;
      return new Response(JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }), { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } });
    }
    return originalFetch(url, init);
  };
  const result = await callTool("shopify_run_action", { stores: ["main"], mutation: "tagsAdd", dryRun: false, variables: { id: "gid://shopify/Product/1", tags: ["x"] } });
  assert.equal(result.isError, true);
  assert.equal(mutationCalls, 1, "never resent");
  const outcome = result.structuredContent.results[0];
  assert.equal(outcome.outcome, "throttled");
  assert.match(outcome.error, /not applied.*safe to retry after about 2 seconds/);
  assert.equal(outcome.retryAfterMs, 2000);
  // Only the apply-time ID lookup reached the fixture; the mutation never did.
  assert.equal(mutationRequests(requests).length, 0);

  // The same holds for a GraphQL THROTTLED error with no data (HTTP 200).
  mutationCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (/^\s*mutation/.test(JSON.parse(init.body).query)) {
      mutationCalls += 1;
      return new Response(JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { requestedQueryCost: 10, throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(url, init);
  };
  const again = await callTool("shopify_run_action", { stores: ["main"], mutation: "tagsAdd", dryRun: false, variables: { id: "gid://shopify/Product/1", tags: ["x"] } });
  assert.equal(again.structuredContent.results[0].outcome, "throttled");
  assert.equal(mutationCalls, 1);
});

// ---------- Per-root outcomes ----------

const TAGS = (key, id) => `${key}: tagsAdd(id: "${id}", tags: ["x"]) { node { id } }`;
const tagsPayload = (id, userErrors = []) => ({ node: userErrors.length ? null : { id }, smsUserErrors_userErrors: userErrors });
const run = (callTool, document) => callTool("shopify_run_action", { stores: ["main"], document, dryRun: false });

test("an aliased userErrors selection is still detected, through the injected reserved alias", async (t) => {
  const { callTool, requests } = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { data: { t: { node: null, e: [{ message: "Tag is too long" }], smsUserErrors_userErrors: [{ field: ["tags"], message: "Tag is too long" }] } } }
    : undefined);
  const result = await run(callTool, "mutation { t: tagsAdd(id: \"gid://shopify/Product/1\", tags: [\"x\"]) { node { id } e: userErrors { message } } }");
  assert.equal(result.isError, true);
  const sent = mutationRequests(requests)[0].query;
  assert.match(sent, /smsUserErrors_userErrors: userErrors \{\s*field\s+message\s*\}/);
  const outcome = result.structuredContent.results[0];
  assert.equal(outcome.outcome, "rejected");
  assert.deepEqual(outcome.userErrors, [{ path: ["t", "userErrors"], error: { field: ["tags"], message: "Tag is too long" } }]);
  assert.equal(outcome.result.data.t.smsUserErrors_userErrors, undefined, "injected keys are removed from the data");
  assert.deepEqual(outcome.result.data.t.e, [{ message: "Tag is too long" }]);
});

test("userErrors are injected when the document does not select them, and the reserved alias is refused", async (t) => {
  const { callTool, requests } = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { data: { tagsAdd: tagsPayload("gid://shopify/Product/1", [{ field: ["id"], message: "Product does not exist" }]) } }
    : undefined);
  const result = await run(callTool, "mutation { tagsAdd(id: \"gid://shopify/Product/1\", tags: [\"x\"]) { node { id } } }");
  assert.match(mutationRequests(requests)[0].query, /smsUserErrors_userErrors: userErrors/);
  assert.equal(result.structuredContent.results[0].outcome, "rejected");
  assert.equal(result.structuredContent.results[0].roots[0].userErrors[0].message, "Product does not exist");

  const before = requests.length;
  const reserved = await run(callTool, "mutation { tagsAdd(id: \"gid://shopify/Product/1\", tags: [\"x\"]) { smsUserErrors_x: userErrors { message } } }");
  assert.equal(reserved.isError, true);
  assert.match(reserved.content[0].text, /reserved/);
  assert.equal(requests.length, before, "nothing sent");
});

test("two roots that both succeed are applied", async (t) => {
  const { callTool } = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { data: { a: tagsPayload("gid://shopify/Product/1"), b: tagsPayload("gid://shopify/Product/2") } }
    : undefined);
  const result = await run(callTool, `mutation { ${TAGS("a", "gid://shopify/Product/1")} ${TAGS("b", "gid://shopify/Product/2")} }`);
  assert.notEqual(result.isError, true, result.content[0].text);
  const outcome = result.structuredContent.results[0];
  assert.equal(outcome.outcome, "applied");
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.roots.map((root) => [root.key, root.outcome]), [["a", "applied"], ["b", "applied"]]);
  assert.equal(outcome.advice, undefined);
});

test("two roots that are both rejected are rejected, and nothing applied", async (t) => {
  const bad = [{ field: ["id"], message: "Not found" }];
  const { callTool } = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { data: { a: tagsPayload("x", bad), b: tagsPayload("y", bad) } }
    : undefined);
  const result = await run(callTool, `mutation { ${TAGS("a", "gid://shopify/Product/1")} ${TAGS("b", "gid://shopify/Product/2")} }`);
  const outcome = result.structuredContent.results[0];
  assert.equal(outcome.outcome, "rejected");
  assert.equal(outcome.userErrors.length, 2);
  assert.match(outcome.advice, /nothing was applied/);
});

test("one root applied and one rejected is partial, with no blanket retry advice", async (t) => {
  const { callTool } = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { data: { a: tagsPayload("gid://shopify/Product/1"), b: tagsPayload("y", [{ field: ["tags"], message: "Too many tags" }]) } }
    : undefined);
  const result = await run(callTool, `mutation { ${TAGS("a", "gid://shopify/Product/1")} ${TAGS("b", "gid://shopify/Product/2")} }`);
  assert.equal(result.isError, true);
  const outcome = result.structuredContent.results[0];
  assert.equal(outcome.outcome, "partial");
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.applied, ["a"]);
  assert.deepEqual(outcome.rejected, ["b"]);
  assert.match(outcome.advice, /Do not run this document again: a already applied/);
  assert.match(outcome.advice, /Retry only b, in a new document/);
  assert.doesNotMatch(outcome.advice, /run it again/);
  assert.equal(outcome.notice, undefined);
});

test("a top-level error on one root's path makes that root unknown and the store partial", async (t) => {
  const { callTool } = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { data: { a: tagsPayload("gid://shopify/Product/1"), b: null }, errors: [{ message: "Internal error", path: ["b"] }] }
    : undefined);
  const result = await run(callTool, `mutation { ${TAGS("a", "gid://shopify/Product/1")} ${TAGS("b", "gid://shopify/Product/2")} }`);
  const outcome = result.structuredContent.results[0];
  assert.equal(outcome.outcome, "partial");
  assert.deepEqual(outcome.unknown, ["b"]);
  assert.equal(outcome.roots[1].errors[0].message, "Internal error");
  assert.match(outcome.advice, /Read the affected records for b first/);

  // Only the failing root: unknown, never "rejected", never a suggestion to rerun.
  const single = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { data: { b: null }, errors: [{ message: "Internal error", path: ["b"] }] }
    : undefined);
  const alone = (await run(single.callTool, `mutation { ${TAGS("b", "gid://shopify/Product/2")} }`)).structuredContent.results[0];
  assert.equal(alone.outcome, "unknown");
  assert.match(alone.advice, /Do not run this document again/);
});

test("root fields in fragments are judged, and a clean response is applied", async (t) => {
  const { callTool, requests } = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { data: { a: tagsPayload("gid://shopify/Product/1") } }
    : undefined);
  const result = await run(callTool, "mutation { ...F } fragment F on Mutation { a: tagsAdd(id: \"gid://shopify/Product/1\", tags: [\"x\"]) { node { id } } }");
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.match(mutationRequests(requests)[0].query, /fragment F on Mutation \{\s*a: tagsAdd[^}]*\{\s*node \{\s*id\s*\}\s*smsUserErrors_userErrors/);
  assert.equal(result.structuredContent.results[0].outcome, "applied");
});

test("shopify_graphql_mutation judges each root the same way", async (t) => {
  const { requests } = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { data: { a: tagsPayload("gid://shopify/Product/1"), b: tagsPayload("y", [{ field: ["tags"], message: "Too many tags" }]) } }
    : undefined);
  const store = await findStore("main");
  const result = await sendMutationWithOutcome(store, `mutation { ${TAGS("a", "gid://shopify/Product/1")} ${TAGS("b", "gid://shopify/Product/2")} }`, {});
  assert.match(requests.at(-1).query, /smsUserErrors_userErrors/);
  assert.equal(result.outcome, "partial");
  assert.deepEqual(result.applied, ["a"]);
  assert.deepEqual(result.rejected, ["b"]);
  assert.equal(result.userErrors.length, 1);
  assert.equal(result.data.b.smsUserErrors_userErrors, undefined);
  // A document that does not validate is sent unchanged, as before, and says it was not analyzed.
  const invalid = await sendMutationWithOutcome(store, "mutation { tagsAdd(id: 1) { node { id } } }", {});
  assert.equal(invalid.outcome, undefined);
  assert.match(invalid.outcomeNotice, /not analyzed/);
});

// ---------- Dry-run completeness ----------

const dry = (callTool, args) => callTool("shopify_run_action", { stores: ["main"], ...args });

test("a small dry run naming every target by ID is complete", async (t) => {
  const { callTool } = await fixture(t);
  const result = await dry(callTool, { mutation: "tagsAdd", variables: { id: "gid://shopify/Product/1", tags: ["x"] } });
  assert.notEqual(result.isError, true, result.content[0].text);
  const { preview } = result.structuredContent.results[0];
  assert.equal(preview.complete, true);
  assert.equal(preview.targets, 1);
  assert.equal(preview.resolved, 1);
  assert.equal(preview.reasons, undefined);
  assert.equal(result.structuredContent.complete, true);
  assert.doesNotMatch(JSON.stringify(result.structuredContent), /exact/i);
  assert.match(result.structuredContent.nextStep, /dryRun: false/);
});

test("IDs written inline in the document are looked up too", async (t) => {
  const { callTool, requests } = await fixture(t);
  const result = await dry(callTool, { document: "mutation { tagsAdd(id: \"gid://shopify/Product/77\", tags: [\"x\"]) { node { id } } }" });
  assert.deepEqual(requests[0].variables.ids, ["gid://shopify/Product/77"]);
  const store = result.structuredContent.results[0];
  assert.equal(store.preview.targets, 1);
  assert.equal(store.touchedRecords[0].title, "Title of gid://shopify/Product/77");
});

test("an ID that does not resolve is listed and makes the preview incomplete", async (t) => {
  const { callTool } = await fixture(t);
  const result = await dry(callTool, { mutation: "productVariantsBulkUpdate", variables: { productId: "gid://shopify/Product/1", variants: [{ id: "gid://shopify/ProductVariant/404", price: "1.00" }] } });
  const store = result.structuredContent.results[0];
  assert.equal(store.ok, false);
  assert.equal(store.preview.complete, false);
  assert.deepEqual(store.preview.unresolved, ["gid://shopify/ProductVariant/404"]);
  assert.match(store.preview.reasons.join(" "), /did not resolve/);
  assert.match(store.preview.recommendation, /Do not apply without narrowing/);
  assert.equal(result.structuredContent.complete, false);
});

test("applying resolves every ID again and refuses unresolved ones unless acknowledgeIncompletePreview", async (t) => {
  let lookupFails = false;
  const { callTool, requests } = await fixture(t, (request) => {
    if (lookupFails && /nodes\(ids:/.test(request.query)) return { errors: [{ message: "Internal error" }] };
    if (/^\s*mutation/.test(request.query)) return { data: { tagsAdd: tagsPayload("gid://shopify/Product/5") } };
    return undefined;
  });
  // One unresolved ID in the variables, one inline in the document.
  const byVariables = { mutation: "productVariantsBulkUpdate", variables: { productId: "gid://shopify/Product/1", variants: [{ id: "gid://shopify/ProductVariant/404", price: "1.00" }] }, dryRun: false };
  const byInline = { document: "mutation { tagsAdd(id: \"gid://shopify/Product/404\", tags: [\"x\"]) { node { id } } }", dryRun: false };
  for (const args of [byVariables, byInline]) {
    const refused = await dry(callTool, args);
    assert.equal(refused.isError, true, refused.content[0].text);
    assert.match(refused.content[0].text, /could not be confirmed/);
    assert.match(refused.content[0].text, /acknowledgeIncompletePreview: true/);
    assert.match(refused.structuredContent.reasons.join(" "), /main: 1 ID did not resolve/);
    assert.ok(Object.values(refused.structuredContent.unresolved).flat().some((id) => id.endsWith("/404")));
  }
  assert.equal(mutationRequests(requests).length, 0, "nothing was applied");
  assert.ok(requests.filter((request) => /nodes\(ids:/.test(request.query)).length >= 2, "IDs were looked up at apply time");

  const resolvable = { ...byInline, document: byInline.document.replace("/404", "/5") };
  lookupFails = true;
  const blocked = await dry(callTool, resolvable);
  assert.equal(blocked.isError, true);
  assert.match(blocked.structuredContent.reasons.join(" "), /lookup returned errors/);
  assert.equal(mutationRequests(requests).length, 0, "a failed lookup also blocks applying");
  lookupFails = false;

  const acknowledged = await dry(callTool, { ...byInline, acknowledgeIncompletePreview: true });
  assert.ok(!/could not be confirmed/.test(acknowledged.content[0].text));
  assert.equal(mutationRequests(requests).length, 1);

  const applied = await dry(callTool, resolvable);
  assert.notEqual(applied.isError, true, applied.content[0].text);
  assert.equal(mutationRequests(requests).length, 2);
});

test("more than 250 targets is incomplete and applying needs acknowledgeIncompletePreview", async (t) => {
  const { callTool, requests } = await fixture(t);
  const variants = Array.from({ length: 300 }, (_, index) => ({ id: `gid://shopify/ProductVariant/${index + 1}`, price: "1.00" }));
  const args = { mutation: "productVariantsBulkUpdate", variables: { productId: "gid://shopify/Product/1", variants } };
  const result = await dry(callTool, args);
  const store = result.structuredContent.results[0];
  assert.equal(requests[0].variables.ids.length, 250);
  assert.equal(store.preview.complete, false);
  assert.equal(store.preview.targets, 301);
  assert.match(store.preview.reasons.join(" "), /301 record IDs; only the first 250/);
  assert.match(result.structuredContent.recommendation, /Do not apply without narrowing/);
  assert.match(result.structuredContent.nextStep, /acknowledgeIncompletePreview: true/);

  const refused = await dry(callTool, { ...args, dryRun: false });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /acknowledgeIncompletePreview/);
  assert.equal(mutationRequests(requests).length, 0);
  const applied = await dry(callTool, { ...args, dryRun: false, acknowledgeIncompletePreview: true });
  assert.notEqual(applied.isError, true, applied.content[0].text);
  assert.equal(mutationRequests(requests).length, 1);
});

test("search-derived mutations are never a complete preview and need confirm plus acknowledgeIncompletePreview", async (t) => {
  const { callTool, requests } = await fixture(t, (request) => /^\s*mutation/.test(request.query)
    ? { data: { urlRedirectBulkDeleteBySearch: { job: { id: "gid://shopify/Job/1" }, smsUserErrors_userErrors: [] } } }
    : undefined);
  const args = { mutation: "urlRedirectBulkDeleteBySearch", variables: { search: "path:/old" } };
  const preview = await dry(callTool, args);
  assert.notEqual(preview.isError, true, preview.content[0].text);
  const store = preview.structuredContent.results[0];
  assert.equal(store.preview.complete, false);
  assert.equal(store.preview.targets, 0);
  assert.match(store.preview.reasons.join(" "), /urlRedirectBulkDeleteBySearch/);
  assert.match(store.preview.recommendation, /Do not apply without narrowing/);
  assert.equal(requests.length, 0, "nothing to look up");

  const confirmOnly = await dry(callTool, { ...args, dryRun: false, confirm: "urlRedirectBulkDeleteBySearch" });
  assert.equal(confirmOnly.isError, true);
  assert.match(confirmOnly.content[0].text, /acknowledgeIncompletePreview/);
  const ackOnly = await dry(callTool, { ...args, dryRun: false, acknowledgeIncompletePreview: true });
  assert.equal(ackOnly.isError, true);
  assert.match(ackOnly.content[0].text, /confirm: "urlRedirectBulkDeleteBySearch"/);
  assert.equal(mutationRequests(requests).length, 0);
  const applied = await dry(callTool, { ...args, dryRun: false, confirm: "urlRedirectBulkDeleteBySearch", acknowledgeIncompletePreview: true });
  assert.notEqual(applied.isError, true, applied.content[0].text);
  assert.equal(mutationRequests(requests).length, 1);

  // A search argument on a mutation that also takes IDs counts only when it is given.
  const byIds = await dry(callTool, { mutation: "discountCodeBulkDelete", variables: { ids: ["gid://shopify/DiscountCodeNode/1"] } });
  assert.equal(byIds.structuredContent.results[0].preview.complete, true);
  const bySearch = await dry(callTool, { mutation: "discountCodeBulkDelete", variables: { search: "" } });
  assert.equal(bySearch.structuredContent.results[0].preview.complete, false);
});
