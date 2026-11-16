import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { buildClientSchema, parse, validate } from "graphql";
import { enableHostedMode } from "../dist/runtime.js";
import { MANAGE_OPERATIONS, EXTRA_SEARCH } from "../dist/extension-registry.js";
import { operationSchema } from "../dist/commerce-tools.js";
import { extensionScopes } from "../dist/extension-registry.js";
import { DRAFT_FILES_DOCS, validHttpsUrl } from "../dist/extensions/drafts-files.js";
import { call, mcpClient, login, setup, shopifyMock } from "./hosted-fixture.mjs";

enableHostedMode();

const raw = JSON.parse(gunzipSync(readFileSync(new URL("../schemas/admin-2026-07.json.gz", import.meta.url))));
const schema = buildClientSchema(raw.data ?? raw);

test("every drafts and files document validates against Admin API 2026-07", () => {
  for (const [name, document] of Object.entries(DRAFT_FILES_DOCS)) assert.deepEqual(validate(schema, parse(document)).map((error) => error.message), [], name);
});

test("registrations exist with their scopes", () => {
  assert.deepEqual(MANAGE_OPERATIONS.draft_order.scopes, ["write_draft_orders"]);
  assert.deepEqual(MANAGE_OPERATIONS.file.scopes, ["write_files"]);
  assert.deepEqual(EXTRA_SEARCH.marketing_events.scopes, ["read_marketing_events"]);
  assert.deepEqual(EXTRA_SEARCH.abandoned_checkouts.scopes, ["read_orders"]);
  assert.match(EXTRA_SEARCH.abandoned_checkouts.description, /protected customer data/);
  const scopes = extensionScopes();
  assert.deepEqual(scopes["shopify_search:marketing_events"], ["read_marketing_events"]);
  assert.deepEqual(scopes["shopify_search:abandoned_checkouts"], ["read_orders"]);
  assert.equal(MANAGE_OPERATIONS.draft_order.confirmWord({ action: "delete" }), "delete");
  assert.equal(MANAGE_OPERATIONS.draft_order.confirmWord({ action: "update" }), undefined);
  assert.equal(MANAGE_OPERATIONS.file.confirmWord({ action: "delete" }), "delete");
  assert.equal(MANAGE_OPERATIONS.file.confirmWord({ action: "create" }), undefined);
});

test("zod rejects http URLs and bad GIDs", () => {
  assert.equal(validHttpsUrl("https://cdn.example.com/a.png"), true);
  assert.equal(validHttpsUrl("http://cdn.example.com/a.png"), false);
  assert.equal(validHttpsUrl("https://user:pw@cdn.example.com/a.png"), false);
  const file = operationSchema("file");
  assert.equal(file.safeParse({ action: "create", originalSource: "http://cdn.example.com/a.png" }).success, false);
  assert.equal(file.safeParse({ action: "create", originalSource: "https://cdn.example.com/a.png", contentType: "IMAGE" }).success, true);
  assert.equal(file.safeParse({ action: "delete", ids: ["gid://shopify/Product/1"] }).success, false);
  assert.equal(file.safeParse({ action: "delete", ids: ["gid://shopify/MediaImage/1x"] }).success, false);
  assert.equal(file.safeParse({ action: "delete", ids: Array.from({ length: 51 }, (_, i) => `gid://shopify/MediaImage/${i + 1}`) }).success, false);
  assert.equal(file.safeParse({ action: "delete", ids: ["gid://shopify/GenericFile/1"] }).success, true);
  const draft = operationSchema("draft_order");
  assert.equal(draft.safeParse({ action: "delete", id: "gid://shopify/Order/1" }).success, false);
  assert.equal(draft.safeParse({ action: "update", id: "gid://shopify/DraftOrder/1", customerId: "bad" }).success, false);
  assert.equal(draft.safeParse({ action: "update", id: "gid://shopify/DraftOrder/1", note: "hi" }).success, true);
});

async function signedInClient(t, respond) {
  const requests = await shopifyMock(t, (body) => {
    const q = body.query ?? "";
    if (/StoreCapabilities/.test(q))
      return { body: { data: { shop: { id: "gid://shopify/Shop/1", name: "Mock", myshopifyDomain: "main.myshopify.com" }, currentAppInstallation: { id: "x", accessScopes: [{ handle: "write_draft_orders" }, { handle: "write_files" }, { handle: "read_orders" }, { handle: "read_marketing_events" }] } } } };
    return respond(body);
  });
  const { app } = await setup(t);
  const token = (await login(app, "pat@bariatricpal.com", { alias: "main", token: "pat-online-main" })).accessToken;
  return { requests, client: await mcpClient(t, app, token) };
}

