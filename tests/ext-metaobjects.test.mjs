import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { buildClientSchema, parse, validate } from "graphql";
import { METAOBJECT_DOCS } from "../dist/extensions/metaobjects.js";
import { EXTRA_GET, EXTRA_SEARCH, MANAGE_OPERATIONS } from "../dist/extension-registry.js";
import { operationSchema } from "../dist/commerce-tools.js";
import { enableHostedMode } from "../dist/runtime.js";
import { login, mcpClient, setup, shopifyMock } from "./hosted-fixture.mjs";

enableHostedMode();

const raw = JSON.parse(gunzipSync(readFileSync(new URL("../schemas/admin-2026-07.json.gz", import.meta.url))));
const schema = buildClientSchema(raw.data ?? raw);

test("every metaobject document is valid against Admin API 2026-07", () => {
  for (const [name, document] of Object.entries(METAOBJECT_DOCS)) assert.deepEqual(validate(schema, parse(document)).map((error) => error.message), [], name);
});

test("registrations exist with the expected scopes", () => {
  assert.deepEqual(EXTRA_SEARCH.metaobject_definitions.scopes, ["read_metaobject_definitions"]);
  assert.deepEqual(EXTRA_GET.metaobject.scopes, ["read_metaobjects"]);
  assert.deepEqual(EXTRA_GET.metaobject.types, ["Metaobject"]);
  assert.deepEqual(EXTRA_GET.metaobject_definition.scopes, ["read_metaobject_definitions"]);
  assert.deepEqual(EXTRA_GET.metaobject_definition.types, ["MetaobjectDefinition"]);
  assert.deepEqual(MANAGE_OPERATIONS.metaobject.scopes, ["write_metaobjects"]);
  assert.deepEqual(MANAGE_OPERATIONS.metafield_definition.scopes, []);
  assert.equal(MANAGE_OPERATIONS.metaobject.confirmWord({ action: "delete" }), "delete");
  assert.equal(MANAGE_OPERATIONS.metaobject.confirmWord({ action: "update" }), undefined);
});

test("zod rejects bad GIDs, types, handles and field keys", () => {
  const schemaFor = operationSchema("metaobject");
  const ok = { action: "update", id: "gid://shopify/Metaobject/1", fields: [{ key: "title", value: "x" }] };
  assert.ok(schemaFor.safeParse(ok).success);
  for (const bad of [
    { ...ok, id: "gid://shopify/Product/1" },
    { ...ok, id: "gid://shopify/Metaobject/abc" },
    { ...ok, id: "1" },
    { action: "create", type: "a b", fields: [] },
    { action: "create", type: "faq", handle: "bad handle" },
    { ...ok, fields: [{ key: "x y", value: "1" }] },
    { ...ok, status: "PUBLISHED" },
    { ...ok, extra: true },
  ]) assert.equal(schemaFor.safeParse(bad).success, false, JSON.stringify(bad));
  const defs = operationSchema("metafield_definition");
  const good = { action: "create", ownerType: "PRODUCT", namespace: "custom", key: "care", name: "Care", type: "single_line_text_field" };
  assert.ok(defs.safeParse(good).success);
  assert.equal(defs.safeParse({ ...good, ownerType: "product" }).success, false);
  assert.equal(defs.safeParse({ ...good, action: "delete" }).success, false);
});

const DEFINITION = { id: "gid://shopify/MetaobjectDefinition/1", type: "faq", name: "FAQ", displayNameKey: "question", capabilities: { publishable: { enabled: true } }, fieldDefinitions: [{ key: "question", name: "Question", required: true, type: { name: "single_line_text_field" } }, { key: "answer", name: "Answer", required: false, type: { name: "multi_line_text_field" } }] };
const ENTRY = { id: "gid://shopify/Metaobject/5", handle: "shipping", type: "faq", displayName: "Shipping", updatedAt: "2026-11-01T00:00:00Z", fields: [{ key: "question", type: "single_line_text_field", value: "Shipping?", jsonValue: "Shipping?" }], capabilities: { publishable: { status: "ACTIVE" } } };

