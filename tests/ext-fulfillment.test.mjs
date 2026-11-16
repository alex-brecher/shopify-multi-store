import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { buildClientSchema, parse, validate } from "graphql";
import { registerCommerceTools, MANAGE_OPERATIONS, operationSchema } from "../dist/commerce-tools.js";
import { registerReadTools } from "../dist/read-tools.js";
import { EXTRA_GET } from "../dist/extension-registry.js";
import { FULFILLMENT_DOCS, INVENTORY_DOCS, levelsDocument } from "../dist/extensions/fulfillment.js";

const raw = JSON.parse(gunzipSync(readFileSync(new URL("../schemas/admin-2026-07.json.gz", import.meta.url))));
const schema = buildClientSchema(raw.data ?? raw);
const gid = (type, id = 1) => `gid://shopify/${type}/${id}`;
const ALL_SCOPES = ["read_orders", "write_orders", "write_merchant_managed_fulfillment_orders", "read_inventory", "write_inventory", "read_products"];

function errorsOf(document) {
  return validate(schema, parse(document)).map((error) => error.message);
}

/** A tool server over a mocked Shopify: inventory levels, SKUs and one fulfillment held in `state`. */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ext-fulfillment-"));
  const saved = { fetch: globalThis.fetch, config: process.env.SHOPIFY_MULTI_STORE_CONFIG, token: process.env.SHOPIFY_TOKEN_FIXTURE };
  process.env.SHOPIFY_MULTI_STORE_CONFIG = join(directory, "stores.json");
  process.env.SHOPIFY_TOKEN_FIXTURE = "fixture-token";
  await writeFile(process.env.SHOPIFY_MULTI_STORE_CONFIG, JSON.stringify({ stores: [{ alias: "fixture", shop: "fixture.myshopify.com", apiVersion: "2026-07" }] }));
  t.after(async () => {
    globalThis.fetch = saved.fetch;
    if (saved.config === undefined) delete process.env.SHOPIFY_MULTI_STORE_CONFIG;
    else process.env.SHOPIFY_MULTI_STORE_CONFIG = saved.config;
    if (saved.token === undefined) delete process.env.SHOPIFY_TOKEN_FIXTURE;
    else process.env.SHOPIFY_TOKEN_FIXTURE = saved.token;
    await rm(directory, { recursive: true, force: true });
  });
  const tools = new Map();
  const server = { registerTool: (name, definition, callback) => tools.set(name, { definition, callback }) };
  registerCommerceTools(server);
  registerReadTools(server);

  const state = {
    requests: [],
    scopes: [...ALL_SCOPES],
    skus: { "TEE-S": [gid("InventoryItem", 1)], DUP: [gid("InventoryItem", 2), gid("InventoryItem", 3)] },
    // "item|location" to quantities; absent means not stocked there
    levels: {
      [`${gid("InventoryItem", 1)}|${gid("Location", 1)}`]: { available: 10, on_hand: 10 },
      [`${gid("InventoryItem", 1)}|${gid("Location", 2)}`]: { available: 3, on_hand: 3 },
      [`${gid("InventoryItem", 2)}|${gid("Location", 1)}`]: { available: 5, on_hand: 5 },
    },
    fulfillment: { id: gid("Fulfillment"), name: "#1001-F1", status: "SUCCESS", trackingInfo: [{ company: "UPS", number: "1Z1", url: "https://ups.example/1Z1" }] },
    canDeactivate: true,
  };
  const levelFor = (item, location) => {
    const q = state.levels[`${item}|${location}`];
    return q ? { id: gid("InventoryLevel", 9), isActive: true, canDeactivate: state.canDeactivate, deactivationAlert: "Removes 10 units", location: { id: location, name: `Loc ${location.split("/").pop()}` }, quantities: Object.entries(q).map(([name, quantity]) => ({ name, quantity })) } : null;
  };

  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const op = parse(body.query).definitions.find((d) => d.kind === "OperationDefinition");
    const name = op.name?.value;
    const v = body.variables ?? {};
    state.requests.push({ name, variables: v, mutation: op.operation === "mutation" });
    let data;
    if (name === "StoreCapabilities" || name === "ParityCapabilities") {
      data = { shop: { id: gid("Shop"), name: "Fixture", myshopifyDomain: "fixture.myshopify.com" }, currentAppInstallation: { id: gid("AppInstallation"), accessScopes: state.scopes.map((handle) => ({ handle })) } };
    } else if (name === "InventoryLevelsBatch") {
      data = {};
      op.variableDefinitions.filter((d) => d.variable.name.value.startsWith("i")).forEach((d) => {
        const n = d.variable.name.value.slice(1);
        const item = v[`i${n}`];
        const known = Object.values(state.skus).flat().includes(item);
        data[`r${n}`] = known ? { id: item, sku: "X", tracked: true, inventoryLevel: levelFor(item, v[`l${n}`]) } : null;
      });
    } else if (name === "InventoryItemsBySku") {
      const sku = /sku:"(.*)"/.exec(v.query)[1];
      data = { inventoryItems: { nodes: (state.skus[sku] ?? []).map((id) => ({ id, sku })) } };
    } else if (name === "GetFulfillment") {
      data = { fulfillment: v.id === state.fulfillment.id ? state.fulfillment : null };
    } else if (name === "UpdateFulfillmentTracking") {
      state.fulfillment = { ...state.fulfillment, trackingInfo: [{ company: v.tracking.company ?? "UPS", number: v.tracking.number ?? "1Z1", url: v.tracking.url ?? "https://ups.example/x" }] };
      data = { fulfillmentTrackingInfoUpdate: { fulfillment: state.fulfillment, userErrors: [] } };
    } else if (name === "CancelFulfillment") {
      state.fulfillment = { ...state.fulfillment, status: "CANCELLED" };
      data = { fulfillmentCancel: { fulfillment: { id: v.id, status: "CANCELLED" }, userErrors: [] } };
    } else if (name === "AdjustInventory") {
      for (const change of v.input.changes) state.levels[`${change.inventoryItemId}|${change.locationId}`][v.input.name] += change.delta;
      data = { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: gid("InventoryAdjustmentGroup"), createdAt: "2026-11-16T12:00:00Z", reason: v.input.reason, changes: [] }, userErrors: [] } };
    } else if (name === "DeactivateInventory") {
      delete state.levels[`${gid("InventoryItem", 1)}|${gid("Location", 2)}`];
      data = { inventoryDeactivate: { userErrors: [] } };
    } else {
      throw new Error(`Unmocked operation ${name}`);
    }
    return Response.json({ data });
  };

  const manage = async (operation, input = {}, dryRun = true, confirm) => {
    const tool = tools.get("shopify_manage");
    const result = await tool.callback(tool.definition.inputSchema.parse({ store: "fixture", operation, input, dryRun, ...(confirm ? { confirm } : {}) }));
    return { ...result, json: JSON.parse(result.content[0].text) };
  };
  const read = async (args) => {
    const tool = tools.get("shopify_get");
    const result = await tool.callback(tool.definition.inputSchema.parse({ store: "fixture", ...args }));
    return { ...result, json: JSON.parse(result.content[0].text) };
  };
  const mutations = () => state.requests.filter((r) => r.mutation);
  return { state, manage, read, mutations, tools };
}

