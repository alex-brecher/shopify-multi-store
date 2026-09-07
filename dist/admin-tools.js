import { randomUUID } from "node:crypto";
import { UI_META } from "./ui.js";
import { z } from "zod/v4";
import { DOCS } from "./admin-documents.js";
import { workflow, textResult, toolError, WorkflowError, } from "./admin-workflows.js";
import { inspectType, validateDocument } from "./schema.js";
import { uploadImage } from "./media.js";
const store = z.string().min(1).max(64);
const gid = (type) => z.string().regex(new RegExp(`^gid://shopify/${type}/[0-9]+$`));
const first = z.number().int().min(1).max(100).default(25);
const after = z.string().max(1000).optional();
const page = { first, after };
const confirm = z
    .literal(true)
    .describe("True only after authorization for this store and exact change.");
const status = z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]);
const money = z.string().regex(/^\d+(\.\d{1,4})?$/);
const image = z
    .object({
    url: z.url().startsWith("https://"),
    altText: z.string().max(1000).optional(),
})
    .strict();
const optionValues = z
    .array(z
    .object({ optionName: z.string().min(1), name: z.string().min(1) })
    .strict())
    .min(1)
    .max(3);
const rules = z
    .object({
    appliedDisjunctively: z.boolean(),
    rules: z
        .array(z
        .object({
        column: z.string(),
        relation: z.string(),
        condition: z.string(),
    })
        .strict())
        .min(1)
        .max(60),
})
    .strict();
