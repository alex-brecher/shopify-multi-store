import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { buildClientSchema, parse, validate } from "graphql";
import { DISCOUNT_DOCS, buildInput, codeLookupDocument, describeCreate } from "../dist/extensions/discounts.js";
import { EXTRA_GET, EXTRA_SEARCH, MANAGE_OPERATIONS } from "../dist/extension-registry.js";
import { operationSchema } from "../dist/commerce-tools.js";
import { enableHostedMode } from "../dist/runtime.js";
import { login, mcpClient, setup, shopifyMock } from "./hosted-fixture.mjs";

enableHostedMode();

const raw = JSON.parse(gunzipSync(readFileSync(new URL("../schemas/admin-2026-07.json.gz", import.meta.url))));
const schema = buildClientSchema(raw.data ?? raw);

const CODE_ID = "gid://shopify/DiscountCodeNode/11";
const AUTO_ID = "gid://shopify/DiscountAutomaticNode/22";

test("every discount GraphQL document validates against Admin API 2026-07", () => {
  assert.ok(Object.keys(DISCOUNT_DOCS).length >= 20);
  for (const [name, document] of Object.entries(DISCOUNT_DOCS)) assert.deepEqual(validate(schema, parse(document)).map((e) => e.message), [], name);
  for (const n of [1, 2, 50]) assert.deepEqual(validate(schema, parse(codeLookupDocument(n))).map((e) => e.message), [], `lookup ${n}`);
});

test("every input the create operation can build validates as a Shopify input", () => {
  const base = { title: "T", startsAt: "2026-11-20T00:00:00Z", endsAt: "2026-11-30T00:00:00Z" };
  const cases = [
    { ...base, kind: "percentage", method: "code", code: "FALL20", percentage: 0.2, appliesOncePerCustomer: true, usageLimit: 100, minimumSubtotal: "50.00", combinesWith: { shippingDiscounts: true } },
    { ...base, kind: "amount_off", method: "automatic", amount: "10.00", collectionIds: ["gid://shopify/Collection/1"], minimumQuantity: 2 },
    { ...base, kind: "free_shipping", method: "code", code: "SHIPFREE", maximumShippingPrice: "15.00" },
    { ...base, kind: "bxgy", method: "automatic", buyQuantity: 2, buyProductIds: ["gid://shopify/Product/1"], getQuantity: 1, getProductIds: ["gid://shopify/Product/2"], getPercentage: 1, usesPerOrderLimit: 1 },
  ];
  for (const a of cases) {
    const Method = a.method === "code" ? "Code" : "Automatic";
    const native = { percentage: "Basic", amount_off: "Basic", free_shipping: "FreeShipping", bxgy: "Bxgy" }[a.kind];
    const document = DISCOUNT_DOCS[`create${Method}${native}`];
    assert.ok(document, a.kind);
    const input = buildInput(a);
    const typeName = /\$input: (\w+)!/.exec(document)[1];
    const type = schema.getType(typeName);
    const fields = type.getFields();
    for (const key of Object.keys(input)) assert.ok(fields[key], `${typeName}.${key}`);
  }
});

test("registrations exist with their scopes", () => {
  assert.deepEqual(EXTRA_SEARCH.discounts.scopes, ["read_discounts"]);
  assert.deepEqual(EXTRA_GET.discount.scopes, ["read_discounts"]);
  assert.deepEqual(EXTRA_GET.discount.types, ["DiscountNode", "DiscountCodeNode", "DiscountAutomaticNode"]);
  assert.deepEqual(MANAGE_OPERATIONS.discount.scopes, ["write_discounts"]);
  assert.equal(MANAGE_OPERATIONS.discount.confirmWord({ action: "delete" }), "delete");
  assert.equal(MANAGE_OPERATIONS.discount.confirmWord({ action: "create" }), undefined);
});