test("every fulfillment and inventory document validates against Admin API 2026-07", () => {
  for (const [name, document] of [...Object.entries(FULFILLMENT_DOCS), ...Object.entries(INVENTORY_DOCS)]) assert.deepEqual(errorsOf(document), [], name);
  for (const names of [["available"], ["available", "on_hand"], ["damaged", "available"]])
    for (const inactive of [false, true]) assert.deepEqual(errorsOf(levelsDocument(3, names, inactive)), [], `${names} ${inactive}`);
  assert.throws(() => levelsDocument(0, ["available"]), /1 to 50/);
});

test("the fulfillment resource and both operations are registered with their scopes", () => {
  assert.deepEqual(EXTRA_GET.fulfillment.scopes, ["read_orders"]);
  assert.deepEqual(EXTRA_GET.fulfillment.types, ["Fulfillment"]);
  assert.deepEqual(MANAGE_OPERATIONS.fulfillment.scopes, ["read_orders", "write_merchant_managed_fulfillment_orders"]);
  assert.deepEqual(MANAGE_OPERATIONS.inventory.scopes, ["write_inventory"]);
  assert.equal(MANAGE_OPERATIONS.fulfillment.confirmWord({ action: "cancel" }), "cancel");
  assert.equal(MANAGE_OPERATIONS.fulfillment.confirmWord({ action: "update_tracking" }), undefined);
  assert.equal(MANAGE_OPERATIONS.inventory.confirmWord({ action: "deactivate" }), "deactivate");
  assert.equal(MANAGE_OPERATIONS.inventory.confirmWord({ action: "adjust" }), undefined);
});

