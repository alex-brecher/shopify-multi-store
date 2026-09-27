import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { DOCS } from "./admin-documents.js";
import { workflow, WorkflowError, type Data } from "./admin-workflows.js";
import { mapConcurrent } from "./concurrency.js";
import { resolveStoreTargets } from "./config.js";
import { fitMultiStoreResults } from "./result-limits.js";
import {
  catalogGapReport,
  catalogHealth,
  compareCatalog,
  compareCollections,
  compareInventory,
  comparePrices,
  customerGrowth,
  duplicateSkuReport,
  fulfillmentSlaReport,
  getProductEverywhere,
  listUnfulfilledOrders,
  lowStockReport,
  orderSummary,
  portfolioSnapshot,
  recentProductChanges,
  storeLocations,
} from "./reports.js";

const StoreAlias = z.string().min(1).max(64);
const Sku = z.string().trim().min(1).max(255);
const Handle = z.string().trim().min(1).max(255).regex(/^[a-z0-9][a-z0-9-]*$/i);
const ANALYTICS_CHARACTER_LIMIT = 100_000;

/** Every report shopify_report runs, with what it needs. Keep in step with scope-requirements.ts. */
export const REPORTS = {
  portfolio_snapshot: "Shop identity and product, order, customer and location counts. stores optional (all stores).",
  store_locations: "Active, inactive, legacy, fulfillment, inventory and address status of locations. stores optional (all stores).",
  compare_inventory: "Inventory, price, status and catalog details for exact SKUs. Needs skus (1-50).",
  compare_prices: "Price and compare-at price for exact SKUs, with mismatches and missing variants. Needs skus (1-50).",
  get_product_everywhere: "One exact SKU or handle across stores. Needs identifier and matchBy (sku or handle).",
  compare_catalog: "Titles, status, vendor, type and inventory for exact product handles. Needs handles (1-50).",
  compare_collections: "Titles, sort order, product counts, SEO and images for exact collection handles. Needs handles (1-50).",
  catalog_gap_report: "Products missing or with different status across stores. first: products scanned per store (default 250).",
  catalog_health: "Missing vendor, type, SEO, media, alt text, and active products without inventory. first (default 100).",
  duplicate_sku_report: "SKUs repeated inside a store and shared across stores. first: variants scanned per store (default 250).",
  low_stock_report: "Active variants at or below threshold (default 10), separating low, zero and negative.",
  recent_product_changes: "Products updated in the last days (default 7). first (default 100).",
  list_unfulfilled_orders: "Recent open unfulfilled orders. days (default 7), first (default 25).",
  fulfillment_sla_report: "Open unfulfilled orders by age bucket and SLA breaches. lookbackDays (default 90), slaDays (default 2), first (default 100).",
  order_summary: "Order values, discounts, shipping, tax, cancellations and statuses; currencies separate. days (default 30), first (default 100).",
  customer_growth: "New customers in the current and previous period of days (default 30).",
  analytics: "Run one ShopifyQL query on each store and return columns, rows and a chart hint. Needs query and read_reports.",
} as const;
export type ReportName = keyof typeof REPORTS;
const REPORT_NAMES = Object.keys(REPORTS) as [ReportName, ...ReportName[]];

const ReportInput = z
  .object({
    report: z.enum(REPORT_NAMES).describe("Which report to run. See the tool description for each report's inputs."),
    stores: z.array(StoreAlias).min(1).max(100).optional().describe("Store aliases. Optional only for portfolio_snapshot and store_locations (then every store)."),
    skus: z.array(Sku).min(1).max(50).optional().describe("compare_inventory, compare_prices: exact SKUs."),
    handles: z.array(Handle).min(1).max(50).optional().describe("compare_catalog, compare_collections: exact handles."),
    identifier: z.string().trim().min(1).max(255).optional().describe("get_product_everywhere: the exact SKU or product handle."),
    matchBy: z.enum(["sku", "handle"]).optional().describe("get_product_everywhere: whether identifier is a SKU or a handle."),
    days: z.number().int().min(1).max(365).optional().describe("Lookback or period length in days."),
    lookbackDays: z.number().int().min(1).max(365).optional().describe("fulfillment_sla_report: how far back to look."),
    slaDays: z.number().int().min(1).max(90).optional().describe("fulfillment_sla_report: age after which the SLA is breached."),
    threshold: z.number().int().min(-1_000).max(100_000).optional().describe("low_stock_report: maximum aggregate quantity to include."),
    first: z.number().int().min(1).max(250).optional().describe("Rows per store; each report has its own default and maximum."),
    query: z.string().min(1).max(10_000).optional().describe("analytics: a ShopifyQL query."),
  })
  .strict();
type ReportArgs = z.infer<typeof ReportInput>;