test("zod rejects a negative amount, a percentage above 1, a bad GID and other bad input", () => {
  const schemaFor = operationSchema("discount");
  const ok = { action: "create", kind: "percentage", method: "code", code: "A1", title: "T", startsAt: "2026-11-20T00:00:00Z", percentage: 0.2 };
  assert.equal(schemaFor.safeParse(ok).success, true);
  const bad = [
    { ...ok, kind: "amount_off", amount: "-5.00" },
    { ...ok, kind: "amount_off", amount: "0" },
    { ...ok, kind: "amount_off", amount: "10.123" },
    { ...ok, percentage: 20 },
    { ...ok, percentage: 1.01 },
    { ...ok, percentage: 0 },
    { ...ok, productIds: ["gid://shopify/Collection/1"] },
    { action: "delete", id: "not-a-gid" },
    { action: "delete", id: "gid://shopify/Product/1" },
    { ...ok, code: "has space" },
    { ...ok, startsAt: "tomorrow" },
    { ...ok, customerEligibility: "segments" },
    { action: "add_codes", id: CODE_ID, codes: Array.from({ length: 251 }, (_, i) => `C${i}`) },
    { ...ok, surprise: true },
  ];
  for (const input of bad) assert.equal(schemaFor.safeParse(input).success, false, JSON.stringify(input));
  assert.equal(schemaFor.safeParse({ action: "add_codes", id: CODE_ID, codes: Array.from({ length: 250 }, (_, i) => `C${i}`) }).success, true);
});

test("the dry run says the exact discount in plain words", () => {
  const words = describeCreate({ kind: "percentage", method: "code", code: "FALL20", percentage: 0.2, startsAt: "2026-11-20T00:00:00Z", endsAt: "2026-11-30T00:00:00Z", appliesOncePerCustomer: true });
  assert.match(words, /^20% off all products, code FALL20, from 2026-11-20 to 2026-11-30, all customers, once per customer/);
});

/** A mock Shopify that knows one code discount, one automatic discount and a list of taken codes. */
function discountMock(t, { taken = [] } = {}) {
  return shopifyMock(t, (body) => {
    const q = body.query ?? "";
    const v = body.variables ?? {};
    if (/accessScopes/.test(q)) return { body: { data: { shop: { id: "gid://shopify/Shop/1", name: "Main", myshopifyDomain: "main.myshopify.com" }, currentAppInstallation: { id: "gid://shopify/AppInstallation/1", accessScopes: [{ handle: "read_discounts" }, { handle: "write_discounts" }] } } } };
    if (/codeDiscountNodeByCode\(code: \$code\)/.test(q)) return { body: { data: { codeDiscountNodeByCode: taken.includes(v.code) ? { id: CODE_ID, codeDiscount: { __typename: "DiscountCodeBasic", title: "Existing" } } : null } } };
    if (/c0: codeDiscountNodeByCode/.test(q)) return { body: { data: Object.fromEntries(Object.keys(v).map((key) => [key, taken.includes(v[key]) ? { id: CODE_ID } : null])) } };
    if (/discountNode\(id: \$id\)/.test(q)) {
      const code = v.id === CODE_ID;
      return { body: { data: { discountNode: { id: v.id, discount: code ? { __typename: "DiscountCodeBasic", title: "Fall sale", status: "ACTIVE", summary: "20% off all products", startsAt: "2026-11-20T00:00:00Z", endsAt: null, asyncUsageCount: 3, usageLimit: null, codes: { nodes: [{ code: "FALL20" }] } } : { __typename: "DiscountAutomaticBasic", title: "Auto", status: "ACTIVE", summary: "10% off", startsAt: "2026-11-01T00:00:00Z", endsAt: null } } } } };
    }
    if (/mutation/.test(q)) return { body: { data: { [/\{\s*(\w+)\(/.exec(q)[1]]: { userErrors: [], codeDiscountNode: { id: CODE_ID }, automaticDiscountNode: { id: AUTO_ID }, deletedCodeDiscountId: CODE_ID, bulkCreation: { id: "gid://shopify/DiscountRedeemCodeBulkCreation/1", done: true, importedCount: 2, failedCount: 0 } } } } };
    return undefined;
  });
}

async function client(t, mock) {
  const requests = await mock;
  const { app } = await setup(t);
  const { accessToken } = await login(app, "pat@bariatricpal.com", { alias: "main", token: "pat-online-main" });
  const c = await mcpClient(t, app, accessToken);
  const manage = async (input, extra = {}) => {
    const r = await c.callTool({ name: "shopify_manage", arguments: { store: "main", operation: "discount", input, ...extra } });
    return { ...r, json: JSON.parse(r.content[0].text) };
  };
  const writes = (from = 0) => requests.slice(from).filter((r) => /^\s*mutation/.test(r.body.query ?? ""));
  return { c, manage, requests, writes };
}

const create = { action: "create", kind: "percentage", method: "code", code: "FALL20", title: "Fall sale", startsAt: "2026-11-20T00:00:00Z", endsAt: "2026-11-30T00:00:00Z", percentage: 0.2, appliesOncePerCustomer: true };

test("create dry run previews in words and sends no mutation; dryRun:false creates and reads back", async (t) => {
  const { manage, requests, writes } = await client(t, discountMock(t));
  const before = requests.length;
  const preview = await manage(create);
  assert.notEqual(preview.isError, true, JSON.stringify(preview));
  assert.equal(preview.json.dryRun, true);
  assert.match(preview.json.wouldCreate, /20% off all products, code FALL20, from 2026-11-20 to 2026-11-30/);
  assert.equal(preview.json.input.customerGets.value.percentage, 0.2);
  assert.equal(writes(before).length, 0, "dry run sends no mutation");
  const done = await manage(create, { dryRun: false });
  assert.notEqual(done.isError, true, JSON.stringify(done));
  assert.equal(done.json.discount.id, CODE_ID);
  assert.equal(writes(before).length, 1);
});

test("a code that already exists is refused, even in a dry run", async (t) => {
  const { manage, requests, writes } = await client(t, discountMock(t, { taken: ["FALL20", "TAKEN1"] }));
  const before = requests.length;
  for (const dryRun of [true, false]) {
    const r = await manage(create, { dryRun });
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.json), /already exists/);
  }
  const codes = await manage({ action: "add_codes", id: CODE_ID, codes: ["NEW1", "TAKEN1"] }, { dryRun: false });
  assert.equal(codes.isError, true);
  assert.match(JSON.stringify(codes.json), /TAKEN1/);
  assert.equal(writes(before).length, 0);
});

