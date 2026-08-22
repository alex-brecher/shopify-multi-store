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
function connectionFrom(envelope, connection) {
    const data = envelope.data;
    if (!data || typeof data !== "object")
        return undefined;
    const value = data[connection];
    if (!value || typeof value !== "object")
        return undefined;
    const record = value;
    const nodes = Array.isArray(record.nodes)
        ? record.nodes.filter((node) => Boolean(node) && typeof node === "object")
        : [];
    const pageInfo = record.pageInfo;
    if (!pageInfo || typeof pageInfo !== "object")
        return undefined;
    const page = pageInfo;
    return {
        ...record,
        nodes,
        pageInfo: {
            hasNextPage: page.hasNextPage === true,
            endCursor: typeof page.endCursor === "string" ? page.endCursor : null
        }
    };
}
function withConnection(envelope, connection, value) {
    const data = envelope.data && typeof envelope.data === "object" ? envelope.data : {};
    return { ...envelope, data: { ...data, [connection]: value } };
}
function nextCursor(connection, store, label, previous) {
    if (!connection.pageInfo.hasNextPage)
        return undefined;
    const cursor = connection.pageInfo.endCursor;
    if (!cursor || cursor === previous) {
        throw new Error(`Shopify returned an invalid pagination cursor for ${label} on ${store.alias}.`);
    }
    return cursor;
}
async function paginatedConnection(store, document, variables, connectionName) {
    let after;
    let firstEnvelope;
    let firstConnection;
    const nodes = [];
    do {
        const envelope = await adminGraphql(store, document, { ...variables, after: after ?? null });
        firstEnvelope ??= envelope;
        if (Array.isArray(envelope.errors) && envelope.errors.length > 0)
            return envelope;
        const connection = connectionFrom(envelope, connectionName);
        if (!connection)
            throw new Error(`Shopify returned no ${connectionName} connection for ${store.alias}.`);
        firstConnection ??= connection;
        nodes.push(...connection.nodes);
        if (JSON.stringify(nodes).length > REPORT_CHARACTER_LIMIT) {
            throw new Error(`The complete ${connectionName} result exceeded ${REPORT_CHARACTER_LIMIT} characters for ${store.alias}. Request fewer values.`);
        }
        const previous = after;
        after = nextCursor(connection, store, connectionName, previous);
    } while (after);
    if (!firstEnvelope || !firstConnection)
        throw new Error(`Shopify returned no ${connectionName} data for ${store.alias}.`);
    return withConnection(firstEnvelope, connectionName, {
        ...firstConnection,
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null }
    });
}
async function completeCatalogVariants(store, envelope) {
    const products = connectionFrom(envelope, "products");
    if (!products)
        return envelope;
    for (const product of products.nodes) {
        const productId = product.id;
        const variantsValue = product.variants;
        if (typeof productId !== "string") {
            throw new Error(`Shopify returned a product without an ID while paginating variants for ${store.alias}.`);
        }
        if (!variantsValue || typeof variantsValue !== "object") {
            throw new Error(`Shopify returned no variant connection for ${String(productId)} on ${store.alias}.`);
        }
        const variantsRecord = variantsValue;
        const initialNodes = Array.isArray(variantsRecord.nodes)
            ? variantsRecord.nodes.filter((node) => Boolean(node) && typeof node === "object")
            : [];
        const pageInfoValue = variantsRecord.pageInfo;
        if (!pageInfoValue || typeof pageInfoValue !== "object") {
            throw new Error(`Shopify returned no variant page information for ${String(productId)} on ${store.alias}.`);
        }
        const initialPage = pageInfoValue;
        if (initialPage.hasNextPage === true && typeof initialPage.endCursor !== "string") {
            throw new Error(`Shopify returned an invalid pagination cursor for product variants on ${store.alias}.`);
        }
        let after = initialPage.hasNextPage === true && typeof initialPage.endCursor === "string" ? initialPage.endCursor : undefined;
        const variantNodes = [...initialNodes];
        while (after) {
            const page = await adminGraphql(store, `query CatalogVariantsPage($productId: ID!, $after: String) {
        product(id: $productId) {
          variants(first: 250, after: $after) {
            nodes { id sku title price compareAtPrice inventoryQuantity }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`, { productId, after });
            if (Array.isArray(page.errors) && page.errors.length > 0) {
                throw new Error(`Shopify returned GraphQL errors while paginating variants for ${store.alias}: ${JSON.stringify(page.errors).slice(0, 2_000)}`);
            }
            const data = page.data && typeof page.data === "object" ? page.data : {};
            if (!data.product || typeof data.product !== "object") {
                throw new Error(`Shopify returned no product while paginating variants for ${store.alias}.`);
            }
            const pageProduct = data.product;
            if (!pageProduct.variants || typeof pageProduct.variants !== "object") {
                throw new Error(`Shopify returned no variant connection while paginating ${String(productId)} on ${store.alias}.`);
            }
            const pageVariants = pageProduct.variants;
            const pageNodes = Array.isArray(pageVariants.nodes)
                ? pageVariants.nodes.filter((node) => Boolean(node) && typeof node === "object")
                : [];
            variantNodes.push(...pageNodes);
            if (JSON.stringify(variantNodes).length > REPORT_CHARACTER_LIMIT) {
                throw new Error(`The complete variant result exceeded ${REPORT_CHARACTER_LIMIT} characters for ${store.alias}. Request fewer product handles.`);
            }
            if (!pageVariants.pageInfo || typeof pageVariants.pageInfo !== "object") {
                throw new Error(`Shopify returned no variant page information while paginating ${String(productId)} on ${store.alias}.`);
            }
            const pageInfo = pageVariants.pageInfo;
            const next = pageInfo.hasNextPage === true && typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : undefined;
            if (pageInfo.hasNextPage === true && (!next || next === after)) {
                throw new Error(`Shopify returned an invalid pagination cursor for product variants on ${store.alias}.`);
            }
            after = next;
        }
        product.variants = {
            ...variantsRecord,
            nodes: variantNodes,
            pageInfo: { hasNextPage: false, endCursor: null }
        };
    }
    return withConnection(envelope, "products", products);
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
    const report = await runReport(aliases, (store) => paginatedConnection(store, `query CompareInventory($query: String!, $after: String) {
    productVariants(first: 250, after: $after, query: $query, sortKey: SKU) {
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
  }`, { query: queryText }, "productVariants"));
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
    const summaries = report.results.map((result) => {
        const orders = nodesFrom(result, "orders");
        const pageInfo = recordValue(connectionRecordFrom(result, "orders").pageInfo);
        return {
            store: result.store,
            ok: result.ok,
            returnedOrders: orders.length,
            complete: pageInfo?.hasNextPage !== true,
            truncated: pageInfo?.hasNextPage === true
        };
    });
    return responseWithinLimit({ since, days, rowLimitPerStore: first, summaries, ...report });
}
export async function compareCatalog(aliases, handles) {
    const uniqueHandles = [...new Set(handles.map((handle) => handle.trim().toLowerCase()).filter(Boolean))];
    const queryText = uniqueHandles.map((handle) => `handle:${searchValue(handle)}`).join(" OR ");
    const report = await runReport(aliases, async (store) => {
        const products = await paginatedConnection(store, `query CompareCatalog($query: String!, $after: String) {
    products(first: 250, after: $after, query: $query, sortKey: TITLE) {
      nodes {
        id
        handle
        title
        status
        vendor
        productType
        totalInventory
        updatedAt
        variants(first: 250) {
          nodes { id sku title price compareAtPrice inventoryQuantity }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, { query: queryText }, "products");
        return completeCatalogVariants(store, products);
    });
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
                variants: (() => {
                    const variants = recordValue(product.variants);
                    const nodes = Array.isArray(variants?.nodes)
                        ? variants.nodes.filter((variant) => Boolean(variant) && typeof variant === "object")
                        : [];
                    return nodes.map((variant) => ({
                        sku: variant.sku,
                        title: variant.title,
                        price: variant.price,
                        compareAtPrice: variant.compareAtPrice,
                        inventoryQuantity: variant.inventoryQuantity
                    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
                })()
            })
            : "missing"));
        return { handle, consistent: fingerprints.size <= 1, stores };
    });
    return responseWithinLimit({ requestedHandles: uniqueHandles, differences: matrix.filter((row) => !row.consistent), matrix, ...report });
}
function recordValue(value) {
    return value && typeof value === "object" ? value : undefined;
}
function dataFrom(result) {
    return recordValue(result.result?.data) ?? {};
}
function connectionRecordFrom(result, connection) {
    return recordValue(dataFrom(result)[connection]) ?? {};
}
function moneyFrom(value) {
    const set = recordValue(value);
    const shopMoney = recordValue(set?.shopMoney);
    const amount = Number(shopMoney?.amount);
    const currencyCode = shopMoney?.currencyCode;
    if (!Number.isFinite(amount) || typeof currencyCode !== "string")
        return undefined;
    return { amount, currencyCode };
}
function countValue(value) {
    const count = recordValue(value);
    return {
        count: typeof count?.count === "number" ? count.count : 0,
        ...(count?.precision !== undefined ? { precision: count.precision } : {})
    };
}
export async function orderSummary(aliases, days, first) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const queryText = `created_at:>=${since}`;
    const report = await runReport(aliases, (store) => adminGraphql(store, `query OrderSummary($first: Int!, $query: String!) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        currentTotalDiscountsSet { shopMoney { amount currencyCode } }
        currentShippingPriceSet { shopMoney { amount currencyCode } }
        currentTotalTaxSet { shopMoney { amount currencyCode } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, { first, query: queryText }));
    const summaries = report.results.map((result) => {
        const orders = nodesFrom(result, "orders");
        const statusCounts = { financial: {}, fulfillment: {} };
        const currencyTotals = {};
        let cancelled = 0;
        for (const order of orders) {
            const financial = String(order.displayFinancialStatus ?? "UNKNOWN");
            const fulfillment = String(order.displayFulfillmentStatus ?? "UNKNOWN");
            statusCounts.financial[financial] = (statusCounts.financial[financial] ?? 0) + 1;
            statusCounts.fulfillment[fulfillment] = (statusCounts.fulfillment[fulfillment] ?? 0) + 1;
            if (order.cancelledAt)
                cancelled += 1;
            const total = moneyFrom(order.currentTotalPriceSet);
            if (!total)
                continue;
            const bucket = currencyTotals[total.currencyCode] ?? { orders: 0, currentOrderValue: 0, discounts: 0, shipping: 0, tax: 0, averageOrderValue: 0 };
            bucket.orders += 1;
            bucket.currentOrderValue += total.amount;
            bucket.discounts += moneyFrom(order.currentTotalDiscountsSet)?.amount ?? 0;
            bucket.shipping += moneyFrom(order.currentShippingPriceSet)?.amount ?? 0;
            bucket.tax += moneyFrom(order.currentTotalTaxSet)?.amount ?? 0;
            bucket.averageOrderValue = bucket.orders ? bucket.currentOrderValue / bucket.orders : 0;
            currencyTotals[total.currencyCode] = bucket;
        }
        const pageInfo = recordValue(connectionRecordFrom(result, "orders").pageInfo);
        return {
            store: result.store,
            ok: result.ok,
            returnedOrders: orders.length,
            complete: pageInfo?.hasNextPage !== true,
            cancelledOrders: cancelled,
            statusCounts,
            currencyTotals
        };
    });
    return responseWithinLimit({ since, days, rowLimitPerStore: first, summaries, ...report });
}
export async function lowStockReport(aliases, threshold) {
    const queryText = `inventory_quantity:<=${threshold} product_status:ACTIVE`;
    const report = await runReport(aliases, (store) => paginatedConnection(store, `query LowStockReport($query: String!, $after: String) {
    productVariants(first: 250, after: $after, query: $query, sortKey: INVENTORY_QUANTITY) {
      nodes {
        id sku barcode title inventoryQuantity price inventoryPolicy
        product { id title handle status vendor productType }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, { query: queryText }, "productVariants"));
    const summaries = report.results.map((result) => {
        const variants = nodesFrom(result, "productVariants");
        return {
            store: result.store,
            ok: result.ok,
            variantsAtOrBelowThreshold: variants.length,
            outOfStock: variants.filter((variant) => Number(variant.inventoryQuantity) === 0).length,
            negativeInventory: variants.filter((variant) => Number(variant.inventoryQuantity) < 0).length,
            lowStock: variants.filter((variant) => Number(variant.inventoryQuantity) > 0).length
        };
    });
    return responseWithinLimit({ threshold, summaries, ...report });
}
export async function catalogHealth(aliases, first) {
    const report = await runReport(aliases, (store) => adminGraphql(store, `query CatalogHealth($first: Int!) {
    products(first: $first, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id title handle status vendor productType totalInventory tracksInventory updatedAt
        seo { title description }
        featuredMedia { alt }
        variantsCount { count precision }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, { first }));
    const summaries = report.results.map((result) => {
        const products = nodesFrom(result, "products");
        const issues = products.map((product) => {
            const productIssues = [];
            const seo = recordValue(product.seo);
            const featuredMedia = recordValue(product.featuredMedia);
            if (!String(product.vendor ?? "").trim())
                productIssues.push("missing_vendor");
            if (!String(product.productType ?? "").trim())
                productIssues.push("missing_product_type");
            if (!String(seo?.title ?? "").trim())
                productIssues.push("missing_seo_title");
            if (!String(seo?.description ?? "").trim())
                productIssues.push("missing_seo_description");
            if (!featuredMedia)
                productIssues.push("missing_featured_media");
            else if (!String(featuredMedia.alt ?? "").trim())
                productIssues.push("missing_featured_media_alt");
            if (product.status === "ACTIVE" && product.tracksInventory === true && Number(product.totalInventory) <= 0)
                productIssues.push("active_without_inventory");
            return productIssues.length ? { id: product.id, title: product.title, handle: product.handle, status: product.status, issues: productIssues } : null;
        }).filter(Boolean);
        const pageInfo = recordValue(connectionRecordFrom(result, "products").pageInfo);
        return {
            store: result.store,
            ok: result.ok,
            scannedProducts: products.length,
            complete: pageInfo?.hasNextPage !== true,
            productsWithIssues: issues.length,
            issues
        };
    });
    return responseWithinLimit({ rowLimitPerStore: first, summaries, ...report });
}
export async function recentProductChanges(aliases, days, first) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const report = await runReport(aliases, (store) => adminGraphql(store, `query RecentProductChanges($first: Int!, $query: String!) {
    products(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes { id title handle status vendor productType totalInventory createdAt updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  }`, { first, query: `updated_at:>=${since}` }));
    const summaries = report.results.map((result) => {
        const products = nodesFrom(result, "products");
        const pageInfo = recordValue(connectionRecordFrom(result, "products").pageInfo);
        return { store: result.store, ok: result.ok, returnedProducts: products.length, complete: pageInfo?.hasNextPage !== true };
    });
    return responseWithinLimit({ since, days, rowLimitPerStore: first, summaries, ...report });
}
export async function customerGrowth(aliases, days) {
    const now = Date.now();
    const currentSince = new Date(now - days * 86_400_000).toISOString();
    const previousSince = new Date(now - days * 2 * 86_400_000).toISOString();
    const report = await runReport(aliases, (store) => adminGraphql(store, `query CustomerGrowth($current: String!, $previous: String!) {
    shop { currencyCode }
    totalCustomers: customersCount(limit: 10000) { count precision }
    currentCustomers: customersCount(limit: 10000, query: $current) { count precision }
    previousCustomers: customersCount(limit: 10000, query: $previous) { count precision }
  }`, {
        current: `customer_date:>=${currentSince}`,
        previous: `customer_date:>=${previousSince} customer_date:<${currentSince}`
    }));
    const summaries = report.results.map((result) => {
        const data = dataFrom(result);
        const total = countValue(data.totalCustomers);
        const current = countValue(data.currentCustomers);
        const previous = countValue(data.previousCustomers);
        const change = current.count - previous.count;
        return {
            store: result.store,
            ok: result.ok,
            totalCustomers: total,
            currentPeriodNewCustomers: current,
            previousPeriodNewCustomers: previous,
            change,
            growthRate: previous.count ? change / previous.count : null
        };
    });
    return responseWithinLimit({ days, currentSince, previousSince, summaries, ...report });
}
export async function compareCollections(aliases, handles) {
    const uniqueHandles = [...new Set(handles.map((handle) => handle.trim().toLowerCase()).filter(Boolean))];
    const queryText = uniqueHandles.map((handle) => `handle:${searchValue(handle)}`).join(" OR ");
    const report = await runReport(aliases, (store) => paginatedConnection(store, `query CompareCollections($query: String!, $after: String) {
    collections(first: 250, after: $after, query: $query, sortKey: TITLE) {
      nodes {
        id handle title updatedAt sortOrder
        productsCount { count precision }
        seo { title description }
        image { altText url }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, { query: queryText }, "collections"));
    const matrix = uniqueHandles.map((handle) => {
        const stores = Object.fromEntries(report.results.map((result) => {
            const collection = nodesFrom(result, "collections").find((node) => String(node.handle ?? "").toLowerCase() === handle);
            return [result.store, collection ?? null];
        }));
        const fingerprints = new Set(Object.values(stores).map((collection) => collection ? JSON.stringify({
            title: collection.title,
            sortOrder: collection.sortOrder,
            productsCount: collection.productsCount,
            seo: collection.seo,
            image: collection.image
        }) : "missing"));
        return { handle, consistent: fingerprints.size <= 1, stores };
    });
    return responseWithinLimit({ requestedHandles: uniqueHandles, differences: matrix.filter((row) => !row.consistent), matrix, ...report });
}
export async function storeLocations(aliases) {
    const report = await runReport(aliases, (store) => paginatedConnection(store, `query StoreLocations($after: String) {
    locations(first: 250, after: $after, includeInactive: true, includeLegacy: true, sortKey: NAME) {
      nodes {
        id name deactivatedAt addressVerified fulfillsOnlineOrders hasActiveInventory
        address { address1 address2 city province provinceCode country countryCode zip formatted }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, {}, "locations"));
    const summaries = report.results.map((result) => {
        const locations = nodesFrom(result, "locations");
        return {
            store: result.store,
            ok: result.ok,
            locations: locations.length,
            active: locations.filter((location) => !location.deactivatedAt).length,
            inactive: locations.filter((location) => Boolean(location.deactivatedAt)).length,
            fulfillsOnlineOrders: locations.filter((location) => location.fulfillsOnlineOrders === true).length,
            withActiveInventory: locations.filter((location) => location.hasActiveInventory === true).length,
            unverifiedAddresses: locations.filter((location) => location.addressVerified === false).length
        };
    });
    return responseWithinLimit({ summaries, ...report });
}
export async function duplicateSkuReport(aliases, first) {
    const report = await runReport(aliases, (store) => adminGraphql(store, `query DuplicateSkuReport($first: Int!) {
    productVariants(first: $first, query: "sku:*", sortKey: SKU) {
      nodes { id sku title product { id title handle status } }
      pageInfo { hasNextPage endCursor }
    }
  }`, { first }));
    const bySku = new Map();
    const summaries = report.results.map((result) => {
        const variants = nodesFrom(result, "productVariants");
        const local = new Map();
        for (const variant of variants) {
            const sku = String(variant.sku ?? "").trim();
            if (!sku)
                continue;
            const key = sku.toLowerCase();
            local.set(key, [...(local.get(key) ?? []), variant]);
            bySku.set(key, [...(bySku.get(key) ?? []), { store: result.store, variant }]);
        }
        const pageInfo = recordValue(connectionRecordFrom(result, "productVariants").pageInfo);
        return {
            store: result.store,
            ok: result.ok,
            scannedVariants: variants.length,
            complete: pageInfo?.hasNextPage !== true,
            duplicateSkus: [...local.entries()].filter(([, entries]) => entries.length > 1).map(([sku, entries]) => ({ sku, variants: entries }))
        };
    });
    const crossStoreSkus = [...bySku.entries()].map(([sku, entries]) => ({
        sku,
        stores: [...new Set(entries.map((entry) => entry.store))],
        entries
    })).filter((row) => row.stores.length > 1);
    return responseWithinLimit({ rowLimitPerStore: first, summaries, crossStoreSkus, ...report });
}
export async function comparePrices(aliases, skus) {
    const inventory = await compareInventory(aliases, skus);
    const inventoryMatrix = Array.isArray(inventory.matrix) ? inventory.matrix.filter((row) => Boolean(row) && typeof row === "object") : [];
    const matrix = inventoryMatrix.map((row) => {
        const storesValue = recordValue(row.stores) ?? {};
        const stores = Object.fromEntries(Object.entries(storesValue).map(([store, value]) => {
            const variants = Array.isArray(value) ? value.filter((variant) => Boolean(variant) && typeof variant === "object") : [];
            return [store, variants.map((variant) => ({
                    id: variant.id,
                    title: variant.title,
                    price: variant.price,
                    compareAtPrice: variant.compareAtPrice,
                    product: variant.product
                }))];
        }));
        const fingerprints = new Set(Object.values(stores).map((value) => JSON.stringify(value.map((variant) => ({
            price: variant.price,
            compareAtPrice: variant.compareAtPrice
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))));
        return { sku: row.sku, consistent: fingerprints.size <= 1, stores };
    });
    return responseWithinLimit({
        requestedSkus: inventory.requestedSkus,
        differences: matrix.filter((row) => !row.consistent),
        matrix,
        count: inventory.count,
        succeeded: inventory.succeeded,
        failed: inventory.failed,
        results: inventory.results
    });
}
//# sourceMappingURL=reports.js.map