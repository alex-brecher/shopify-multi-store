import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { registerGetResource, registerManageOperation } from "../extension-registry.js";
import { WorkflowError, type Data, type Workflow } from "../admin-workflows.js";

// Fulfillment records (tracking, cancel) and inventory changes beyond shopify_set_inventory:
// relative adjustments, location-to-location moves, state moves, inventory item fields and
// stocking an item at a location.

const gid = (type: string) => z.string().regex(new RegExp(`^gid://shopify/${type}/[0-9]+$`));
const PREVIEW = "Nothing was changed. Pass dryRun:false to apply.";

const FULFILLMENT_FIELDS = `id name status displayStatus createdAt updatedAt deliveredAt inTransitAt totalQuantity
  location { id name } order { id name }
  trackingInfo { company number url }
  fulfillmentLineItems(first: 50) { nodes { id quantity lineItem { id title sku } } pageInfo { hasNextPage } }`;

const CHANGE_FIELDS = `inventoryAdjustmentGroup { id createdAt reason referenceDocumentUri changes { name delta quantityAfterChange item { id } location { id } } }`;

/** Item fields read before and after inventoryItemUpdate. */
const ITEM_FIELDS = `id sku tracked requiresShipping unitCost { amount currencyCode } countryCodeOfOrigin provinceCodeOfOrigin harmonizedSystemCode trackedEditable { locked reason }`;

export const FULFILLMENT_DOCS = {
  get: `query GetFulfillment($id: ID!) { fulfillment(id: $id) { ${FULFILLMENT_FIELDS} } }`,
  trackingUpdate: `mutation UpdateFulfillmentTracking($id: ID!, $tracking: FulfillmentTrackingInput!, $notify: Boolean) {
  fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $tracking, notifyCustomer: $notify) {
    fulfillment { id status trackingInfo { company number url } } userErrors { field message }
  }
}`,
  cancel: `mutation CancelFulfillment($id: ID!) { fulfillmentCancel(id: $id) { fulfillment { id status } userErrors { field message } } }`,
};

export const INVENTORY_DOCS = {
  bySku: `query InventoryItemsBySku($query: String!) { inventoryItems(first: 10, query: $query) { nodes { id sku } } }`,
  item: `query InventoryItemFields($id: ID!) { inventoryItem(id: $id) { ${ITEM_FIELDS} } }`,
  adjust: `mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) { ${CHANGE_FIELDS} userErrors { field message code } }
}`,
  moveStates: `mutation MoveInventoryStates($input: InventoryMoveQuantitiesInput!, $idempotencyKey: String!) {
  inventoryMoveQuantities(input: $input) @idempotent(key: $idempotencyKey) { ${CHANGE_FIELDS} userErrors { field message code } }
}`,
  updateItem: `mutation UpdateInventoryItem($id: ID!, $input: InventoryItemInput!) {
  inventoryItemUpdate(id: $id, input: $input) { inventoryItem { ${ITEM_FIELDS} } userErrors { field message } }
}`,
  activate: `mutation ActivateInventory($item: ID!, $location: ID!, $available: Int) {
  inventoryActivate(inventoryItemId: $item, locationId: $location, available: $available) { inventoryLevel { id isActive location { id name } } userErrors { field message } }
}`,
  deactivate: `mutation DeactivateInventory($level: ID!) { inventoryDeactivate(inventoryLevelId: $level) { userErrors { field message } } }`,
};

const QUANTITY_NAMES = ["available", "on_hand", "damaged", "quality_control", "reserved", "safety_stock"] as const;
type QuantityName = (typeof QUANTITY_NAMES)[number];

/**
 * A batch read of inventory levels, n item and location pairs in one query. Names and the
 * includeInactive flag come from fixed lists, never from caller text.
 */