const sortOrder = z.enum([
    "ALPHA_ASC",
    "ALPHA_DESC",
    "BEST_SELLING",
    "CREATED",
    "CREATED_DESC",
    "MANUAL",
    "PRICE_ASC",
    "PRICE_DESC",
]);
const collectionFields = {
    title: z.string().min(1).max(255).optional(),
    descriptionHtml: z.string().max(50000).optional(),
    image: image.optional(),
    ruleSet: rules.optional(),
    sortOrder: sortOrder.optional(),
};
const mediaInputs = (images) => images?.map((i) => ({
    originalSource: i.url,
    alt: i.altText,
    mediaContentType: "IMAGE",
}));
const collectionInput = (a) => ({
    ...a,
    ...(a.image ? { image: { src: a.image.url, altText: a.image.altText } } : {}),
});
export function registerAdminTools(server) {
    function register(name, description, shape, write, handler) {
        server.registerTool(`shopify_${name}`, {
            description,
            _meta: UI_META,
            inputSchema: z
                .object({ store, ...shape, ...(write ? { confirm } : {}) })
                .strict(),
            annotations: {
                readOnlyHint: !write,
                destructiveHint: write,
                idempotentHint: !write,
                openWorldHint: true,
            },
        }, async (args) => {
            const a = args;
            let w;
            try {
                w = await workflow(a.store);
                const { store: _store, confirm: _confirm, ...input } = a;
                const result = await handler(w, input);
                return {
                    ...textResult({
                        store: w.store.alias,
                        shop: w.store.shop,
                        apiVersion: w.store.apiVersion,
                        ...result,
                    }),
                    ...(!write
                        ? {
                            _meta: {
                                uiContext: {
                                    toolName: `shopify_${name}`,
                                    args: { store: w.store.alias, ...input },
                                },
                            },
                        }
                        : {}),
                };
            }
            catch (error) {
                if (w) {
                    return toolError(new WorkflowError(error instanceof Error ? error.message : String(error), {
                        store: w.store.alias,
                        shop: w.store.shop,
                        ...(w.completed.length
                            ? {
                                completedSteps: w.completed,
                                outcome: "partial",
                                notice: "Some writes succeeded. Read back before retrying.",
                            }
                            : {}),
                        ...(error instanceof WorkflowError ? error.details : {}),
                    }));
                }
                return toolError(error);
            }
        });
    }
    register("get_store_capabilities", "Inspect store identity and granted access scopes.", {}, false, async (w) => w.run(DOCS.capabilities));
    register("switch_shop", "Resolve a named store without disconnecting other stores. Continue to pass the store alias on every call.", {}, false, async (w) => ({
        ...(await w.run(DOCS.shop)),
        routing: "explicit_store_per_call",
    }));
    register("search_products", "Search products with cursor pagination.", { query: z.string().max(1000).optional(), ...page }, false, (w, a) => w.run(DOCS.products, a));
    register("get_product", "Get product details, variants and media. Follow each returned cursor independently.", { id: gid("Product"), ...page, mediaAfter: after }, false, (w, a) => w.product(a.id, a.first, a.after, a.mediaAfter));
    register("search_collections", "Search manual and smart collections with cursor pagination.", { query: z.string().max(1000).optional(), ...page }, false, (w, a) => w.run(DOCS.collections, a));
    register("get_collection", "Get collection details, rules and a page of products.", { id: gid("Collection"), ...page }, false, (w, a) => w.collection(a.id, a.first, a.after));
    register("list_orders", "List orders with Shopify search filters and cursor pagination.", { query: z.string().max(1000).optional(), ...page }, false, (w, a) => w.run(DOCS.orders, a));
    register("get_order", "Get order, shipping, fulfillment, tracking and a page of line items.", { id: gid("Order"), ...page }, false, async (w, a) => {
        const d = await w.run(DOCS.order, a);
        if (!d.order)
            throw Error("Order not found in this store.");
        return d;
    });
    register("list_customers", "Search customers with cursor pagination. Shopify protected-data permissions apply.", { query: z.string().max(1000).optional(), ...page }, false, (w, a) => w.run(DOCS.customers, a));
    register("get_inventory_levels", "Get inventory by product or inventory item. Use inventoryItemId and after to page through additional locations.", {
        productId: gid("Product").optional(),
        inventoryItemId: gid("InventoryItem").optional(),
        ...page,
    }, false, async (w, a) => {
        if (Boolean(a.productId) === Boolean(a.inventoryItemId))
            throw Error("Supply exactly one of productId or inventoryItemId.");
        return w.run(a.productId ? DOCS.inventory : DOCS.inventoryItem, {
            id: a.productId ?? a.inventoryItemId,
            first: a.first,
            after: a.after,
        });
    });
    register("graphql_schema", "Explore the Admin GraphQL schema for this store API version.", { type_name: z.string().min(1).max(255) }, false, (w, a) => inspectType(a.type_name, w.store.apiVersion));
    register("validate_graphql_codeblocks", "Validate Admin GraphQL operations against this store API version without executing them.", {
        codeblocks: z
            .array(z
            .object({
            content: z.string().min(1).max(50000),
            artifactId: z.string().optional(),
            revision: z.number().int().optional(),
        })
            .strict())
            .min(1)
            .max(20),
    }, false, async (w, a) => {
        const results = await Promise.all(a.codeblocks.map(async (b) => ({
            ...b,
            errors: await validateDocument(b.content, w.store.apiVersion),
        })));
        return { valid: results.every((r) => !r.errors.length), results };
    });
    register("run_analytics_query", "Run ShopifyQL and return columns, rows and chart metadata. Requires reports access.", { query: z.string().min(1).max(10000) }, false, async (w, a) => {
        await w.requireScopes(["read_reports"]);
        const d = await w.run(DOCS.analytics, a);
        if (d.shopifyqlQuery?.parseErrors?.length)
            throw new WorkflowError("ShopifyQL parse errors.", {
                parseErrors: d.shopifyqlQuery.parseErrors,
            });
        const table = d.shopifyqlQuery?.tableData;
        if (!table)
            throw Error("ShopifyQL returned no table.");
        const x = table.columns.findIndex((c) => /date|time|string/i.test(c.dataType));
        const ys = table.columns.flatMap((c, i) => /money|number|integer|float|decimal|percent/i.test(c.dataType)
            ? [i]
            : []);
        return {
            query: a.query,
            ...table,
            rowCount: table.rows.length,
            currencyCode: d.shop?.currencyCode,
            timezone: d.shop?.ianaTimezone,
            ...(x >= 0 && ys.length
                ? {
                    chartHint: {
                        type: /TIMESERIES/i.test(a.query) ? "line" : "bar",
                        xAxisColumnIndex: x,
                        yAxisColumnIndices: ys,
                    },
                }
                : {}),
        };
    });
    register("create_product", "Create a product, options, variants and images. Defaults to draft. Optional collection membership is a separate step.", {
        title: z.string().min(1).max(255),
        price: money.optional(),
        descriptionHtml: z.string().max(50000).optional(),
        vendor: z.string().optional(),
        productType: z.string().optional(),
        tags: z.array(z.string()).max(250).optional(),
        status: status.default("DRAFT"),
        images: z.array(image).max(50).optional(),
        options: z.array(z.string().min(1)).min(1).max(3).optional(),
        variants: z
            .array(z
            .object({
            price: money,
            sku: z.string().optional(),
            optionValues: optionValues.optional(),
            inventoryItem: z
                .object({ tracked: z.boolean().optional() })
                .strict()
                .optional(),
        })
            .strict())
            .min(1)
            .max(100)
            .optional(),
        collectionId: gid("Collection").optional(),
    }, true, async (w, a) => {
        await w.requireScopes(["write_products"]);
        if (a.price && a.variants)
            throw Error("Use either price or variants.");
        if (a.price) {
            a.options = ["Title"];
            a.variants = [
                {
                    price: a.price,
                    optionValues: [{ optionName: "Title", name: "Default Title" }],
                },
            ];
        }
        if (a.variants && !a.options)
            throw Error("options is required when variants are supplied.");
        if (a.options && !a.variants)
            throw Error("Supply variants with values for every option.");
        if (a.options && new Set(a.options).size !== a.options.length)
            throw Error("Duplicate option names.");
        if (a.variants)
            for (const v of a.variants)
                if (v.optionValues?.length !== a.options.length ||
                    a.options.some((o) => !v.optionValues?.some((x) => x.optionName === o)))
                    throw Error("Each variant must specify every named option exactly once.");
        if (a.collectionId) {
            const c = await w.collection(a.collectionId, 1);
            if (c.collection.ruleSet)
                throw Error("Cannot add products to a smart collection manually.");
        }
        const { images, variants, options, collectionId, price, ...input } = a;
        const productOptions = options?.map((name) => ({
            name,
            values: [
                ...new Set(variants.flatMap((v) => v
                    .optionValues.filter((o) => o.optionName === name)
                    .map((o) => o.name))),
            ].map((name) => ({ name })),
        }));
        const created = await w.run(DOCS.productCreate, {
            input: { ...input, ...(productOptions ? { productOptions } : {}) },
            media: mediaInputs(images),
        });
        const id = created.productCreate?.product?.id;
        if (!id)
            throw Error("No product ID returned.");
        if (variants)
            await w.run(DOCS.variantsCreate, {
                productId: id,
                variants: variants.map(({ sku, inventoryItem, ...v }) => ({
                    ...v,
                    inventoryItem: {
                        ...inventoryItem,
                        ...(sku !== undefined ? { sku } : {}),
                    },
                })),
            });
        if (collectionId)
            await w.run(DOCS.addCollection, { id: collectionId, productIds: [id] });
        return { ...(await w.product(id)), completedSteps: w.completed };
    });
    register("update_product", "Update product fields, variants and media with a before/after result.", {
        id: gid("Product"),
        title: z.string().min(1).optional(),
        descriptionHtml: z.string().max(50000).optional(),
        status: status.optional(),
        vendor: z.string().optional(),
        productType: z.string().optional(),
        tags: z.array(z.string()).max(250).optional(),
        images: z.array(image).max(50).optional(),
        removeMediaIds: z.array(gid("MediaImage")).max(50).optional(),
        variants: z
            .array(z
            .object({
            id: gid("ProductVariant"),
            price: money.optional(),
            compareAtPrice: money.nullable().optional(),
            sku: z.string().optional(),
            optionValues: optionValues.optional(),
        })
            .strict())
            .min(1)
            .max(100)
            .optional(),
    }, true, async (w, a) => {
        await w.requireScopes(["write_products"]);
        const before = await w.product(a.id);
        const { images, variants, removeMediaIds, ...input } = a;
        if (Object.keys(input).length > 1 || images?.length)
            await w.run(DOCS.productUpdate, { input, media: mediaInputs(images) });
        if (variants)
            await w.run(DOCS.variantsUpdate, {
                productId: a.id,
                variants: variants.map(({ sku, ...v }) => ({
                    ...v,
                    ...(sku !== undefined ? { inventoryItem: { sku } } : {}),
                })),
            });
        if (removeMediaIds?.length)
            await w.run(DOCS.mediaDelete, {
                productId: a.id,
                mediaIds: removeMediaIds,
            });
        return {
            before: before.product,
            after: (await w.product(a.id)).product,
            completedSteps: w.completed,
        };
    });
    register("create_collection", "Create a manual or smart collection. Pass publicationIds to publish to explicitly selected channels.", {
        ...collectionFields,
        title: z.string().min(1).max(255),
        productIds: z.array(gid("Product")).min(1).max(250).optional(),
        publicationIds: z.array(gid("Publication")).max(20).default([]),
    }, true, async (w, a) => {
        if (a.productIds && a.ruleSet)
            throw Error("productIds and ruleSet are mutually exclusive.");
        await w.requireScopes([
            "write_products",
            ...(a.publicationIds.length ? ["write_publications"] : []),
        ]);
        const { productIds, publicationIds, ...input } = a;
        const d = await w.run(DOCS.collectionCreate, {
            input: collectionInput({
                ...input,
                ...(productIds ? { products: productIds } : {}),
            }),
        });
        const id = d.collectionCreate?.collection?.id;
        if (!id)
            throw Error("No collection ID returned.");
        await w.publish(id, publicationIds);
        return { ...(await w.collection(id)), completedSteps: w.completed };
    });
    register("update_collection", "Update collection fields, rules or image with a before/after result.", { id: gid("Collection"), ...collectionFields }, true, async (w, a) => {
        await w.requireScopes(["write_products"]);
        const before = await w.collection(a.id, 1);
        await w.run(DOCS.collectionUpdate, { input: collectionInput(a) });
        return {
            before: before.collection,
            after: (await w.collection(a.id)).collection,
        };
    });
    register("add_to_collection", "Add products to a manual collection and return its current state.", {
        collectionId: gid("Collection"),
        productIds: z.array(gid("Product")).min(1).max(250),
    }, true, async (w, a) => {
        await w.requireScopes(["write_products"]);
        const c = await w.collection(a.collectionId, 1);
        if (c.collection.ruleSet)
            throw Error("Smart collection membership is controlled by rules.");
        await w.run(DOCS.addCollection, {
            id: a.collectionId,
            productIds: [...new Set(a.productIds)],
        });
        return w.collection(a.collectionId);
    });
    register("list_publications", "List publication IDs before publishing products or collections.", {}, false, async (w) => ({
        publications: await w.all(DOCS.publications, {}, "publications"),
    }));
    register("publish_resource", "Publish a product or collection to explicit publication IDs.", {
        id: z.union([gid("Product"), gid("Collection")]),
        publicationIds: z.array(gid("Publication")).min(1).max(20),
    }, true, async (w, a) => {
        await w.requireScopes(["write_publications"]);
        await w.publish(a.id, a.publicationIds);
        return {
            id: a.id,
            publicationIds: a.publicationIds,
            completedSteps: w.completed,
        };
    });
    register("bulk_update_product_status", "Update explicitly selected products or one collection, with bounded selection and per-product outcomes.", {
        productIds: z.array(gid("Product")).min(1).max(250).optional(),
        collectionId: gid("Collection").optional(),
        status,
        maxProducts: z.number().int().min(1).max(250).default(100),
    }, true, async (w, a) => {
        if (Boolean(a.productIds) === Boolean(a.collectionId))
            throw Error("Supply exactly one of productIds or collectionId.");
        await w.requireScopes(["write_products"]);
        let ids = a.productIds;
        if (a.collectionId) {
            const rows = [];
            const seen = new Set();
            let cursor;
            do {
                const d = await w.collection(a.collectionId, 100, cursor);
                rows.push(...d.collection.products.nodes.map((p) => p.id));
                if (rows.length > a.maxProducts)
                    throw Error("Collection exceeds maxProducts. No statuses changed.");
                const p = d.collection.products.pageInfo;
                if (!p.hasNextPage)
                    break;
                if (!p.endCursor || seen.has(p.endCursor))
                    throw Error("Invalid collection cursor.");
                cursor = p.endCursor;
                seen.add(cursor);
            } while (cursor);
            ids = rows;
        }
        ids = [...new Set(ids)];
        if (ids.length > a.maxProducts)
            throw Error("Selection exceeds maxProducts.");
        const results = [];
        for (const id of ids) {
            try {
                const before = await w.product(id, 1);
                await w.run(DOCS.productUpdate, { input: { id, status: a.status } });
                const after = await w.product(id, 1);
                results.push({
                    id,
                    ok: after.product.status === a.status,
                    before: before.product.status,
                    after: after.product.status,
                });
            }
            catch (e) {
                results.push({
                    id,
                    ok: false,
                    error: e instanceof Error ? e.message : String(e),
                });
            }
        }
        return {
            results,
            succeeded: results.filter((r) => r.ok).length,
            failed: results.filter((r) => !r.ok).length,
        };
    });
    register("set_inventory", "Set available inventory using compare-and-set protection. Read inventory first.", {
        inventoryItemId: gid("InventoryItem"),
        locationId: gid("Location"),
        quantity: z.number().int().min(0).max(1000000000),
        compareQuantity: z.number().int(),
        idempotencyKey: z.string().uuid().optional(),
        reason: z.string().min(1).default("correction"),
    }, true, async (w, a) => {
        await w.requireScopes(["write_inventory"]);
        const variables = { id: a.inventoryItemId, location: a.locationId };
        const before = await w.run(DOCS.inventoryAt, variables);
        if (!before.inventoryItem?.tracked)
            throw Error("Inventory tracking is disabled.");
        const level = before.inventoryItem.inventoryLevel;
        if (!level)
            throw Error("Inventory item is not stocked at this location.");
        const current = level.quantities.find((q) => q.name === "available")?.quantity;
        if (current !== a.compareQuantity)
            throw new WorkflowError("Inventory changed since the read. No write sent.", { expected: a.compareQuantity, actual: current });
        const idempotencyKey = a.idempotencyKey ?? randomUUID();
        await w.run(DOCS.setInventory, {
            idempotencyKey,
            input: {
                name: "available",
                reason: a.reason,
                quantities: [
                    {
                        inventoryItemId: a.inventoryItemId,
                        locationId: a.locationId,
                        quantity: a.quantity,
                        changeFromQuantity: a.compareQuantity,
                    },
                ],
            },
        });
        const after = (await w.run(DOCS.inventoryAt, variables)).inventoryItem;
        if (after?.inventoryLevel?.quantities?.find((q) => q.name === "available")?.quantity !== a.quantity)
            throw new WorkflowError("Inventory readback did not match the requested quantity.", { idempotencyKey, after, completedSteps: w.completed });
        return {
            idempotencyKey,
            requestedQuantity: a.quantity,
            before: before.inventoryItem,
            after,
            completedSteps: w.completed,
        };
    });
    register("create_discount", "Create a percentage discount with an explicit start date and customer audience.", {
        title: z.string().min(1),
        code: z.string().min(1),
        percentage: z.number().min(1).max(100),
        startsAt: z.iso.datetime(),
        endsAt: z.iso.datetime().optional(),
        customerEligibility: z.literal("all_customers").optional(),
        customerSegments: z.array(z.string().min(1)).min(1).max(50).optional(),
        productIds: z.array(gid("Product")).min(1).max(50).optional(),
        collectionId: gid("Collection").optional(),
        minimumPurchaseAmount: z.number().positive().optional(),
        minimumQuantity: z.number().int().positive().optional(),
        usageLimit: z.number().int().positive().optional(),
        appliesOncePerCustomer: z.boolean().default(false),
    }, true, async (w, a) => {
        if (Boolean(a.customerEligibility) === Boolean(a.customerSegments))
            throw Error("Choose all_customers or explicit existing segment names.");
        if (a.productIds && a.collectionId)
            throw Error("Choose products or a collection.");
        if (a.minimumPurchaseAmount && a.minimumQuantity)
            throw Error("Choose a minimum subtotal or quantity.");
        if (a.endsAt && Date.parse(a.endsAt) <= Date.parse(a.startsAt))
            throw Error("endsAt must follow startsAt.");
        await w.requireScopes([
            "write_discounts",
            ...(a.customerSegments ? ["read_customers"] : []),
        ]);
        let customerSelection = { all: "ALL" };
        if (a.customerSegments) {
            const segments = await w.all(DOCS.segments, {}, "segments");
            const selected = a.customerSegments.map((name) => {
                const matches = segments.filter((s) => s.name.toLowerCase() === name.toLowerCase());
                if (matches.length !== 1)
                    throw Error(`Segment name is missing or ambiguous: ${name}`);
                return matches[0].id;
            });
            customerSelection = { customerSegments: { add: selected } };
        }
        const items = a.productIds
            ? { products: { productsToAdd: a.productIds } }
            : a.collectionId
                ? { collections: { add: [a.collectionId] } }
                : { all: true };
        const input = {
            title: a.title,
            code: a.code,
            startsAt: a.startsAt,
            endsAt: a.endsAt,
            context: customerSelection,
            customerGets: { value: { percentage: a.percentage / 100 }, items },
            usageLimit: a.usageLimit,
            appliesOncePerCustomer: a.appliesOncePerCustomer,
            ...(a.minimumPurchaseAmount
                ? {
                    minimumRequirement: {
                        subtotal: {
                            greaterThanOrEqualToSubtotal: String(a.minimumPurchaseAmount),
                        },
                    },
                }
                : a.minimumQuantity
                    ? {
                        minimumRequirement: {
                            quantity: {
                                greaterThanOrEqualToQuantity: String(a.minimumQuantity),
                            },
                        },
                    }
                    : {}),
        };
        const d = await w.run(DOCS.discount, { input });
        const id = d.discountCodeBasicCreate?.codeDiscountNode?.id;
        if (!id)
            throw Error("No discount ID returned.");
        return {
            code: a.code,
            percentage: a.percentage,
            ...(await w.run(DOCS.discountRead, { id })),
        };
    });
    register("upload_image", "Upload a local image or HTTPS source to Shopify, wait for processing, and return a CDN URL.", {
        imageFile: z.string().optional(),
        sourceUrl: z.url().startsWith("https://").optional(),
        alt: z.string().max(1000).optional(),
        filename: z.string().max(255).optional(),
    }, true, (w, a) => uploadImage(w, a));
    register("get_uploaded_image", "Read image processing status and its CDN URL without creating another file.", { id: gid("MediaImage") }, false, (w, a) => w.run(DOCS.fileRead, a));
    register("bulk_export_start", "Start an asynchronous read-only Shopify bulk export. Save the returned operation ID to resume.", { query: z.string().min(1).max(50000) }, true, async (w, a) => {
        const { requireQuery } = await import("./shopify.js");
        requireQuery(a.query);
        return w.run(DOCS.bulkStart, a);
    });
    register("bulk_export_status", "Resume a bulk export by its operation ID. Partial exports remain explicitly incomplete.", { id: gid("BulkOperation") }, false, async (w, a) => {
        const d = await w.run(DOCS.bulkRead, a);
        if (!d.node)
            throw Error("Bulk operation not found.");
        return {
            ...d.node,
            complete: d.node.status === "COMPLETED" && !d.node.errorCode,
            partial: Boolean(d.node.partialDataUrl),
        };
    });
}
//# sourceMappingURL=admin-tools.js.map