test("zod rejects bad fulfillment and inventory input", () => {
  const fulfillment = operationSchema("fulfillment");
  const inventory = operationSchema("inventory");
  const okFulfillment = { action: "update_tracking", id: gid("Fulfillment"), number: "1Z" };
  assert.equal(fulfillment.safeParse(okFulfillment).success, true);
  assert.equal(fulfillment.safeParse(okFulfillment).data.notifyCustomer, false);
  for (const bad of [{ id: "nope" }, { id: gid("Order") }, { url: "http://insecure.example" }, { url: "https://u:p@x.example" }, { action: "refund" }, { company: "x".repeat(101) }, { extra: 1 }])
    assert.equal(fulfillment.safeParse({ ...okFulfillment, ...bad }).success, false, JSON.stringify(bad));
  const change = { sku: "TEE-S", locationId: gid("Location"), delta: -2 };
  assert.equal(inventory.safeParse({ action: "adjust", changes: [change] }).success, true);
  const many = (n) => Array.from({ length: n }, () => change);
  assert.equal(inventory.safeParse({ action: "adjust", changes: many(100) }).success, true);
  for (const bad of [
    { changes: many(101) }, { changes: [] }, { changes: [{ ...change, delta: 1.5 }] }, { changes: [{ ...change, delta: 0 }] },
    { changes: [{ ...change, locationId: "1" }] }, { changes: [{ ...change, extra: true }] }, { reason: "because" },
    { referenceDocumentUri: "not a uri" }, { items: [{ sku: "A", quantity: 0 }] }, { items: [{ sku: "A", quantity: 1.5 }] },
    { countryCodeOfOrigin: "usa" }, { harmonizedSystemCode: "12" }, { cost: -1 }, { action: "destroy" },
  ])
    assert.equal(inventory.safeParse({ action: "adjust", changes: [change], ...bad }).success, false, JSON.stringify(bad));
});

test("the fulfillment resource reads one fulfillment by GID", async (t) => {
  const { read, state } = await fixture(t);
  const ok = await read({ resource: "fulfillment", id: gid("Fulfillment") });
  assert.equal(ok.isError, undefined, JSON.stringify(ok.json));
  assert.equal(ok.json.name, "#1001-F1");
  assert.equal(ok.json.trackingInfo[0].number, "1Z1");
  const wrong = await read({ resource: "fulfillment", id: gid("Order") });
  assert.equal(wrong.isError, true);
  assert.equal(state.requests.filter((r) => r.mutation).length, 0);
});

test("update_tracking: dryRun sends no mutation, apply sends notifyCustomer false and reads back", async (t) => {
  const { manage, state, mutations } = await fixture(t);
  const input = { action: "update_tracking", id: gid("Fulfillment"), company: "FedEx", number: "999" };
  const preview = await manage("fulfillment", input);
  assert.equal(preview.json.dryRun, true);
  assert.equal(preview.json.currentTracking[0].number, "1Z1");
  assert.equal(preview.json.newTracking.number, "999");
  assert.equal(mutations().length, 0);
  const applied = await manage("fulfillment", input, false);
  assert.equal(applied.isError, undefined, JSON.stringify(applied.json));
  assert.equal(mutations().length, 1);
  assert.equal(mutations()[0].variables.notify, false);
  assert.equal(applied.json.after[0].number, "999");
  assert.equal(applied.json.verified, true);
  assert.equal(state.fulfillment.trackingInfo[0].company, "FedEx");
});

test("update_tracking needs something to change; a missing scope stops before any request", async (t) => {
  const { manage, state, mutations } = await fixture(t);
  const empty = await manage("fulfillment", { action: "update_tracking", id: gid("Fulfillment") }, false);
  assert.equal(empty.isError, true);
  assert.match(empty.json.error, /at least one of company, number or url/);
  state.scopes = state.scopes.filter((s) => s !== "write_merchant_managed_fulfillment_orders");
  const denied = await manage("fulfillment", { action: "update_tracking", id: gid("Fulfillment"), number: "1" }, false);
  assert.equal(denied.isError, true);
  assert.deepEqual(denied.json.missingScopes, ["write_merchant_managed_fulfillment_orders"]);
  assert.equal(mutations().length, 0);
});