function need<T>(value: T | undefined, name: string, report: string): T {
  if (value === undefined) throw new Error(`${report} needs ${name}.`);
  return value;
}
function stores(a: ReportArgs): string[] {
  return need(a.stores, "stores", a.report);
}
function capped(value: number | undefined, fallback: number, max: number, report: string): number {
  const result = value ?? fallback;
  if (result > max) throw new Error(`${report}: first may be at most ${max}.`);
  return result;
}

/** ShopifyQL on each store; per-store results like the other reports. */
async function analyticsReport(aliases: string[], query: string): Promise<Data> {
  const targets = await resolveStoreTargets(aliases);
  const results = await mapConcurrent(targets, async ({ requestedAlias, store, error }) => {
    if (!store) return { store: requestedAlias, ok: false, error: error ?? "Unknown store." };
    try {
      const w = await workflow(store.alias);
      await w.requireScopes(["read_reports"]);
      const d = await w.run(DOCS.analytics, { query });
      if (d.shopifyqlQuery?.parseErrors?.length)
        throw new WorkflowError("ShopifyQL parse errors.", { parseErrors: d.shopifyqlQuery.parseErrors });
      const table = d.shopifyqlQuery?.tableData;
      if (!table) throw new Error("ShopifyQL returned no table.");
      const x = table.columns.findIndex((c: Data) => /date|time|string/i.test(c.dataType));
      const ys = table.columns.flatMap((c: Data, i: number) => (/money|number|integer|float|decimal|percent/i.test(c.dataType) ? [i] : []));
      return {
        store: store.alias,
        ok: true,
        result: {
          ...table,
          rowCount: table.rows.length,
          currencyCode: d.shop?.currencyCode,
          timezone: d.shop?.ianaTimezone,
          ...(x >= 0 && ys.length
            ? { chartHint: { type: /TIMESERIES/i.test(query) ? "line" : "bar", xAxisColumnIndex: x, yAxisColumnIndices: ys } }
            : {}),
        },
      };
    } catch (caught) {
      return {
        store: store.alias,
        ok: false,
        error: caught instanceof Error ? caught.message : String(caught),
        ...(caught instanceof WorkflowError ? { details: caught.details } : {}),
      };
    }
  });
  return { query, ...fitMultiStoreResults(results, ANALYTICS_CHARACTER_LIMIT) };
}

export async function runReport(a: ReportArgs): Promise<Data> {
  const r = a.report;
  switch (r) {
    case "portfolio_snapshot":
      return portfolioSnapshot(a.stores);
    case "store_locations":
      return storeLocations(a.stores);
    case "compare_inventory":
      return compareInventory(stores(a), need(a.skus, "skus", r));
    case "compare_prices":
      return comparePrices(stores(a), need(a.skus, "skus", r));
    case "get_product_everywhere":
      return getProductEverywhere(stores(a), need(a.identifier, "identifier", r), need(a.matchBy, "matchBy", r));
    case "compare_catalog":
      return compareCatalog(stores(a), need(a.handles, "handles", r));
    case "compare_collections":
      return compareCollections(stores(a), need(a.handles, "handles", r));
    case "catalog_gap_report":
      return catalogGapReport(stores(a), capped(a.first, 250, 250, r));
    case "catalog_health":
      return catalogHealth(stores(a), capped(a.first, 100, 250, r));
    case "duplicate_sku_report":
      return duplicateSkuReport(stores(a), capped(a.first, 250, 250, r));
    case "low_stock_report":
      return lowStockReport(stores(a), a.threshold ?? 10);
    case "recent_product_changes":
      return recentProductChanges(stores(a), a.days ?? 7, capped(a.first, 100, 250, r));
    case "list_unfulfilled_orders":
      return listUnfulfilledOrders(stores(a), a.days ?? 7, capped(a.first, 25, 100, r));
    case "fulfillment_sla_report":
      return fulfillmentSlaReport(stores(a), a.lookbackDays ?? 90, a.slaDays ?? 2, capped(a.first, 100, 250, r));
    case "order_summary":
      return orderSummary(stores(a), a.days ?? 30, capped(a.first, 100, 250, r));
    case "customer_growth":
      return customerGrowth(stores(a), a.days ?? 30);
    case "analytics":
      return analyticsReport(stores(a), need(a.query, "query", r));
  }
}

export function registerReportTools(server: McpServer): void {
  server.registerTool(
    "shopify_report",
    {
      title: "Run a Shopify Report",
      description: `Run one read-only report across selected stores; each store returns its own result and completeness indicators. Reports:\n${Object.entries(REPORTS).map(([name, text]) => `- ${name}: ${text}`).join("\n")}`,
      inputSchema: ReportInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const value = { report: args.report, ...(await runReport(args)) };
        return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  );
}