export function levelsDocument(n: number, names: readonly QuantityName[], includeInactive = false): string {
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("levelsDocument needs 1 to 50 pairs.");
  const variables = Array.from({ length: n }, (_, i) => `$i${i}: ID!, $l${i}: ID!`).join(", ");
  const fields = Array.from(
    { length: n },
    (_, i) => `r${i}: inventoryItem(id: $i${i}) { id sku tracked inventoryLevel(locationId: $l${i}, includeInactive: ${includeInactive}) { id isActive canDeactivate deactivationAlert location { id name } quantities(names: ${JSON.stringify(names)}) { name quantity } } }`,
  ).join("\n  ");
  return `query InventoryLevelsBatch(${variables}) {\n  ${fields}\n}`;
}

// ---------------------------------------------------------------- fulfillment

registerGetResource("fulfillment", {
  document: FULFILLMENT_DOCS.get,
  root: "fulfillment",
  types: ["Fulfillment"],
  label: "Fulfillment",
  scopes: ["read_orders"],
  description: "One fulfillment: status, tracking info (company, number, url), line items, location and createdAt. id: Fulfillment GID (from the order's fulfillments).",
});

const httpsUrl = z.string().max(2000).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}, "url must be an https:// URL without user name or password");

registerManageOperation("fulfillment", {
  description:
    "Change tracking on a fulfillment (update_tracking, fulfillmentTrackingInfoUpdate) or cancel it (cancel, fulfillmentCancel). Cancel reverses the fulfillment and reopens its items on new fulfillment orders; it needs confirm:\"cancel\". notifyCustomer defaults to false. Reads the fulfillment first. Needs a fulfillment-order write scope; write_merchant_managed_fulfillment_orders covers fulfillments of merchant-managed locations.",
  shape: {
    action: z.enum(["update_tracking", "cancel"]),
    id: gid("Fulfillment"),
    company: z.string().min(1).max(100).optional().describe("update_tracking: carrier name, such as UPS"),
    number: z.string().min(1).max(200).optional().describe("update_tracking: tracking number"),
    url: httpsUrl.optional().describe("update_tracking: tracking URL (Shopify builds one for a supported carrier name)"),
    notifyCustomer: z.boolean().default(false).describe("update_tracking: email the customer; default false"),
  },
  scopes: ["read_orders", "write_merchant_managed_fulfillment_orders"],
  confirmWord: (a) => (a.action === "cancel" ? "cancel" : undefined),
  handler: async (w, a) => {
    const current = (await w.run(FULFILLMENT_DOCS.get, { id: a.id })).fulfillment;
    if (!current) throw Error(`Fulfillment ${a.id} was not found in this store.`);
    if (current.status === "CANCELLED") throw Error(`Fulfillment ${current.name ?? a.id} is already cancelled.`);

    if (a.action === "update_tracking") {
      const tracking: Data = {};
      for (const key of ["company", "number", "url"]) if (a[key] !== undefined) tracking[key] = a[key];
      if (!Object.keys(tracking).length) throw Error("update_tracking needs at least one of company, number or url.");
      if (a.dryRun)
        return { dryRun: true, fulfillment: current, currentTracking: current.trackingInfo, newTracking: tracking, notifyCustomer: a.notifyCustomer, message: PREVIEW };
      const d = await w.run(FULFILLMENT_DOCS.trackingUpdate, { id: a.id, tracking, notify: a.notifyCustomer });
      const after = (await w.run(FULFILLMENT_DOCS.get, { id: a.id })).fulfillment;
      const first = after?.trackingInfo?.[0];
      const verified = (tracking.number === undefined || first?.number === tracking.number) && (tracking.url === undefined || first?.url === tracking.url);
      return {
        dryRun: false,
        before: current.trackingInfo,
        after: after?.trackingInfo,
        notifyCustomer: a.notifyCustomer,
        verified,
        ...(verified ? {} : { warning: "Shopify's stored tracking differs from the request. Check the fulfillment." }),
        updated: d.fulfillmentTrackingInfoUpdate?.fulfillment,
      };
    }

    if (a.dryRun)
      return { dryRun: true, wouldCancel: current, message: 'Nothing was changed. Pass dryRun:false and confirm:"cancel" to apply. Cancelling reopens the items on new fulfillment orders.' };
    await w.run(FULFILLMENT_DOCS.cancel, { id: a.id });
    const after = (await w.run(FULFILLMENT_DOCS.get, { id: a.id })).fulfillment;
    if (after?.status !== "CANCELLED")
      throw new WorkflowError("Fulfillment readback did not show CANCELLED.", { id: a.id, after, completedSteps: w.completed });
    return { dryRun: false, before: current, after };
  },
});

