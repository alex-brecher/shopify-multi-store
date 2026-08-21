import { loadStores } from "./config.js";
import { adminGraphql } from "./shopify.js";
const REPORT_CHARACTER_LIMIT = 150_000;
function responseWithinLimit(value) {
    if (JSON.stringify(value).length > REPORT_CHARACTER_LIMIT) {
        throw new Error(`The combined report exceeded ${REPORT_CHARACTER_LIMIT} characters. Request fewer stores, SKUs, handles, or rows.`);
    }
    return value;
}
async function selectedStores(aliases) {
    const configured = await loadStores();
    const byAlias = new Map(configured.map((store) => [store.alias.toLowerCase(), store]));
    const requested = aliases?.length ? [...new Set(aliases)] : configured.map((store) => store.alias);
    return requested.map((alias) => {
        const store = byAlias.get(alias.toLowerCase());
        return store
            ? { requestedAlias: alias, store }
            : { requestedAlias: alias, error: `Unknown store "${alias}". Available stores: ${configured.map((item) => item.alias).join(", ")}` };
    });
}
async function runReport(aliases, operation) {
    const selected = await selectedStores(aliases);
    const results = await Promise.all(selected.map(async ({ requestedAlias, store, error }) => {
        if (!store)
            return { store: requestedAlias, ok: false, error: error ?? "Unknown store." };
        try {
            const result = await operation(store);
            const hasGraphqlErrors = Array.isArray(result.errors) && result.errors.length > 0;
            return {
                store: store.alias,
                ok: !hasGraphqlErrors,
                result,
                ...(hasGraphqlErrors ? { error: "Shopify returned GraphQL errors. See result.errors." } : {})
            };
        }
        catch (caught) {
            return { store: store.alias, ok: false, error: caught instanceof Error ? caught.message : String(caught) };
        }
    }));
    return {
        count: results.length,
        succeeded: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
        results
    };
}
function searchValue(value) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
function nodesFrom(result, connection) {
    const data = result.result?.data;
    if (!data || typeof data !== "object")
        return [];
    const value = data[connection];
    if (!value || typeof value !== "object")
        return [];
    const nodes = value.nodes;
    return Array.isArray(nodes) ? nodes.filter((node) => Boolean(node) && typeof node === "object") : [];
}
export async function portfolioSnapshot(aliases) {
    const report = await runReport(aliases, (store) => adminGraphql(store, `query PortfolioSnapshot {
    shop { name myshopifyDomain currencyCode timezoneAbbreviation plan { displayName } }
    productsCount(limit: 10000) { count precision }
    activeProducts: productsCount(limit: 10000, query: "status:active") { count precision }
    draftProducts: productsCount(limit: 10000, query: "status:draft") { count precision }
    ordersCount(limit: 10000) { count precision }
    unfulfilledOrders: ordersCount(limit: 10000, query: "fulfillment_status:unfulfilled status:open") { count precision }
    customersCount(limit: 10000) { count precision }
    locationsCount(limit: 10000) { count precision }
  }`, {}));
    return responseWithinLimit({ generatedAt: new Date().toISOString(), ...report });
}
export async function compareInventory(aliases, skus) {
    const uniqueSkus = [...new Set(skus.map((sku) => sku.trim()).filter(Boolean))];
    const queryText = uniqueSkus.map((sku) => `sku:${searchValue(sku)}`).join(" OR ");
    const report = await runReport(aliases, (store) => adminGraphql(store, `query CompareInventory($query: String!) {
    productVariants(first: 100, query: $query, sortKey: SKU) {
      nodes {
        id
        sku
        title
        inventoryQuantity
        price
        compareAtPrice
        product { id title handle status vendor productType }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, { query: queryText }));
    const matrix = uniqueSkus.map((sku) => ({
        sku,
        stores: Object.fromEntries(report.results.map((result) => {
            const variants = nodesFrom(result, "productVariants").filter((variant) => String(variant.sku ?? "").toLowerCase() === sku.toLowerCase());
            return [result.store, variants];
        }))
    }));
    return responseWithinLimit({ requestedSkus: uniqueSkus, matrix, ...report });
}
export async function listUnfulfilledOrders(aliases, days, first) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const queryText = `created_at:>=${since} fulfillment_status:unfulfilled status:open`;
    const report = await runReport(aliases, (store) => adminGraphql(store, `query UnfulfilledOrders($first: Int!, $query: String!) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        updatedAt
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, { first, query: queryText }));
    return responseWithinLimit({ since, days, rowLimitPerStore: first, ...report });
}
export async function compareCatalog(aliases, handles) {
    const uniqueHandles = [...new Set(handles.map((handle) => handle.trim().toLowerCase()).filter(Boolean))];
    const queryText = uniqueHandles.map((handle) => `handle:${searchValue(handle)}`).join(" OR ");
    const report = await runReport(aliases, (store) => adminGraphql(store, `query CompareCatalog($query: String!) {
    products(first: 100, query: $query, sortKey: TITLE) {
      nodes {
        id
        handle
        title
        status
        vendor
        productType
        totalInventory
        updatedAt
        variants(first: 100) {
          nodes { id sku title price compareAtPrice inventoryQuantity }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, { query: queryText }));
    const matrix = uniqueHandles.map((handle) => {
        const stores = Object.fromEntries(report.results.map((result) => {
            const product = nodesFrom(result, "products").find((node) => String(node.handle ?? "").toLowerCase() === handle);
            return [result.store, product ?? null];
        }));
        const fingerprints = new Set(Object.values(stores).map((product) => product
            ? JSON.stringify({
                title: product.title,
                status: product.status,
                vendor: product.vendor,
                productType: product.productType,
                totalInventory: product.totalInventory,
                variants: product.variants
            })
            : "missing"));
        return { handle, consistent: fingerprints.size <= 1, stores };
    });
    return responseWithinLimit({ requestedHandles: uniqueHandles, differences: matrix.filter((row) => !row.consistent), matrix, ...report });
}
//# sourceMappingURL=reports.js.map