test("cancel without confirm is refused; dryRun previews; confirm cancels and verifies", async (t) => {
  const { manage, state, mutations } = await fixture(t);
  const input = { action: "cancel", id: gid("Fulfillment") };
  const refused = await manage("fulfillment", input, false);
  assert.equal(refused.isError, true);
  assert.equal(refused.json.requiredConfirm, "cancel");
  assert.equal(state.requests.length, 0);
  const wrongWord = await manage("fulfillment", input, false, "yes");
  assert.equal(wrongWord.isError, true);
  assert.equal(state.requests.length, 0);
  const preview = await manage("fulfillment", input);
  assert.equal(preview.json.dryRun, true);
  assert.equal(preview.json.wouldCancel.status, "SUCCESS");
  assert.equal(mutations().length, 0);
  const done = await manage("fulfillment", input, false, "cancel");
  assert.equal(done.isError, undefined, JSON.stringify(done.json));
  assert.equal(done.json.after.status, "CANCELLED");
  assert.equal(mutations().length, 1);
  const again = await manage("fulfillment", input, false, "cancel");
  assert.match(again.json.error, /already cancelled/);
});

test("adjust: dryRun shows current and result per row and sends no mutation", async (t) => {
  const { manage, mutations } = await fixture(t);
  const preview = await manage("inventory", {
    action: "adjust",
    changes: [{ sku: "TEE-S", locationId: gid("Location", 1), delta: -4 }, { inventoryItemId: gid("InventoryItem", 1), locationId: gid("Location", 2), delta: 7 }],
  });
  assert.equal(preview.isError, undefined, JSON.stringify(preview.json));
  assert.equal(preview.json.dryRun, true);
  assert.deepEqual(preview.json.rows.map((r) => r.available), [{ current: 10, delta: -4, result: 6 }, { current: 3, delta: 7, result: 10 }]);
  assert.equal(mutations().length, 0);
});

test("adjust applies with changeFromQuantity, an idempotency key and a readback", async (t) => {
  const { manage, state, mutations } = await fixture(t);
  const done = await manage("inventory", { action: "adjust", reason: "cycle_count_available", referenceDocumentUri: "gid://my-app/CycleCount/1", changes: [{ sku: "TEE-S", locationId: gid("Location", 1), delta: -4 }] }, false);
  assert.equal(done.isError, undefined, JSON.stringify(done.json));
  const [mutation] = mutations();
  assert.equal(mutation.name, "AdjustInventory");
  assert.match(mutation.variables.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.deepEqual(mutation.variables.input.changes, [{ inventoryItemId: gid("InventoryItem", 1), locationId: gid("Location", 1), delta: -4, changeFromQuantity: 10 }]);
  assert.equal(mutation.variables.input.reason, "cycle_count_available");
  assert.equal(done.json.verified, true);
  assert.equal(state.levels[`${gid("InventoryItem", 1)}|${gid("Location", 1)}`].available, 6);
});

test("an ambiguous or unknown SKU is refused before any write", async (t) => {
  const { manage, mutations } = await fixture(t);
  const ambiguous = await manage("inventory", { action: "adjust", changes: [{ sku: "DUP", locationId: gid("Location", 1), delta: 1 }] }, false);
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.json.error, /ambiguous/);
  const unknown = await manage("inventory", { action: "adjust", changes: [{ sku: "NOPE", locationId: gid("Location", 1), delta: 1 }] }, false);
  assert.match(unknown.json.error, /matches no inventory item/);
  const both = await manage("inventory", { action: "adjust", changes: [{ sku: "TEE-S", inventoryItemId: gid("InventoryItem", 1), locationId: gid("Location", 1), delta: 1 }] }, false);
  assert.match(both.json.error, /exactly one of inventoryItemId or sku/);
  assert.equal(mutations().length, 0);
});