// ---------------------------------------------------------------- inventory

/** Shopify's documented adjustment reasons for the available quantity. */
const REASONS = [
  "correction", "cycle_count_available", "damaged", "movement_created", "movement_updated", "movement_received",
  "movement_canceled", "other", "promotion", "quality_control", "received", "reservation_created",
  "reservation_deleted", "reservation_updated", "restock", "safety_stock", "shrinkage",
] as const;

const referenceUri = z
  .string()
  .max(500)
  .regex(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/, "referenceDocumentUri must be a URI such as gid://my-app/CycleCount/1 or https://example.com/doc/1");

const itemRef = {
  inventoryItemId: gid("InventoryItem").optional(),
  sku: z.string().min(1).max(255).optional(),
};
const adjustChange = z.object({ ...itemRef, locationId: gid("Location"), delta: z.number().int().min(-1_000_000_000).max(1_000_000_000).refine((n) => n !== 0, "delta cannot be 0") }).strict();
const moveItem = z.object({ ...itemRef, quantity: z.number().int().min(1).max(1_000_000_000) }).strict();

interface ItemRow {
  inventoryItemId: string;
  sku?: string;
}

/** Resolve each row to one inventory item. A SKU that matches no item or more than one is refused. */
async function resolveItems(w: Workflow, rows: Data[]): Promise<ItemRow[]> {
  const cache = new Map<string, Promise<string>>();
  const bySku = (sku: string) => {
    const key = sku.toLowerCase();
    if (!cache.has(key))
      cache.set(
        key,
        (async () => {
          const nodes = (await w.run(INVENTORY_DOCS.bySku, { query: `sku:${JSON.stringify(sku)}` })).inventoryItems?.nodes ?? [];
          const matches = nodes.filter((n: Data) => String(n.sku ?? "").toLowerCase() === key);
          if (matches.length === 0) throw Error(`SKU "${sku}" matches no inventory item. No change made.`);
          if (matches.length > 1) throw Error(`SKU "${sku}" is ambiguous: it matches ${matches.length} inventory items (${matches.map((m: Data) => m.id).join(", ")}). Use inventoryItemId. No change made.`);
          return matches[0].id as string;
        })(),
      );
    return cache.get(key)!;
  };
  const out: ItemRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (Boolean(row.inventoryItemId) === Boolean(row.sku)) throw Error(`Row ${index + 1}: give exactly one of inventoryItemId or sku.`);
    out.push(row.inventoryItemId ? { inventoryItemId: row.inventoryItemId } : { inventoryItemId: await bySku(row.sku), sku: row.sku });
  }
  return out;
}

interface Level {
  item: Data | null;
  level: Data | null;
  quantities: Record<string, number>;
}

/** Read the item and its level at a location for each pair, 25 pairs per request. */
async function readLevels(w: Workflow, pairs: { itemId: string; locationId: string }[], names: readonly QuantityName[], includeInactive = false): Promise<Level[]> {
  const out: Level[] = [];
  for (let start = 0; start < pairs.length; start += 25) {
    const chunk = pairs.slice(start, start + 25);
    const variables: Data = {};
    chunk.forEach((p, i) => {
      variables[`i${i}`] = p.itemId;
      variables[`l${i}`] = p.locationId;
    });
    const data = await w.run(levelsDocument(chunk.length, names, includeInactive), variables);
    chunk.forEach((_, i) => {
      const item = data[`r${i}`] ?? null;
      const level = item?.inventoryLevel ?? null;
      out.push({ item, level, quantities: Object.fromEntries((level?.quantities ?? []).map((q: Data) => [q.name, q.quantity])) });
    });
  }
  return out;
}

