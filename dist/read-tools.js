import { z } from "zod/v4";
import { DOCS } from "./admin-documents.js";
import { textResult, toolError, workflow, WorkflowError } from "./admin-workflows.js";
import { PARITY_API_VERSION } from "./api-versions.js";
import { mapConcurrent } from "./concurrency.js";
import { resolveStoreTargets } from "./config.js";
import { operation } from "./operations.js";
import { PDOCS } from "./parity-documents.js";
import { searchProductsMany } from "./reports.js";
import { fitMultiStoreResults } from "./result-limits.js";
const StoreAlias = z.string().min(1).max(64);
const MULTI_STORE_CHARACTER_LIMIT = 100_000;
/** Everything shopify_search lists. Keep in step with scope-requirements.ts. */
export const SEARCH_RESOURCES = {
    products: { document: DOCS.products, scopes: [], description: "Products (query: Shopify product search syntax)." },
    collections: { document: DOCS.collections, scopes: [], description: "Manual and smart collections." },
    orders: { document: DOCS.orders, scopes: [], description: "Orders, newest first (query: Shopify order search syntax)." },
    customers: { document: DOCS.customers, scopes: [], description: "Customers. Protected customer data permissions apply." },
    publications: { document: DOCS.publications, scopes: [], description: "Sales channel publication IDs (no query; 100 per page)." },
    redirects: { document: PDOCS.listRedirects, scopes: ["read_online_store_navigation"], pinned: true, description: "URL redirects." },
    pages: { document: PDOCS.listPages, scopes: ["read_content"], pinned: true, description: "Online Store pages." },
    files: { document: PDOCS.listFiles, scopes: ["read_files"], pinned: true, description: "Files (images, videos, generic files)." },
    metaobjects: { document: PDOCS.listMetaobjects, scopes: ["read_metaobjects"], pinned: true, requires: "type", description: "Metaobjects of one type (type required)." },
    markets: { document: PDOCS.listMarkets, scopes: ["read_markets"], pinned: true, description: "Markets (no query)." },
    themes: { document: PDOCS.listThemes, scopes: ["read_themes"], pinned: true, description: "Themes with their role; MAIN is live (no query)." },
    delivery_profiles: { document: PDOCS.listDeliveryProfiles, scopes: ["read_shipping"], pinned: true, description: "Delivery profiles with zones, methods and flat rates (no query)." },
};
/** Everything shopify_get reads by ID. Keep in step with scope-requirements.ts. */
export const GET_RESOURCES = {
    product: "Product details, variants (first/after) and media (mediaAfter). id: Product GID.",
    collection: "Collection details, rules and a page of products. id: Collection GID.",
    order: "Order, shipping, fulfillment, tracking and a page of line items. id: Order GID.",
    inventory: "Inventory by product (id: Product GID) or inventory item (id: InventoryItem GID, pages through locations).",
    metafields: "Metafields of any owner (id: owner GID); optional namespace and key.",
    theme_files: "Theme file contents. id: OnlineStoreTheme GID; optional filenames, else pages through every file.",
    blog_articles: "A blog's articles. id: Blog GID.",
    uploaded_image: "Image processing status and CDN URL. id: MediaImage GID.",
    bulk_operation: "A bulk operation's status and result URLs. id: BulkOperation GID. Partial exports stay marked incomplete.",
};
const GID = /^gid:\/\/shopify\/([A-Za-z]+)\/[0-9]+$/;
const GET_TYPES = {
    product: ["Product"],
    collection: ["Collection"],
    order: ["Order"],
    inventory: ["Product", "InventoryItem"],
    metafields: undefined,
    theme_files: ["OnlineStoreTheme"],
    blog_articles: ["Blog"],
    uploaded_image: ["MediaImage"],
    bulk_operation: ["BulkOperation"],
};
/** Only the variables a document declares, so tool-only arguments never reach Shopify. */
function declared(document, variables) {
    const names = new Set((operation(document).selected.variableDefinitions ?? []).map((definition) => definition.variable.name.value));
    return Object.fromEntries(Object.entries(variables).filter(([name, value]) => names.has(name) && value !== undefined));
}
async function list(w, resource, a) {
    const listing = SEARCH_RESOURCES[resource];
    if (listing.requires === "type" && !a.type)
        throw new Error(`${resource} needs type.`);
    if (listing.pinned)
        w.store = { ...w.store, apiVersion: PARITY_API_VERSION };
    if (listing.scopes.length)
        await w.requireScopes(listing.scopes);
    return w.run(listing.document, declared(listing.document, { query: a.query, first: a.first, after: a.after, type: a.type }));
}
async function get(w, resource, a) {
    const id = String(a.id ?? "");
    const type = GID.exec(id)?.[1];
    const allowed = GET_TYPES[resource];
    if (!type || (allowed && !allowed.includes(type)))
        throw new Error(`${resource} needs id, a ${allowed ? allowed.join(" or ") : "Shopify"} GID such as gid://shopify/${allowed?.[0] ?? "Product"}/123.`);
    switch (resource) {
        case "product":
            return w.product(id, a.first, a.after, a.mediaAfter);
        case "collection":
            return w.collection(id, a.first, a.after);
        case "order": {
            const d = await w.run(DOCS.order, { id, first: a.first, after: a.after });
            if (!d.order)
                throw new Error("Order not found in this store.");
            return d;
        }
        case "inventory":
            return w.run(type === "Product" ? DOCS.inventory : DOCS.inventoryItem, { id, first: a.first, after: a.after });
        case "metafields": {
            w.store = { ...w.store, apiVersion: PARITY_API_VERSION };
            const d = await w.run(PDOCS.getMetafields, { id, first: a.first, after: a.after, namespace: a.namespace });
            if (!d.node)
                throw new Error("Owner not found in this store.");
            let nodes = d.node.metafields?.nodes ?? [];
            if (a.key)
                nodes = nodes.filter((m) => m.key === a.key);
            return { ownerId: id, metafields: nodes, pageInfo: d.node.metafields?.pageInfo };
        }
        case "theme_files": {
            w.store = { ...w.store, apiVersion: PARITY_API_VERSION };
            await w.requireScopes(["read_themes"]);
            const d = await w.run(PDOCS.getThemeFiles, { id, filenames: a.filenames, first: a.first, after: a.after });
            if (!d.theme)
                throw new Error("Theme not found in this store.");
            return d.theme;
        }
        case "blog_articles": {
            w.store = { ...w.store, apiVersion: PARITY_API_VERSION };
            await w.requireScopes(["read_content"]);
            const d = await w.run(PDOCS.listBlogArticles, { id, first: a.first, after: a.after });
            if (!d.blog)
                throw new Error("Blog not found in this store.");
            return d.blog;
        }
        case "uploaded_image":
            return w.run(DOCS.fileRead, { id });
        case "bulk_operation": {
            const d = await w.run(DOCS.bulkRead, { id });
            if (!d.node)
                throw new Error("Bulk operation not found.");
            return { ...d.node, complete: d.node.status === "COMPLETED" && !d.node.errorCode, partial: Boolean(d.node.partialDataUrl) };
        }
    }
}
function storeFailure(alias, error) {
    return {
        store: alias,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof WorkflowError ? { details: error.details } : {}),
    };
}
export function registerReadTools(server) {
    const search = Object.keys(SEARCH_RESOURCES);
    server.registerTool("shopify_search", {
        title: "Search a Shopify Resource",
        description: `List or search one kind of record with cursor pagination, on one store (store) or several in parallel (stores; each store returns its own result and cursor). Resources:\n${Object.entries(SEARCH_RESOURCES).map(([name, item]) => `- ${name}: ${item.description}`).join("\n")}`,
        inputSchema: z
            .object({
            resource: z.enum(search),
            store: StoreAlias.optional().describe("One store alias. Give store or stores."),
            stores: z.array(StoreAlias).min(1).max(100).optional().describe("Several store aliases, searched in parallel."),
            query: z.string().max(1000).optional().describe("Shopify search syntax for the resource, where it takes one."),
            type: z.string().min(1).max(255).optional().describe("metaobjects: the metaobject type."),
            first: z.number().int().min(1).max(100).default(25),
            after: z.string().max(1000).optional().describe("Cursor from pageInfo.endCursor (single store only)."),
        })
            .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
        const a = args;
        try {
            if (Boolean(a.store) === Boolean(a.stores))
                throw new Error("Give exactly one of store or stores.");
            if (a.store) {
                const w = await workflow(a.store);
                const data = await list(w, a.resource, a);
                return textResult({ store: w.store.alias, shop: w.store.shop, apiVersion: w.store.apiVersion, resource: a.resource, ...data });
            }
            if (a.after)
                throw new Error("after applies to one store; page each store with store and its own cursor.");
            if (a.resource === "products" && a.query) {
                return textResult({ resource: a.resource, ...(await searchProductsMany(a.stores, a.query, a.first)) });
            }
            const targets = await resolveStoreTargets(a.stores);
            const results = await mapConcurrent(targets, async ({ requestedAlias, store, error }) => {
                if (!store)
                    return { store: requestedAlias, ok: false, error: error ?? "Unknown store." };
                try {
                    const w = await workflow(store.alias);
                    return { store: store.alias, ok: true, result: await list(w, a.resource, a) };
                }
                catch (caught) {
                    return storeFailure(store.alias, caught);
                }
            });
            return textResult({ resource: a.resource, ...fitMultiStoreResults(results, MULTI_STORE_CHARACTER_LIMIT) });
        }
        catch (error) {
            return toolError(error);
        }
    });
    const gets = Object.keys(GET_RESOURCES);
    server.registerTool("shopify_get", {
        title: "Get a Shopify Record",
        description: `Read one record by GID from one store. Follow each returned cursor independently. Resources:\n${Object.entries(GET_RESOURCES).map(([name, text]) => `- ${name}: ${text}`).join("\n")}`,
        inputSchema: z
            .object({
            resource: z.enum(gets),
            store: StoreAlias,
            id: z.string().min(1).max(255).describe("The record's GID, such as gid://shopify/Product/123."),
            first: z.number().int().min(1).max(100).default(25),
            after: z.string().max(1000).optional(),
            mediaAfter: z.string().max(1000).optional().describe("product: cursor for the media page."),
            namespace: z.string().max(255).optional().describe("metafields: only this namespace."),
            key: z.string().max(255).optional().describe("metafields: only this key."),
            filenames: z.array(z.string().min(1)).max(50).optional().describe("theme_files: only these files."),
        })
            .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
        const a = args;
        let w;
        try {
            w = await workflow(a.store);
            const data = await get(w, a.resource, a);
            return textResult({ store: w.store.alias, shop: w.store.shop, apiVersion: w.store.apiVersion, resource: a.resource, ...data });
        }
        catch (error) {
            return toolError(w ? new WorkflowError(error instanceof Error ? error.message : String(error), { store: w.store.alias, shop: w.store.shop, ...(error instanceof WorkflowError ? error.details : {}) }) : error);
        }
    });
}
//# sourceMappingURL=read-tools.js.map