function respond(body) {
  const q = body.query ?? "";
  if (/currentAppInstallation/.test(q)) return { body: { data: { shop: { myshopifyDomain: "main.myshopify.com" }, currentAppInstallation: { accessScopes: [{ handle: "write_metaobjects" }, { handle: "read_metaobject_definitions" }] } } } };
  if (/metaobjectDefinitionByType/.test(q)) return { body: { data: { metaobjectDefinitionByType: body.variables.type === "faq" ? DEFINITION : null } } };
  if (/metaobjectByHandle/.test(q)) return { body: { data: { metaobjectByHandle: body.variables.handle.handle === "shipping" ? ENTRY : null } } };
  if (/query MetaobjectForWrite/.test(q)) return { body: { data: { metaobject: { ...ENTRY, definition: DEFINITION } } } };
  if (/metafieldDefinitions\(/.test(q)) return { body: { data: { metafieldDefinitions: { nodes: body.variables.key === "taken" ? [{ id: "gid://shopify/MetafieldDefinition/9" }] : [] } } } };
  if (/metaobjectCreate/.test(q)) return { body: { data: { metaobjectCreate: { metaobject: ENTRY, userErrors: [] } } } };
  return undefined;
}

const WRITES = /mutation /;
const manage = (client, input, extra = {}) => client.callTool({ name: "shopify_manage", arguments: { store: "main", operation: "metaobject", input, ...extra } });

test("metaobject operation: dry run, confirm word and unknown keys never reach a write", async (t) => {
  const requests = await shopifyMock(t, respond);
  const { app } = await setup(t);
  const client = await mcpClient(t, app, (await login(app, "pat@bariatricpal.com", { alias: "main", token: "pat-online-main" })).accessToken);
  const writesSince = (n) => requests.slice(n).filter((r) => WRITES.test(r.body.query));

  let before = requests.length;
  const preview = await manage(client, { action: "create", type: "faq", handle: "returns", fields: [{ key: "question", value: "Returns?" }], status: "DRAFT" });
  assert.notEqual(preview.isError, true, JSON.stringify(preview));
  const shown = JSON.parse(preview.content[0].text);
  assert.equal(shown.dryRun, true);
  assert.deepEqual(shown.wouldCreate.capabilities, { publishable: { status: "DRAFT" } });
  assert.equal(writesSince(before).length, 0, "dry run sends no mutation");

  before = requests.length;
  const applied = await manage(client, { action: "create", type: "faq", fields: [{ key: "question", value: "Returns?" }] }, { dryRun: false });
  assert.notEqual(applied.isError, true, JSON.stringify(applied));
  assert.equal(writesSince(before).length, 1);

  before = requests.length;
  const unknown = await manage(client, { action: "create", type: "faq", fields: [{ key: "question", value: "a" }, { key: "bogus", value: "b" }] }, { dryRun: false });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown field key.*bogus/);
  assert.match(unknown.content[0].text, /question, answer/);
  const unknownUpdate = await manage(client, { action: "update", id: ENTRY.id, fields: [{ key: "nope", value: "b" }] }, { dryRun: false });
  assert.equal(unknownUpdate.isError, true);
  assert.equal(writesSince(before).length, 0, "unknown keys are rejected before any write");

  const missingRequired = await manage(client, { action: "create", type: "faq", fields: [{ key: "answer", value: "b" }] }, { dryRun: false });
  assert.equal(missingRequired.isError, true);
  assert.match(missingRequired.content[0].text, /required.*question/);
  const noDefinition = await manage(client, { action: "upsert", type: "nothing", handle: "x", fields: [{ key: "answer", value: "b" }] });
  assert.equal(noDefinition.isError, true);
  assert.match(noDefinition.content[0].text, /No metaobject definition/);

  before = requests.length;
  const del = await manage(client, { action: "delete", id: ENTRY.id });
  assert.equal(JSON.parse(del.content[0].text).wouldDelete.handle, "shipping");
  const refused = await manage(client, { action: "delete", id: ENTRY.id }, { dryRun: false });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /requiredConfirm.*delete/);
  assert.equal(writesSince(before).length, 0, "delete without confirm sends no mutation");

  const dupe = await manage(client, { action: "create", type: "faq", handle: "shipping", fields: [{ key: "question", value: "a" }] });
  assert.equal(dupe.isError, true);
  assert.match(dupe.content[0].text, /already exists/);
  const upsertPreview = JSON.parse((await manage(client, { action: "upsert", type: "faq", handle: "shipping", fields: [{ key: "answer", value: "b" }] })).content[0].text);
  assert.ok(upsertPreview.wouldUpdate && !upsertPreview.wouldCreate);
});

test("metafield_definition create checks for an existing definition and previews by default", async (t) => {
  const requests = await shopifyMock(t, respond);
  const { app } = await setup(t);
  const client = await mcpClient(t, app, (await login(app, "pat@bariatricpal.com", { alias: "main", token: "pat-online-main" })).accessToken);
  const input = { action: "create", ownerType: "PRODUCT", namespace: "custom", key: "care", name: "Care", type: "single_line_text_field", pin: true };
  const call = (i, extra = {}) => client.callTool({ name: "shopify_manage", arguments: { store: "main", operation: "metafield_definition", input: i, ...extra } });
  const preview = await call(input);
  assert.notEqual(preview.isError, true, JSON.stringify(preview));
  assert.equal(JSON.parse(preview.content[0].text).dryRun, true);
  assert.ok(!requests.some((r) => /metafieldDefinitionCreate/.test(r.body.query)));
  const taken = await call({ ...input, key: "taken" }, { dryRun: false });
  assert.equal(taken.isError, true);
  assert.match(taken.content[0].text, /already exists/);
  assert.ok(!requests.some((r) => /metafieldDefinitionCreate/.test(r.body.query)));
});