/** The problem with a level for a stock change, or undefined when it can take one. */
function levelProblem(label: string, found: Level, locationId: string): string | undefined {
  if (!found.item) return `${label}: inventory item not found.`;
  if (!found.item.tracked) return `${label}: inventory tracking is off for this item.`;
  if (!found.level || !found.level.isActive) return `${label}: not stocked at ${locationId}. Activate the item at that location first.`;
  return undefined;
}

function refuse(problems: string[]): never {
  throw Error(`${problems.join(" ")} No change made.`);
}

function noDuplicates(keys: string[], what: string): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw Error(`${what} appears more than once (${key}). Combine the rows. No change made.`);
    seen.add(key);
  }
}

function guardApply(group: Data | undefined, key: string, w: Workflow): void {
  if (!group?.id) throw new WorkflowError("Shopify returned no inventory adjustment group.", { idempotencyKey: key, completedSteps: w.completed });
}

const ITEM_UPDATE_KEYS = ["tracked", "cost", "countryCodeOfOrigin", "harmonizedSystemCode", "provinceCodeOfOrigin", "requiresShipping"] as const;

registerManageOperation("inventory", {
  description:
    "Inventory changes beyond shopify_set_inventory. adjust: up to 100 relative changes {inventoryItemId or sku, locationId, delta} (inventoryAdjustQuantities), each checked against the current quantity. move: items {inventoryItemId or sku, quantity} from fromLocationId to toLocationId, taken from available stock, done as one atomic adjust (inventoryMoveQuantities cannot cross locations). move_state: move quantity between states at one location, such as available to damaged (inventoryMoveQuantities; needs referenceDocumentUri). update_item: tracked, cost, countryCodeOfOrigin, harmonizedSystemCode, provinceCodeOfOrigin, requiresShipping (inventoryItemUpdate). activate: stock an item at a location (inventoryActivate). deactivate: remove an item from a location and its stock tracking there (inventoryDeactivate; needs confirm:\"deactivate\"). A SKU must match exactly one inventory item or the call is refused. Reads current quantities first; dryRun shows each row's before and after.",
  shape: {
    action: z.enum(["adjust", "move", "move_state", "update_item", "activate", "deactivate"]),
    changes: z.array(adjustChange).min(1).max(100).optional().describe("adjust"),
    items: z.array(moveItem).min(1).max(50).optional().describe("move and move_state"),
    quantityName: z.enum(["available", "on_hand"]).default("available").describe("adjust: which quantity changes"),
    reason: z.enum(REASONS).optional().describe("adjust, move and move_state; default correction (adjust, move_state) or movement_created (move)"),
    referenceDocumentUri: referenceUri.optional().describe("Audit trail URI; required for move_state"),
    fromLocationId: gid("Location").optional().describe("move"),
    toLocationId: gid("Location").optional().describe("move"),
    locationId: gid("Location").optional().describe("move_state, activate and deactivate"),
    fromState: z.enum(["available", "damaged", "quality_control", "reserved", "safety_stock"]).optional().describe("move_state"),
    toState: z.enum(["available", "damaged", "quality_control", "reserved", "safety_stock"]).optional().describe("move_state"),
    ...itemRef,
    tracked: z.boolean().optional().describe("update_item"),
    cost: z.number().min(0).max(1_000_000).optional().describe("update_item: unit cost in the shop currency"),
    countryCodeOfOrigin: z.string().regex(/^[A-Z]{2}$/).optional().describe("update_item: two-letter country code"),
    harmonizedSystemCode: z.string().regex(/^[0-9]{6,13}$/).optional().describe("update_item"),
    provinceCodeOfOrigin: z.string().regex(/^[A-Z0-9-]{1,6}$/).optional().describe("update_item"),
    requiresShipping: z.boolean().optional().describe("update_item"),
    available: z.number().int().min(0).max(1_000_000_000).optional().describe("activate: starting available quantity"),
  },
  scopes: ["write_inventory"],
  confirmWord: (a) => (a.action === "deactivate" ? "deactivate" : undefined),
  handler: async (w, a) => {
    switch (a.action) {
      case "adjust":
        return adjust(w, a);
      case "move":
        return moveBetweenLocations(w, a);
      case "move_state":
        return moveStates(w, a);
      case "update_item":
        return updateItem(w, a);
      case "activate":
        return activate(w, a);
      default:
        return deactivate(w, a);
    }
  },
});

