import { z } from "zod/v4";
import { findStore } from "./config.js";
import { adminGraphql } from "./shopify.js";
const Store = z.string().min(1).max(64).describe("Configured store alias");
function ok(value) {
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
function fail(error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}
/** GraphQL top-level errors or mutation userErrors, as one message, or undefined. */
function problems(result) {
    const list = [...(Array.isArray(result.errors) ? result.errors : []), ...(result.userErrors ?? [])];
    if (!list.length)
        return undefined;
    return list.map((item) => `${item.field ? `${JSON.stringify(item.field)}: ` : ""}${item.message ?? JSON.stringify(item)}`).join("; ");
}
async function run(store, document, variables = {}) {
    const result = await adminGraphql(store, document, variables);
    const problem = problems(result);
    if (problem)
        throw new Error(`Shopify refused the request on ${store.alias}: ${problem}`);
    return (result.data ?? {});
}
// ---------- bulk export ----------
const money = "shopMoney { amount currencyCode }";
/** One bulk query per resource. FILTER is replaced by the search filter argument, or removed. */
export const EXPORT_QUERIES = {
    orders: `{ orders(FILTER) { edges { node { id name createdAt processedAt updatedAt cancelledAt closedAt displayFinancialStatus displayFulfillmentStatus currencyCode sourceName tags email
  totalPriceSet { ${money} } subtotalPriceSet { ${money} } totalTaxSet { ${money} } totalDiscountsSet { ${money} } totalShippingPriceSet { ${money} } totalRefundedSet { ${money} }
  customer { id } shippingAddress { city provinceCode countryCodeV2 zip }
  lineItems { edges { node { id sku name quantity variant { id } product { id } originalUnitPriceSet { ${money} } discountedTotalSet { ${money} } } } } } } } }`,
    products: `{ products(FILTER) { edges { node { id title handle status vendor productType tags createdAt updatedAt publishedAt totalInventory
  variants { edges { node { id sku title price compareAtPrice barcode inventoryQuantity inventoryItem { id unitCost { amount currencyCode } } } } } } } } }`,
    variants: `{ productVariants(FILTER) { edges { node { id sku title price compareAtPrice barcode inventoryQuantity product { id title handle status vendor } inventoryItem { id tracked unitCost { amount currencyCode } } } } } }`,
    customers: `{ customers(FILTER) { edges { node { id firstName lastName createdAt updatedAt numberOfOrders tags note verifiedEmail
  amountSpent { amount currencyCode } defaultEmailAddress { emailAddress marketingState } defaultPhoneNumber { phoneNumber } defaultAddress { city provinceCode countryCodeV2 zip } } } } }`,
    inventory: `{ inventoryItems(FILTER) { edges { node { id sku tracked unitCost { amount currencyCode } variant { id product { id title } }
  inventoryLevels { edges { node { id location { id name } quantities(names: ["available", "on_hand", "committed", "incoming", "reserved"]) { name quantity } } } } } } } }`,
    collections: `{ collections(FILTER) { edges { node { id title handle updatedAt sortOrder productsCount { count } ruleSet { appliedDisjunctively } } } } }`,
    draft_orders: `{ draftOrders(FILTER) { edges { node { id name status createdAt updatedAt completedAt tags email totalPriceSet { ${money} } customer { id } order { id }
  lineItems { edges { node { id sku name quantity variant { id } } } } } } } }`
};
export function exportQuery(resource, filter) {
    const template = EXPORT_QUERIES[resource];
    if (!template)
        throw new Error(`Unknown resource ${resource}.`);
    // Bulk queries take no variables, so the filter goes in as a GraphQL string literal.
    return template.replace("(FILTER)", filter ? `(query: ${JSON.stringify(filter)})` : "");
}
const BULK_FIELDS = "id status type errorCode createdAt completedAt objectCount rootObjectCount fileSize url partialDataUrl query";
const BULK_ID = /^gid:\/\/shopify\/BulkOperation\/\d+$/;
const DONE = new Set(["COMPLETED", "FAILED", "CANCELED", "EXPIRED"]);
const ExportInput = z.object({
    store: Store,
    action: z.enum(["start", "status", "cancel"]).default("start").describe("start (default), status, or cancel"),
    resource: z.enum(["orders", "products", "variants", "customers", "inventory", "collections", "draft_orders", "custom"]).optional()
        .describe("start: what to export. custom needs query."),
    filter: z.string().max(1000).optional().describe("start: Shopify search filter, such as \"created_at:>=2026-10-01\" or \"status:active\""),
    query: z.string().max(10_000).optional().describe("start with resource custom: your own bulk query (one top-level connection, no variables)"),
    id: z.string().max(100).optional().describe("status/cancel: BulkOperation GID from start"),
    waitSeconds: z.number().int().min(0).max(50).default(25).describe("start/status: wait up to this long for the export to finish"),
    sampleRows: z.number().int().min(0).max(20).default(0).describe("When finished: also return the first rows of the file")
}).strict();
async function bulkStatus(store, id) {
    return (await run(store, `query Bulk($id: ID!) { node(id: $id) { ... on BulkOperation { ${BULK_FIELDS} } } }`, { id })).node ?? {};
}
async function waitFor(store, id, seconds, sleep) {
    const until = Date.now() + seconds * 1000;
    let op = await bulkStatus(store, id);
    while (!DONE.has(op.status) && Date.now() < until) {
        await sleep(Math.min(2000, Math.max(0, until - Date.now())));
        op = await bulkStatus(store, id);
    }
    return op;
}
async function sample(url, rows) {
    const response = await fetch(url, { headers: { range: "bytes=0-65535" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok && response.status !== 206)
        return [];
    return (await response.text()).split("\n").slice(0, rows).filter(Boolean).flatMap((line) => {
        try {
            return [JSON.parse(line)];
        }
        catch {
            return [];
        }
    });
}
function describe(op, store) {
    const finished = DONE.has(op.status);
    return {
        store: store.alias,
        shop: store.shop,
        id: op.id,
        status: op.status,
        ...(op.errorCode ? { errorCode: op.errorCode } : {}),
        objectCount: op.objectCount !== undefined ? Number(op.objectCount) : undefined,
        rootObjectCount: op.rootObjectCount !== undefined ? Number(op.rootObjectCount) : undefined,
        fileSize: op.fileSize !== undefined && op.fileSize !== null ? Number(op.fileSize) : undefined,
        createdAt: op.createdAt,
        completedAt: op.completedAt,
        ...(op.url ? { url: op.url } : {}),
        ...(op.partialDataUrl ? { partialDataUrl: op.partialDataUrl } : {}),
        ...(op.status === "COMPLETED" && !op.url ? { note: "Finished with no rows: nothing matched." } : {}),
        ...(op.url ? { format: "JSONL: one object per line; nested rows (line items, variants, inventory levels) are their own lines with __parentId pointing at their parent. The link expires after 7 days. Anyone with the link can download the file, so share it carefully." } : {}),
        ...(!finished ? { next: `Still ${String(op.status).toLowerCase()}. Call shopify_bulk_export with action:"status" and id:"${op.id}" to check again.` } : {})
    };
}
export async function bulkExport(a, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    const store = await findStore(a.store);
    if (a.action === "status" || a.action === "cancel") {
        if (!a.id || !BULK_ID.test(a.id))
            throw new Error(`${a.action} needs id, a BulkOperation GID from start.`);
        if (a.action === "cancel") {
            const data = await run(store, `mutation Cancel($id: ID!) { bulkOperationCancel(id: $id) { bulkOperation { ${BULK_FIELDS} } userErrors { field message } } }`, { id: a.id });
            return describe(data.bulkOperationCancel?.bulkOperation ?? {}, store);
        }
        const op = await waitFor(store, a.id, a.waitSeconds, sleep);
        const out = describe(op, store);
        if (op.url && a.sampleRows)
            out.sample = await sample(op.url, a.sampleRows);
        return out;
    }
    if (!a.resource)
        throw new Error("start needs resource.");
    if (a.resource === "custom" ? !a.query : a.query)
        throw new Error("Give query only with resource custom.");
    if (a.resource === "custom" && a.filter)
        throw new Error("With resource custom, put the filter in your query.");
    const query = a.resource === "custom" ? a.query : exportQuery(a.resource, a.filter);
    const data = await run(store, `mutation Export($query: String!) { bulkOperationRunQuery(query: $query) { bulkOperation { ${BULK_FIELDS} } userErrors { field message code } } }`, { query });
    const started = data.bulkOperationRunQuery?.bulkOperation;
    if (!started?.id)
        throw new Error(`Shopify did not start the export on ${store.alias}.`);
    const op = a.waitSeconds ? await waitFor(store, started.id, a.waitSeconds, sleep) : started;
    const out = { resource: a.resource, ...(a.filter ? { filter: a.filter } : {}), ...describe(op, store) };
    if (op.url && a.sampleRows)
        out.sample = await sample(op.url, a.sampleRows);
    return out;
}
export function registerOpsTools(server) {
    server.registerTool("shopify_bulk_export", {
        title: "Bulk Export",
        description: "Export a whole resource from one store in one step, with no pagination or size limit: orders, products, variants, customers, inventory (levels per location), collections or draft orders, with an optional Shopify search filter such as \"created_at:>=2026-10-01\". Starts a Shopify bulk operation, waits up to waitSeconds, and returns the JSONL download URL (valid 7 days) and row counts; sampleRows also returns the first rows. Large stores can take minutes: call again with action:\"status\" and the id. resource custom runs your own bulk query. Changes nothing in the store.",
        inputSchema: ExportInput,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
        try {
            return ok(await bulkExport(args));
        }
        catch (error) {
            return fail(error);
        }
    });
}
//# sourceMappingURL=ops-tools.js.map