test("adjust refuses a result below zero, an unstocked location and a repeated pair", async (t) => {
  const { manage, mutations } = await fixture(t);
  const below = await manage("inventory", { action: "adjust", changes: [{ sku: "TEE-S", locationId: gid("Location", 1), delta: -11 }] }, false);
  assert.match(below.json.error, /below zero/);
  const unstocked = await manage("inventory", { action: "adjust", changes: [{ sku: "TEE-S", locationId: gid("Location", 9), delta: 1 }] }, false);
  assert.match(unstocked.json.error, /not stocked/);
  const twice = await manage("inventory", { action: "adjust", changes: [{ sku: "TEE-S", locationId: gid("Location", 1), delta: 1 }, { inventoryItemId: gid("InventoryItem", 1), locationId: gid("Location", 1), delta: 1 }] }, false);
  assert.match(twice.json.error, /more than once/);
  assert.equal(mutations().length, 0);
});

test("move larger than the available stock at the source is refused", async (t) => {
  const { manage, mutations } = await fixture(t);
  const input = { action: "move", fromLocationId: gid("Location", 1), toLocationId: gid("Location", 2), items: [{ sku: "TEE-S", quantity: 11 }] };
  const dry = await manage("inventory", input);
  assert.equal(dry.isError, true);
  assert.match(dry.json.error, /only 10 available at the source, cannot move 11/);
  const live = await manage("inventory", input, false);
  assert.equal(live.isError, true);
  assert.equal(mutations().length, 0);
  const same = await manage("inventory", { ...input, toLocationId: gid("Location", 1) });
  assert.match(same.json.error, /same location/);
  const unstockedTarget = await manage("inventory", { ...input, items: [{ sku: "TEE-S", quantity: 1 }], toLocationId: gid("Location", 9) });
  assert.match(unstockedTarget.json.error, /destination: not stocked/);
});

test("move previews both sides, then applies one atomic adjust and verifies", async (t) => {
  const { manage, state, mutations } = await fixture(t);
  const input = { action: "move", fromLocationId: gid("Location", 1), toLocationId: gid("Location", 2), items: [{ sku: "TEE-S", quantity: 4 }] };
  const preview = await manage("inventory", input);
  assert.equal(preview.isError, undefined, JSON.stringify(preview.json));
  assert.deepEqual(preview.json.rows[0].source.available, { current: 10, result: 6 });
  assert.deepEqual(preview.json.rows[0].destination.available, { current: 3, result: 7 });
  assert.equal(mutations().length, 0);
  const done = await manage("inventory", input, false);
  assert.equal(done.isError, undefined, JSON.stringify(done.json));
  assert.equal(mutations().length, 1);
  assert.deepEqual(mutations()[0].variables.input.changes.map((c) => c.delta), [-4, 4]);
  assert.equal(done.json.verified, true);
  assert.equal(state.levels[`${gid("InventoryItem", 1)}|${gid("Location", 2)}`].available, 7);
});

test("deactivate without confirm is refused; dryRun previews; confirm removes and verifies", async (t) => {
  const { manage, state, mutations } = await fixture(t);
  const input = { action: "deactivate", sku: "TEE-S", locationId: gid("Location", 2) };
  const refused = await manage("inventory", input, false);
  assert.equal(refused.isError, true);
  assert.equal(refused.json.requiredConfirm, "deactivate");
  assert.equal(state.requests.length, 0);
  const preview = await manage("inventory", input);
  assert.equal(preview.json.dryRun, true);
  assert.deepEqual(preview.json.wouldDeactivate.quantitiesRemoved, { available: 3, on_hand: 3 });
  assert.equal(mutations().length, 0);
  state.canDeactivate = false;
  const blocked = await manage("inventory", input);
  assert.match(blocked.json.error, /does not allow deactivating/);
  state.canDeactivate = true;
  const done = await manage("inventory", input, false, "deactivate");
  assert.equal(done.isError, undefined, JSON.stringify(done.json));
  assert.equal(mutations().length, 1);
  assert.equal(mutations()[0].variables.level, gid("InventoryLevel", 9));
});

test("update_item and activate refuse empty or repeated requests before any write", async (t) => {
  const { manage, mutations } = await fixture(t);
  const empty = await manage("inventory", { action: "update_item", sku: "TEE-S" }, false);
  assert.match(empty.json.error, /at least one of tracked, cost/);
  const active = await manage("inventory", { action: "activate", sku: "TEE-S", locationId: gid("Location", 1) }, false);
  assert.match(active.json.error, /already stocked/);
  const noLocation = await manage("inventory", { action: "activate", sku: "TEE-S" }, false);
  assert.match(noLocation.json.error, /needs locationId/);
  assert.equal(mutations().length, 0);
});