async function adjust(w: Workflow, a: Data): Promise<Data> {
  if (!a.changes) throw Error("adjust needs changes.");
  const name: QuantityName = a.quantityName;
  const items = await resolveItems(w, a.changes);
  const rows = items.map((item, i) => ({ ...item, locationId: a.changes[i].locationId as string, delta: a.changes[i].delta as number }));
  noDuplicates(rows.map((r) => `${r.inventoryItemId} at ${r.locationId}`), "An item and location pair");
  const found = await readLevels(w, rows.map((r) => ({ itemId: r.inventoryItemId, locationId: r.locationId })), [name]);
  const problems: string[] = [];
  const preview = rows.map((row, i) => {
    const label = `Row ${i + 1} (${row.sku ?? row.inventoryItemId})`;
    const problem = levelProblem(label, found[i]!, row.locationId);
    const current = found[i]!.quantities[name];
    if (problem) problems.push(problem);
    else if (typeof current !== "number") problems.push(`${label}: no ${name} quantity at this location.`);
    else if (name === "available" && current + row.delta < 0) problems.push(`${label}: ${current} available, a change of ${row.delta} would go below zero.`);
    return { inventoryItemId: row.inventoryItemId, ...(row.sku ? { sku: row.sku } : {}), locationId: row.locationId, location: found[i]!.level?.location?.name, [name]: { current, delta: row.delta, result: typeof current === "number" ? current + row.delta : undefined } };
  });
  if (problems.length) refuse(problems);
  const reason = a.reason ?? "correction";
  if (a.dryRun) return { dryRun: true, reason, quantityName: name, rows: preview, message: PREVIEW };
  const idempotencyKey = randomUUID();
  const input = {
    reason,
    name,
    ...(a.referenceDocumentUri ? { referenceDocumentUri: a.referenceDocumentUri } : {}),
    changes: rows.map((row, i) => ({ inventoryItemId: row.inventoryItemId, locationId: row.locationId, delta: row.delta, changeFromQuantity: found[i]!.quantities[name] })),
  };
  const d = await w.run(INVENTORY_DOCS.adjust, { input, idempotencyKey });
  const group = d.inventoryAdjustQuantities?.inventoryAdjustmentGroup;
  guardApply(group, idempotencyKey, w);
  const after = await readLevels(w, rows.map((r) => ({ itemId: r.inventoryItemId, locationId: r.locationId })), [name]);
  const mismatched = rows.flatMap((row, i) => (after[i]!.quantities[name] === found[i]!.quantities[name]! + row.delta ? [] : [row.sku ?? row.inventoryItemId]));
  return {
    dryRun: false,
    idempotencyKey,
    adjustmentGroup: group,
    rows: preview.map((row, i) => ({ ...row, readBack: after[i]!.quantities[name] })),
    verified: mismatched.length === 0,
    ...(mismatched.length ? { warning: `Quantity differs from the expected result for ${mismatched.join(", ")}. Another change may have run at the same time.` } : {}),
  };
}

