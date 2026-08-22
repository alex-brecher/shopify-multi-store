import { loadStores, type StoreConfig } from "./config.js";
import { adminGraphql, type GraphqlEnvelope } from "./shopify.js";

const REPORT_CHARACTER_LIMIT = 150_000;

type ConnectionData = {
  nodes: Array<Record<string, unknown>>;
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  [key: string]: unknown;
};

type StoreReportResult = {
  store: string;
  ok: boolean;
  result?: GraphqlEnvelope;
  error?: string;
};

export type MultiStoreReport = {
  count: number;
  succeeded: number;
  failed: number;
  results: StoreReportResult[];
  [key: string]: unknown;
};

function responseWithinLimit<T extends Record<string, unknown>>(value: T): T {
  if (JSON.stringify(value).length > REPORT_CHARACTER_LIMIT) {
    throw new Error(`The combined report exceeded ${REPORT_CHARACTER_LIMIT} characters. Request fewer stores, SKUs, handles, or rows.`);
  }
  return value;
}

async function selectedStores(aliases?: string[]): Promise<Array<{ requestedAlias: string; store?: StoreConfig; error?: string }>> {
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

async function runReport(
  aliases: string[] | undefined,
  operation: (store: StoreConfig) => Promise<GraphqlEnvelope>
): Promise<MultiStoreReport> {
  const selected = await selectedStores(aliases);
  const results = await Promise.all(selected.map(async ({ requestedAlias, store, error }) => {
    if (!store) return { store: requestedAlias, ok: false, error: error ?? "Unknown store." };
    try {
      const result = await operation(store);
      const hasGraphqlErrors = Array.isArray(result.errors) && result.errors.length > 0;
      return {
        store: store.alias,
        ok: !hasGraphqlErrors,
        result,
        ...(hasGraphqlErrors ? { error: "Shopify returned GraphQL errors. See result.errors." } : {})
      };
    } catch (caught) {
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

function searchValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function nodesFrom(result: StoreReportResult, connection: string): Array<Record<string, unknown>> {
  const data = result.result?.data;
  if (!data || typeof data !== "object") return [];
  const value = (data as Record<string, unknown>)[connection];
  if (!value || typeof value !== "object") return [];
  const nodes = (value as Record<string, unknown>).nodes;
  return Array.isArray(nodes) ? nodes.filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object") : [];
}

function connectionFrom(envelope: GraphqlEnvelope, connection: string): ConnectionData | undefined {
  const data = envelope.data;
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>)[connection];
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const nodes = Array.isArray(record.nodes)
    ? record.nodes.filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object")
    : [];
  const pageInfo = record.pageInfo;
  if (!pageInfo || typeof pageInfo !== "object") return undefined;
  const page = pageInfo as Record<string, unknown>;
  return {
    ...record,
    nodes,
    pageInfo: {
      hasNextPage: page.hasNextPage === true,
      endCursor: typeof page.endCursor === "string" ? page.endCursor : null
    }
  };
}

function withConnection(envelope: GraphqlEnvelope, connection: string, value: ConnectionData): GraphqlEnvelope {
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data as Record<string, unknown> : {};
  return { ...envelope, data: { ...data, [connection]: value } };
}

function nextCursor(connection: ConnectionData, store: StoreConfig, label: string, previous?: string): string | undefined {
  if (!connection.pageInfo.hasNextPage) return undefined;
  const cursor = connection.pageInfo.endCursor;
  if (!cursor || cursor === previous) {
    throw new Error(`Shopify returned an invalid pagination cursor for ${label} on ${store.alias}.`);
  }
  return cursor;
}

async function paginatedConnection(
  store: StoreConfig,
  document: string,
  variables: Record<string, unknown>,
  connectionName: string
): Promise<GraphqlEnvelope> {
  let after: string | undefined;
  let firstEnvelope: GraphqlEnvelope | undefined;
  let firstConnection: ConnectionData | undefined;
  const nodes: Array<Record<string, unknown>> = [];

  do {
    const envelope = await adminGraphql(store, document, { ...variables, after: after ?? null });
    firstEnvelope ??= envelope;
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) return envelope;
    const connection = connectionFrom(envelope, connectionName);
    if (!connection) throw new Error(`Shopify returned no ${connectionName} connection for ${store.alias}.`);
    firstConnection ??= connection;
    nodes.push(...connection.nodes);
    if (JSON.stringify(nodes).length > REPORT_CHARACTER_LIMIT) {
      throw new Error(`The complete ${connectionName} result exceeded ${REPORT_CHARACTER_LIMIT} characters for ${store.alias}. Request fewer values.`);
    }
    const previous = after;
    after = nextCursor(connection, store, connectionName, previous);
  } while (after);

  if (!firstEnvelope || !firstConnection) throw new Error(`Shopify returned no ${connectionName} data for ${store.alias}.`);
  return withConnection(firstEnvelope, connectionName, {
    ...firstConnection,
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null }
  });
}

async function completeCatalogVariants(store: StoreConfig, envelope: GraphqlEnvelope): Promise<GraphqlEnvelope> {
  const products = connectionFrom(envelope, "products");
  if (!products) return envelope;

  for (const product of products.nodes) {
    const productId = product.id;
    const variantsValue = product.variants;
    if (typeof productId !== "string" || !variantsValue || typeof variantsValue !== "object") continue;
    const variantsRecord = variantsValue as Record<string, unknown>;
    const initialNodes = Array.isArray(variantsRecord.nodes)
      ? variantsRecord.nodes.filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object")
      : [];
    const pageInfoValue = variantsRecord.pageInfo;
    if (!pageInfoValue || typeof pageInfoValue !== "object") continue;
    const initialPage = pageInfoValue as Record<string, unknown>;
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
      const data = page.data && typeof page.data === "object" ? page.data as Record<string, unknown> : {};
      if (!data.product || typeof data.product !== "object") {
        throw new Error(`Shopify returned no product while paginating variants for ${store.alias}.`);
      }
      const pageProduct = data.product as Record<string, unknown>;
      if (!pageProduct.variants || typeof pageProduct.variants !== "object") {
        throw new Error(`Shopify returned no variant connection while paginating ${String(productId)} on ${store.alias}.`);
      }
      const pageVariants = pageProduct.variants as Record<string, unknown>;
      const pageNodes = Array.isArray(pageVariants.nodes)
        ? pageVariants.nodes.filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object")
        : [];
      variantNodes.push(...pageNodes);
      if (JSON.stringify(variantNodes).length > REPORT_CHARACTER_LIMIT) {
        throw new Error(`The complete variant result exceeded ${REPORT_CHARACTER_LIMIT} characters for ${store.alias}. Request fewer product handles.`);
      }
      if (!pageVariants.pageInfo || typeof pageVariants.pageInfo !== "object") {
        throw new Error(`Shopify returned no variant page information while paginating ${String(productId)} on ${store.alias}.`);
      }
      const pageInfo = pageVariants.pageInfo as Record<string, unknown>;
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

export async function portfolioSnapshot(aliases?: string[]): Promise<MultiStoreReport> {
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

export async function compareInventory(aliases: string[], skus: string[]): Promise<MultiStoreReport> {
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

export async function listUnfulfilledOrders(aliases: string[], days: number, first: number): Promise<MultiStoreReport> {
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

export async function compareCatalog(aliases: string[], handles: string[]): Promise<MultiStoreReport> {
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
          variants: product.variants
        })
      : "missing"));
    return { handle, consistent: fingerprints.size <= 1, stores };
  });
  return responseWithinLimit({ requestedHandles: uniqueHandles, differences: matrix.filter((row) => !row.consistent), matrix, ...report });
}
