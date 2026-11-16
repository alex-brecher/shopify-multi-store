import assert from "node:assert/strict";
import test from "node:test";
import { assertWritable, isReadOnly, readOnlyEverywhere } from "../dist/read-only.js";

const env = { SHOPIFY_READ_ONLY_STORES: " Outlet ,wholesale", SHOPIFY_READ_ONLY_USERS: "a@x.com, b@x.com:main, b@x.com:outlet" };

test("read-only rules: whole server, stores, people, and people on one store", () => {
  assert.equal(isReadOnly("main", undefined, {}), false);
  assert.equal(isReadOnly("main", undefined, { SHOPIFY_READ_ONLY: "true" }), true);
  assert.equal(isReadOnly("outlet", undefined, env), true);
  assert.equal(isReadOnly("WHOLESALE", "c@x.com", env), true);
  assert.equal(isReadOnly("main", "A@X.com", env), true);
  assert.equal(isReadOnly("main", "b@x.com", env), true);
  assert.equal(isReadOnly("retail", "b@x.com", env), false);
  assert.equal(readOnlyEverywhere("a@x.com", env), true);
  assert.equal(readOnlyEverywhere("b@x.com", env), false, "read-only on some stores is not everywhere");
  assert.equal(readOnlyEverywhere(undefined, { SHOPIFY_READ_ONLY: "1" }), true);
  assert.equal(readOnlyEverywhere(undefined, { SHOPIFY_READ_ONLY: "no" }), false);
});

test("assertWritable refuses mutations on read-only stores but passes queries and read-safe mutations", (t) => {
  process.env.SHOPIFY_READ_ONLY_STORES = "main";
  t.after(() => { delete process.env.SHOPIFY_READ_ONLY_STORES; });
  assert.throws(() => assertWritable("main", "mutation { tagsAdd(id: \"x\", tags: [\"a\"]) { node { id } } }"), /^ReadOnlyError: Read-only: changes to main/);
  assert.doesNotThrow(() => assertWritable("other", "mutation { tagsAdd(id: \"x\", tags: [\"a\"]) { node { id } } }"));
  assert.doesNotThrow(() => assertWritable("main", "query { shop { name } }"));
  assert.doesNotThrow(() => assertWritable("main", "mutation { draftOrderCalculate(input: {}) { calculatedDraftOrder { totalPriceSet { shopMoney { amount } } } } }"));
  assert.throws(() => assertWritable("main", "mutation { draftOrderCalculate(input: {}) { calculatedDraftOrder { lineItems { title } } } draftOrderCreate(input: {}) { draftOrder { id } } }"), /Read-only/, "a safe field cannot carry a write");
});

test("read-only rules forgive spaces, semicolons and spaces around the colon", () => {
  const env = { SHOPIFY_READ_ONLY_USERS: "bob@x.com : storea; amy@x.com  carl@x.com:storeb" };
  assert.equal(isReadOnly("storea", "bob@x.com", env), true);
  assert.equal(isReadOnly("storec", "bob@x.com", env), false);
  assert.equal(readOnlyEverywhere("amy@x.com", env), true);
  assert.equal(isReadOnly("storeb", "carl@x.com", env), true);
});

test("bulkOperationCancel stays allowed for read-only people", (t) => {
  process.env.SHOPIFY_READ_ONLY = "true";
  t.after(() => { delete process.env.SHOPIFY_READ_ONLY; });
  assert.doesNotThrow(() => assertWritable("main", "mutation { bulkOperationCancel(id: \"gid://shopify/BulkOperation/1\") { bulkOperation { id } } }"));
});