async function moveBetweenLocations(w: Workflow, a: Data): Promise<Data> {
  if (!a.items || !a.fromLocationId || !a.toLocationId) throw Error("move needs items, fromLocationId and toLocationId.");
  if (a.fromLocationId === a.toLocationId) throw Error("fromLocationId and toLocationId are the same location.");
  const items = await resolveItems(w, a.items);
  const rows = items.map((item, i) => ({ ...item, quantity: a.items[i].quantity as number }));
  noDuplicates(rows.map((r) => r.inventoryItemId), "An inventory item");
  const from = await readLevels(w, rows.map((r) => ({ itemId: r.inventoryItemId, locationId: a.fromLocationId })), ["available"]);
  const to = await readLevels(w, rows.map((r) => ({ itemId: r.inventoryItemId, locationId: a.toLocationId })), ["available"]);
  const problems: string[] = [];
  const preview = rows.map((row, i) => {
    const label = `Row ${i + 1} (${row.sku ?? row.inventoryItemId})`;
    const source = levelProblem(`${label} source`, from[i]!, a.fromLocationId);
    const target = levelProblem(`${label} destination`, to[i]!, a.toLocationId);
    const have = from[i]!.quantities.available;
    if (source) problems.push(source);
    else if (typeof have !== "number" || have < row.quantity) problems.push(`${label}: only ${have ?? 0} available at the source, cannot move ${row.quantity}.`);
    if (target) problems.push(target);
    const dest = to[i]!.quantities.available;
    return {
      inventoryItemId: row.inventoryItemId,
      ...(row.sku ? { sku: row.sku } : {}),
      quantity: row.quantity,
      source: { location: from[i]!.level?.location?.name, available: { current: have, result: typeof have === "number" ? have - row.quantity : undefined } },
      destination: { location: to[i]!.level?.location?.name, available: { current: dest, result: typeof dest === "number" ? dest + row.quantity : undefined } },
    };
  });
  if (problems.length) refuse(problems);
  const reason = a.reason ?? "movement_created";
  if (a.dryRun) return { dryRun: true, reason, rows: preview, message: PREVIEW };
  const idempotencyKey = randomUUID();
  const input = {
    reason,
    name: "available",
    ...(a.referenceDocumentUri ? { referenceDocumentUri: a.referenceDocumentUri } : {}),
    changes: rows.flatMap((row, i) => [
      { inventoryItemId: row.inventoryItemId, locationId: a.fromLocationId, delta: -row.quantity, changeFromQuantity: from[i]!.quantities.available },
      { inventoryItemId: row.inventoryItemId, locationId: a.toLocationId, delta: row.quantity, changeFromQuantity: to[i]!.quantities.available },
    ]),
  };
  const d = await w.run(INVENTORY_DOCS.adjust, { input, idempotencyKey });
  const group = d.inventoryAdjustQuantities?.inventoryAdjustmentGroup;
  guardApply(group, idempotencyKey, w);
  const afterFrom = await readLevels(w, rows.map((r) => ({ itemId: r.inventoryItemId, locationId: a.fromLocationId })), ["available"]);
  const afterTo = await readLevels(w, rows.map((r) => ({ itemId: r.inventoryItemId, locationId: a.toLocationId })), ["available"]);
  const mismatched = rows.flatMap((row, i) =>
    afterFrom[i]!.quantities.available === from[i]!.quantities.available! - row.quantity && afterTo[i]!.quantities.available === to[i]!.quantities.available! + row.quantity ? [] : [row.sku ?? row.inventoryItemId],
  );
  return {
    dryRun: false,
    idempotencyKey,
    adjustmentGroup: group,
    rows: preview,
    verified: mismatched.length === 0,
    ...(mismatched.length ? { warning: `Quantity differs from the expected result for ${mismatched.join(", ")}. Another change may have run at the same time.` } : {}),
  };
}