test("delete without confirm is refused; with confirm it deletes", async (t) => {
  const { manage, requests, writes } = await client(t, discountMock(t));
  const before = requests.length;
  const refused = await manage({ action: "delete", id: CODE_ID }, { dryRun: false });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.json), /requiredConfirm.*delete/);
  assert.equal(writes(before).length, 0);
  const preview = await manage({ action: "delete", id: CODE_ID });
  assert.equal(preview.json.wouldDelete.title, "Fall sale");
  assert.equal(writes(before).length, 0);
  const done = await manage({ action: "delete", id: CODE_ID }, { dryRun: false, confirm: "delete" });
  assert.notEqual(done.isError, true, JSON.stringify(done));
  assert.equal(writes(before).length, 1);
  assert.match(writes(before)[0].body.query, /discountCodeDelete/);
});

test("activate, deactivate, add_codes and update pick the right mutation and preview first", async (t) => {
  const { manage, requests, writes } = await client(t, discountMock(t));
  const before = requests.length;
  assert.equal((await manage({ action: "deactivate", id: AUTO_ID })).json.dryRun, true);
  assert.equal((await manage({ action: "add_codes", id: CODE_ID, codes: ["A1", "B2"] })).json.wouldAdd, 2);
  assert.equal((await manage({ action: "update", id: CODE_ID, title: "New" })).json.changes.title, "New");
  assert.equal(writes(before).length, 0);
  await manage({ action: "deactivate", id: AUTO_ID }, { dryRun: false });
  await manage({ action: "activate", id: CODE_ID }, { dryRun: false });
  const added = await manage({ action: "add_codes", id: CODE_ID, codes: ["A1", "B2"] }, { dryRun: false });
  assert.equal(added.json.bulkCreation.imported, 2);
  await manage({ action: "update", id: CODE_ID, endsAt: "2026-12-31T00:00:00Z", usageLimit: 50 }, { dryRun: false });
  const sent = writes(before).map((r) => /\{\s*(\w+)\(/.exec(r.body.query)[1]);
  assert.deepEqual(sent, ["discountAutomaticDeactivate", "discountCodeActivate", "discountRedeemCodeBulkAdd", "discountCodeBasicUpdate"]);
  const auto = await manage({ action: "update", id: AUTO_ID, usageLimit: 5 });
  assert.equal(auto.isError, true);
});

test("fields that do not belong to the kind are refused, not ignored", async (t) => {
  const { manage, requests, writes } = await client(t, discountMock(t));
  const before = requests.length;
  const stray = await manage({ ...create, kind: "free_shipping", percentage: 0.2 });
  assert.equal(stray.isError, true);
  assert.match(JSON.stringify(stray.json), /does not take percentage/);
  const auto = await manage({ ...create, method: "automatic" });
  assert.equal(auto.isError, true);
  assert.match(JSON.stringify(auto.json), /does not take code/);
  assert.equal(writes(before).length, 0);
});