const manage = (client, operation, input, extra = {}) => client.callTool({ name: "shopify_manage", arguments: { store: "main", operation, input, ...extra } });
const writes = (requests, from) => requests.slice(from).filter((r) => /mutation/.test(r.body.query ?? "") && !/Calculate/.test(r.body.query));

test("dryRun sends no mutation; delete needs confirm; completed drafts are refused", async (t) => {
  const draft = (id, status) => ({ id, name: "#D1", status, order: status === "COMPLETED" ? { id: "gid://shopify/Order/9", name: "#1009" } : null, lineItems: { nodes: [] } });
  const { requests, client } = await signedInClient(t, (body) => {
    const q = body.query ?? "";
    if (/DraftOrderEditState/.test(q)) return { body: { data: { draftOrder: body.variables.id.endsWith("/2") ? draft(body.variables.id, "COMPLETED") : draft(body.variables.id, "OPEN") } } };
    if (/DraftOrderRemove/.test(q)) return { body: { data: { draftOrderDelete: { deletedId: body.variables.input.id, userErrors: [] } } } };
    if (/DraftOrderEdit\b/.test(q)) return { body: { data: { draftOrderUpdate: { draftOrder: { id: body.variables.id }, userErrors: [] } } } };
    if (/FilesRead/.test(q)) return { body: { data: { nodes: body.variables.ids.map((id) => ({ id, __typename: "MediaImage", alt: "a", fileStatus: "READY" })) } } };
    if (/FileAdd/.test(q)) return { body: { data: { fileCreate: { files: [{ id: "gid://shopify/GenericFile/5", fileStatus: "UPLOADED" }], userErrors: [] } } } };
    if (/FileRemove/.test(q)) return { body: { data: { fileDelete: { deletedFileIds: body.variables.fileIds, userErrors: [] } } } };
    return undefined;
  });

  // dryRun (default): reads only.
  const before = requests.length;
  for (const [op, input] of [
    ["draft_order", { action: "update", id: "gid://shopify/DraftOrder/1", note: "n" }],
    ["draft_order", { action: "delete", id: "gid://shopify/DraftOrder/1" }],
    ["file", { action: "create", originalSource: "https://cdn.example.com/a.pdf" }],
    ["file", { action: "update", id: "gid://shopify/MediaImage/1", alt: "x" }],
    ["file", { action: "delete", ids: ["gid://shopify/MediaImage/1"] }],
  ]) {
    const r = await manage(client, op, input);
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(JSON.parse(r.content[0].text).dryRun, true);
  }
  assert.equal(writes(requests, before).length, 0, "dry runs send no mutation");

  // delete without confirm is refused before any request.
  for (const [op, input] of [["draft_order", { action: "delete", id: "gid://shopify/DraftOrder/1" }], ["file", { action: "delete", ids: ["gid://shopify/MediaImage/1"] }]]) {
    const mark = requests.length;
    const refused = await manage(client, op, input, { dryRun: false });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /requiredConfirm.*delete/);
    assert.equal(requests.length, mark, "no request sent");
  }

  // A completed draft order cannot be deleted or updated.
  const mark = requests.length;
  const completed = await manage(client, "draft_order", { action: "delete", id: "gid://shopify/DraftOrder/2" }, { dryRun: false, confirm: "delete" });
  assert.equal(completed.isError, true);
  assert.match(completed.content[0].text, /already completed/);
  assert.equal(writes(requests, mark).length, 0);

  // With confirm, the writes go through.
  const deleted = await manage(client, "draft_order", { action: "delete", id: "gid://shopify/DraftOrder/1" }, { dryRun: false, confirm: "delete" });
  assert.equal(JSON.parse(deleted.content[0].text).deleted, "gid://shopify/DraftOrder/1");
  const created = await manage(client, "file", { action: "create", originalSource: "https://cdn.example.com/a.pdf" }, { dryRun: false });
  assert.equal(JSON.parse(created.content[0].text).id, "gid://shopify/GenericFile/5");
  const gone = await manage(client, "file", { action: "delete", ids: ["gid://shopify/MediaImage/1"] }, { dryRun: false, confirm: "delete" });
  assert.deepEqual(JSON.parse(gone.content[0].text).deleted, ["gid://shopify/MediaImage/1"]);

  // Bad input is rejected with no request.
  const bad = requests.length;
  const http = await manage(client, "file", { action: "create", originalSource: "http://cdn.example.com/a.pdf" });
  assert.equal(http.isError, true);
  const gidBad = await manage(client, "draft_order", { action: "update", id: "nope", note: "x" });
  assert.equal(gidBad.isError, true);
  assert.equal(requests.length, bad);

  // The new resources are listed.
  const tools = (await client.listTools()).tools;
  assert.match(tools.find((tool) => tool.name === "shopify_search").description, /- marketing_events:/);
  assert.match(tools.find((tool) => tool.name === "shopify_search").description, /- abandoned_checkouts:/);
});