async function moveStates(w: Workflow, a: Data): Promise<Data> {
  if (!a.items || !a.locationId || !a.fromState || !a.toState) throw Error("move_state needs items, locationId, fromState and toState.");
  if (!a.referenceDocumentUri) throw Error("move_state needs referenceDocumentUri, such as gid://my-app/Recount/1.");
  if (a.referenceDocumentUri.startsWith("gid://shopify/")) throw Error("referenceDocumentUri cannot be a gid://shopify/ document.");
  if (a.fromState === a.toState) throw Error("fromState and toState are the same.");
  const items = await resolveItems(w, a.items);
  const rows = items.map((item, i) => ({ ...item, quantity: a.items[i].quantity as number }));
  noDuplicates(rows.map((r) => r.inventoryItemId), "An inventory item");
  const names = [a.fromState, a.toState] as QuantityName[];
  const found = await readLevels(w, rows.map((r) => ({ itemId: r.inventoryItemId, locationId: a.locationId })), names);
  const problems: string[] = [];
  const preview = rows.map((row, i) => {
    const label = `Row ${i + 1} (${row.sku ?? row.inventoryItemId})`;
    const problem = levelProblem(label, found[i]!, a.locationId);
    const have = found[i]!.quantities[a.fromState];
    if (problem) problems.push(problem);
    else if (typeof have !== "number" || have < row.quantity) problems.push(`${label}: only ${have ?? 0} ${a.fromState}, cannot move ${row.quantity}.`);
    const dest = found[i]!.quantities[a.toState];
    return {
      inventoryItemId: row.inventoryItemId,
      ...(row.sku ? { sku: row.sku } : {}),
      location: found[i]!.level?.location?.name,
      quantity: row.quantity,
      [a.fromState]: { current: have, result: typeof have === "number" ? have - row.quantity : undefined },
      [a.toState]: { current: dest, result: typeof dest === "number" ? dest + row.quantity : undefined },
    };
  });
  if (problems.length) refuse(problems);
  const reason = a.reason ?? "correction";
  if (a.dryRun) return { dryRun: true, reason, rows: preview, message: PREVIEW };
  const idempotencyKey = randomUUID();
  // Only the available state forbids a ledger document; every other state needs one.
  const end = (name: string) => ({ locationId: a.locationId, name, ...(name === "available" ? {} : { ledgerDocumentUri: a.referenceDocumentUri }) });
  const input = {
    reason,
    referenceDocumentUri: a.referenceDocumentUri,
    changes: rows.map((row, i) => ({ inventoryItemId: row.inventoryItemId, quantity: row.quantity, from: { ...end(a.fromState), changeFromQuantity: found[i]!.quantities[a.fromState] }, to: { ...end(a.toState), changeFromQuantity: found[i]!.quantities[a.toState] } })),
  };
  const d = await w.run(INVENTORY_DOCS.moveStates, { input, idempotencyKey });
  const group = d.inventoryMoveQuantities?.inventoryAdjustmentGroup;
  guardApply(group, idempotencyKey, w);
  const after = await readLevels(w, rows.map((r) => ({ itemId: r.inventoryItemId, locationId: a.locationId })), names);
  const mismatched = rows.flatMap((row, i) => (after[i]!.quantities[a.fromState] === found[i]!.quantities[a.fromState]! - row.quantity && after[i]!.quantities[a.toState] === found[i]!.quantities[a.toState]! + row.quantity ? [] : [row.sku ?? row.inventoryItemId]));
  return {
    dryRun: false,
    idempotencyKey,
    adjustmentGroup: group,
    rows: preview,
    verified: mismatched.length === 0,
    ...(mismatched.length ? { warning: `Quantity differs from the expected result for ${mismatched.join(", ")}.` } : {}),
  };
}

/** One inventory item from inventoryItemId or sku, for the single-item actions. */
async function singleItem(w: Workflow, a: Data): Promise<string> {
  const [item] = await resolveItems(w, [{ inventoryItemId: a.inventoryItemId, sku: a.sku }]);
  return item!.inventoryItemId;
}

async function updateItem(w: Workflow, a: Data): Promise<Data> {
  const changes: Data = {};
  for (const key of ITEM_UPDATE_KEYS) if (a[key] !== undefined) changes[key] = a[key];
  if (!Object.keys(changes).length) throw Error(`update_item needs at least one of ${ITEM_UPDATE_KEYS.join(", ")}.`);
  const id = await singleItem(w, a);
  const current = (await w.run(INVENTORY_DOCS.item, { id })).inventoryItem;
  if (!current) throw Error(`Inventory item ${id} was not found in this store.`);
  if (changes.tracked !== undefined && changes.tracked !== current.tracked && current.trackedEditable?.locked)
    throw Error(`tracked cannot be changed for this item: ${current.trackedEditable.reason ?? "locked by Shopify"}. No change made.`);
  const input: Data = { ...changes, ...(changes.cost !== undefined ? { cost: String(changes.cost) } : {}) };
  const before = { tracked: current.tracked, cost: current.unitCost?.amount, countryCodeOfOrigin: current.countryCodeOfOrigin, harmonizedSystemCode: current.harmonizedSystemCode, provinceCodeOfOrigin: current.provinceCodeOfOrigin, requiresShipping: current.requiresShipping };
  const diff = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, { from: (before as Data)[key], to: value }]));
  if (a.dryRun) return { dryRun: true, inventoryItemId: id, sku: current.sku, changes: diff, message: PREVIEW };
  const d = await w.run(INVENTORY_DOCS.updateItem, { id, input });
  const after = d.inventoryItemUpdate?.inventoryItem;
  const wrong = Object.entries(changes).filter(([key, value]) => {
    const got = key === "cost" ? after?.unitCost?.amount : after?.[key];
    return key === "cost" ? Number(got) !== value : got !== value;
  });
  return { dryRun: false, inventoryItemId: id, sku: current.sku, changes: diff, after, verified: wrong.length === 0, ...(wrong.length ? { warning: `Shopify returned a different value for ${wrong.map(([key]) => key).join(", ")}.` } : {}) };
}

async function activate(w: Workflow, a: Data): Promise<Data> {
  if (!a.locationId) throw Error("activate needs locationId.");
  const id = await singleItem(w, a);
  const [found] = await readLevels(w, [{ itemId: id, locationId: a.locationId }], ["available", "on_hand"], true);
  if (!found!.item) throw Error(`Inventory item ${id} was not found in this store.`);
  if (found!.level?.isActive) throw Error("The item is already stocked at this location. Use adjust to change its quantity. No change made.");
  if (a.dryRun) return { dryRun: true, inventoryItemId: id, sku: found!.item.sku, locationId: a.locationId, wouldStockAt: found!.level?.location?.name ?? a.locationId, ...(a.available !== undefined ? { available: a.available } : {}), message: PREVIEW };
  const d = await w.run(INVENTORY_DOCS.activate, { item: id, location: a.locationId, available: a.available });
  const [after] = await readLevels(w, [{ itemId: id, locationId: a.locationId }], ["available", "on_hand"]);
  if (!after!.level?.isActive) throw new WorkflowError("Activation readback did not show an active level.", { inventoryItemId: id, locationId: a.locationId, completedSteps: w.completed });
  return { dryRun: false, inventoryItemId: id, level: d.inventoryActivate?.inventoryLevel, quantities: after!.quantities };
}

async function deactivate(w: Workflow, a: Data): Promise<Data> {
  if (!a.locationId) throw Error("deactivate needs locationId.");
  const id = await singleItem(w, a);
  const [found] = await readLevels(w, [{ itemId: id, locationId: a.locationId }], ["available", "on_hand"]);
  if (!found!.item) throw Error(`Inventory item ${id} was not found in this store.`);
  if (!found!.level?.isActive) throw Error("The item is not stocked at this location. No change made.");
  if (!found!.level.canDeactivate) throw Error(`Shopify does not allow deactivating this item here: ${found!.level.deactivationAlert ?? "no reason given"}. No change made.`);
  const summary = { inventoryItemId: id, sku: found!.item.sku, location: found!.level.location, quantitiesRemoved: found!.quantities, alert: found!.level.deactivationAlert };
  if (a.dryRun) return { dryRun: true, wouldDeactivate: summary, message: 'Deactivating removes the item\'s stock tracking and quantities at this location. Nothing was changed. Pass dryRun:false and confirm:"deactivate" to apply.' };
  await w.run(INVENTORY_DOCS.deactivate, { level: found!.level.id });
  const [after] = await readLevels(w, [{ itemId: id, locationId: a.locationId }], ["available"]);
  if (after!.level?.isActive) throw new WorkflowError("Deactivation readback still shows an active level.", { inventoryItemId: id, locationId: a.locationId, completedSteps: w.completed });
  return { dryRun: false, deactivated: summary };
}
