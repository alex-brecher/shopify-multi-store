import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  workflow,
  textResult,
  toolError,
  type Workflow,
  type Data,
  WorkflowError,
} from "./admin-workflows.js";
import { PDOCS } from "./parity-documents.js";
import { mapConcurrent } from "./concurrency.js";
import { loadStores } from "./config.js";
import { REQUIRED_SCOPES, VARIABLE_SCOPE_TOOLS } from "./scope-requirements.js";

// These tools pin their Admin GraphQL operations to 2026-04 (the newest quarterly
// version bundled with the server at the time they were written) rather than
// following each store's own configured apiVersion, so their behavior stays fixed
// regardless of what a store is otherwise configured for.
const PARITY_API_VERSION = "2026-04";

const store = z.string().min(1).max(64);
const gid = (type: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${type}/[0-9]+$`));
// Some ids returned by these tools (delivery zones, method definitions, rate
// definitions, files) come from Shopify object types that are not worth naming
// individually here, so this accepts any well-formed Admin API GID.
const anyGid = z.string().regex(/^gid:\/\/shopify\/[A-Za-z]+\/[0-9]+$/);
const first = z.number().int().min(1).max(100).default(25);
const after = z.string().max(1000).optional();
const page = { first, after };
const money = z.string().regex(/^\d+(\.\d{1,4})?$/);
const dryRunField = z
  .boolean()
  .default(true)
  .describe(
    "True (the default) returns a before/after preview without changing anything in Shopify. Pass false to apply the change; the tool then reads the result back.",
  );

const skuEntry = z
  .object({
    sku: z.string().min(1).max(255),
    price: money.optional(),
    compareAtPrice: money.nullable().optional(),
    unitCost: money.optional(),
  })
  .strict();
const skusField = z.array(skuEntry).min(1).max(250);

// Builds a Shopify mutation input from an explicit allowlist of tool arguments so
// tool-only fields (dryRun, allowLiveTheme, ...) never leak into GraphQL inputs.
function pick(a: Data, keys: readonly string[]): Data {
  const out: Data = {};
  for (const key of keys) if (a[key] !== undefined) out[key] = a[key];
  return out;
}
const DRAFT_ORDER_INPUT_FIELDS = ["email", "note", "tags"] as const;
const ORDER_INPUT_FIELDS = ["tags", "note", "email", "shippingAddress"] as const;
const CUSTOMER_INPUT_FIELDS = ["tags", "note", "email"] as const;
const PAGE_INPUT_FIELDS = ["title", "handle", "body", "isPublished"] as const;

async function updatePricesCore(
  w: Workflow,
  a: { skus: z.infer<typeof skuEntry>[]; dryRun: boolean },
): Promise<Data> {
  await w.requireScopes(["write_products", "write_inventory"]);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const uniqueEntries: (typeof a.skus)[number][] = [];
  for (const entry of a.skus) {
    if (seen.has(entry.sku)) {
      duplicates.add(entry.sku);
      continue;
    }
    seen.add(entry.sku);
    uniqueEntries.push(entry);
  }
  const notFound: string[] = [];
  const ambiguous: string[] = [];
  const resolved: { entry: (typeof a.skus)[number]; variant: Data }[] = [];
  for (const entry of uniqueEntries) {
    if (!entry.price && entry.compareAtPrice === undefined && !entry.unitCost) {
      notFound.push(entry.sku); // nothing requested; treated the same as not actionable
      continue;
    }
    const d = await w.run(PDOCS.findVariantsBySku, {
      query: `sku:${JSON.stringify(entry.sku)}`,
    });
    const matches = (d.productVariants?.nodes ?? []).filter(
      (v: Data) => v.sku === entry.sku,
    );
    if (matches.length === 0) {
      notFound.push(entry.sku);
    } else if (matches.length > 1) {
      ambiguous.push(entry.sku);
    } else {
      resolved.push({ entry, variant: matches[0] });
    }
  }
  const preview = resolved.map(({ entry, variant }) => ({
    sku: entry.sku,
    productId: variant.product.id,
    variantId: variant.id,
    before: {
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      unitCost: variant.inventoryItem?.unitCost?.amount,
    },
    requested: {
      ...(entry.price ? { price: entry.price } : {}),
      ...(entry.compareAtPrice !== undefined
        ? { compareAtPrice: entry.compareAtPrice }
        : {}),
      ...(entry.unitCost ? { unitCost: entry.unitCost } : {}),
    },
  }));
  if (a.dryRun) {
    return {
      dryRun: true,
      wouldApply: preview,
      notFound,
      duplicateSkus: [...duplicates],
      ambiguousSkus: ambiguous,
      notice: "Pass dryRun:false to apply these changes.",
    };
  }
  const byProduct = new Map<string, typeof resolved>();
  for (const r of resolved) {
    const list = byProduct.get(r.variant.product.id) ?? [];
    list.push(r);
    byProduct.set(r.variant.product.id, list);
  }
  const results: Data[] = [];
  for (const [productId, entries] of byProduct) {
    const variants = entries.map(({ entry, variant }) => ({
      id: variant.id,
      ...(entry.price ? { price: entry.price } : {}),
      ...(entry.compareAtPrice !== undefined
        ? { compareAtPrice: entry.compareAtPrice }
        : {}),
      ...(entry.unitCost ? { inventoryItem: { cost: entry.unitCost } } : {}),
    }));
    try {
      const d = await w.run(PDOCS.variantsBulkUpdatePrices, {
        productId,
        variants,
      });
      const after = d.productVariantsBulkUpdate?.productVariants ?? [];
      for (const { entry, variant } of entries) {
        const updated = after.find((v: Data) => v.id === variant.id);
        const mismatch =
          (entry.price && updated?.price !== entry.price) ||
          (entry.compareAtPrice !== undefined &&
            updated?.compareAtPrice !== entry.compareAtPrice) ||
          (entry.unitCost &&
            updated?.inventoryItem?.unitCost?.amount !== entry.unitCost);
        results.push({
          sku: entry.sku,
          productId,
          variantId: variant.id,
          outcome: mismatch ? "mismatch" : "applied",
          after: updated,
        });
      }
    } catch (error) {
      for (const { entry, variant } of entries)
        results.push({
          sku: entry.sku,
          productId,
          variantId: variant.id,
          outcome: "rejected",
          error: error instanceof Error ? error.message : String(error),
        });
    }
  }
  return {
    dryRun: false,
    results,
    notFound,
    duplicateSkus: [...duplicates],
    ambiguousSkus: ambiguous,
    succeeded: results.filter((r) => r.outcome === "applied").length,
    failed: results.filter((r) => r.outcome !== "applied").length,
  };
}

export function registerParityTools(server: McpServer) {
  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    write: boolean,
    handler: (w: Workflow, a: Data) => Promise<Data>,
  ) {
    server.registerTool(
      `shopify_${name}`,
      {
        description,
        inputSchema: z
          .object({ store, ...shape, ...(write ? { dryRun: dryRunField } : {}) })
          .strict(),
        annotations: {
          readOnlyHint: !write,
          destructiveHint: write,
          idempotentHint: !write,
          openWorldHint: true,
        },
      },
      async (args) => {
        const a = args as Data;
        let w: Workflow | undefined;
        try {
          w = await workflow(a.store);
          w.store = { ...w.store, apiVersion: PARITY_API_VERSION };
          const { store: _store, ...input } = a;
          const result = await handler(w, input);
          return textResult({
            store: w.store.alias,
            shop: w.store.shop,
            apiVersion: w.store.apiVersion,
            ...result,
          });
        } catch (error) {
          if (w)
            return toolError(
              new WorkflowError(
                error instanceof Error ? error.message : String(error),
                {
                  store: w.store.alias,
                  shop: w.store.shop,
                  ...(w.completed.length
                    ? {
                        completedSteps: w.completed,
                        outcome: "partial",
                        notice:
                          "Some writes succeeded. Read back before retrying.",
                      }
                    : {}),
                  ...(error instanceof WorkflowError ? error.details : {}),
                },
              ),
            );
          return toolError(error);
        }
      },
    );
  }

  // 1. Prices
  register(
    "update_prices",
    "Set price, compareAtPrice and/or unit cost for up to 250 SKUs on one store. Resolves SKU to variant and groups writes by product. Defaults to dryRun:true.",
    { skus: skusField },
    true,
    (w, a) => updatePricesCore(w, a as { skus: z.infer<typeof skuEntry>[]; dryRun: boolean }),
  );
  server.registerTool(
    "shopify_update_prices_many",
    {
      description:
        "Apply the same shopify_update_prices SKU list to multiple stores in parallel. Defaults to dryRun:true; each store gets its own outcome.",
      inputSchema: z
        .object({
          stores: z.array(store).min(1).max(50),
          skus: skusField,
          dryRun: dryRunField,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const a = args as Data;
      try {
        const requested = a.stores.filter(
          (s: string, i: number) =>
            a.stores.findIndex(
              (c: string) => c.toLowerCase() === s.toLowerCase(),
            ) === i,
        );
        const results = await mapConcurrent(
          requested,
          async (alias: string) => {
            try {
              const w = await workflow(alias);
              w.store = { ...w.store, apiVersion: PARITY_API_VERSION };
              const result = await updatePricesCore(w, {
                skus: a.skus,
                dryRun: a.dryRun,
              });
              return { store: w.store.alias, ok: true, ...result };
            } catch (error) {
              return {
                store: alias,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof WorkflowError ? error.details : {}),
              };
            }
          },
          5,
        );
        return textResult({
          dryRun: a.dryRun,
          stores: results,
          succeeded: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // 2. Metafields
  register(
    "get_metafields",
    "Get metafields for any owner GID (product, order, customer, collection, shop, etc.).",
    { ownerId: anyGid, namespace: z.string().max(255).optional(), key: z.string().max(255).optional(), ...page },
    false,
    async (w, a) => {
      const d = await w.run(PDOCS.getMetafields, {
        id: a.ownerId,
        first: a.first,
        after: a.after,
        namespace: a.namespace,
      });
      if (!d.node) throw Error("Owner not found in this store.");
      let nodes: Data[] = d.node.metafields?.nodes ?? [];
      if (a.key) nodes = nodes.filter((m) => m.key === a.key);
      return {
        ownerId: a.ownerId,
        metafields: nodes,
        pageInfo: d.node.metafields?.pageInfo,
      };
    },
  );
  register(
    "set_metafields",
    "Set up to 25 metafields in one call (metafieldsSet) for any owner GID. Defaults to dryRun:true.",
    {
      metafields: z
        .array(
          z
            .object({
              ownerId: anyGid,
              namespace: z.string().min(1).default("custom"),
              key: z.string().min(1),
              value: z.string().min(1),
              type: z.string().min(1).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(25),
    },
    true,
    async (w, a) => {
      if (a.dryRun)
        return {
          dryRun: true,
          wouldSet: a.metafields,
          notice: "Pass dryRun:false to apply.",
        };
      const d = await w.run(PDOCS.metafieldsSet, { metafields: a.metafields });
      return { dryRun: false, metafields: d.metafieldsSet?.metafields };
    },
  );
  register(
    "delete_metafields",
    "Delete up to 25 metafields identified by owner GID, namespace and key. Defaults to dryRun:true.",
    {
      metafields: z
        .array(
          z
            .object({
              ownerId: anyGid,
              namespace: z.string().min(1),
              key: z.string().min(1),
            })
            .strict(),
        )
        .min(1)
        .max(25),
    },
    true,
    async (w, a) => {
      if (a.dryRun)
        return {
          dryRun: true,
          wouldDelete: a.metafields,
          notice: "Pass dryRun:false to apply.",
        };
      const d = await w.run(PDOCS.metafieldsDelete, {
        metafields: a.metafields,
      });
      return {
        dryRun: false,
        deletedMetafields: d.metafieldsDelete?.deletedMetafields,
      };
    },
  );

  // 3. Metaobjects
  register(
    "list_metaobjects",
    "List metaobjects of one type with cursor pagination.",
    { type: z.string().min(1), ...page },
    false,
    async (w, a) => {
      await w.requireScopes(["read_metaobjects"]);
      return w.run(PDOCS.listMetaobjects, a);
    },
  );
  register(
    "upsert_metaobject",
    "Create or update a metaobject by type and handle (metaobjectUpsert). Defaults to dryRun:true.",
    {
      type: z.string().min(1),
      handle: z.string().min(1),
      fields: z
        .array(z.object({ key: z.string().min(1), value: z.string() }).strict())
        .min(1)
        .max(50),
    },
    true,
    async (w, a) => {
      await w.requireScopes(["write_metaobjects"]);
      if (a.dryRun)
        return {
          dryRun: true,
          wouldUpsert: { type: a.type, handle: a.handle, fields: a.fields },
          notice: "Pass dryRun:false to apply.",
        };
      const d = await w.run(PDOCS.metaobjectUpsert, {
        handle: { type: a.type, handle: a.handle },
        metaobject: { handle: a.handle, fields: a.fields },
      });
      return { dryRun: false, metaobject: d.metaobjectUpsert?.metaobject };
    },
  );

  // 4. Redirects
  register(
    "list_redirects",
    "List URL redirects with cursor pagination. Requires read_online_store_navigation.",
    { query: z.string().max(1000).optional(), ...page },
    false,
    async (w, a) => {
      await w.requireScopes(["read_online_store_navigation"]);
      return w.run(PDOCS.listRedirects, a);
    },
  );
  register(
    "create_redirects",
    "Create up to 100 URL redirects with per-redirect outcomes. Requires write_online_store_navigation. Defaults to dryRun:true.",
    {
      redirects: z
        .array(
          z
            .object({ path: z.string().min(1), target: z.string().min(1) })
            .strict(),
        )
        .min(1)
        .max(100),
    },
    true,
    async (w, a) => {
      await w.requireScopes(["write_online_store_navigation"]);
      if (a.dryRun)
        return {
          dryRun: true,
          wouldCreate: a.redirects,
          notice: "Pass dryRun:false to apply.",
        };
      const results: Data[] = [];
      for (const r of a.redirects) {
        try {
          const d = await w.run(PDOCS.createRedirect, { urlRedirect: r });
          results.push({ ...r, ok: true, urlRedirect: d.urlRedirectCreate?.urlRedirect });
        } catch (error) {
          results.push({
            ...r,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        dryRun: false,
        results,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      };
    },
  );
  register(
    "delete_redirects",
    "Delete up to 100 URL redirects by ID with per-ID outcomes. Requires write_online_store_navigation. Defaults to dryRun:true.",
    { ids: z.array(gid("UrlRedirect")).min(1).max(100) },
    true,
    async (w, a) => {
      await w.requireScopes(["write_online_store_navigation"]);
      if (a.dryRun)
        return {
          dryRun: true,
          wouldDelete: a.ids,
          notice: "Pass dryRun:false to apply.",
        };
      const results: Data[] = [];
      for (const id of a.ids) {
        try {
          const d = await w.run(PDOCS.deleteRedirect, { id });
          results.push({
            id,
            ok: true,
            deletedUrlRedirectId: d.urlRedirectDelete?.deletedUrlRedirectId,
          });
        } catch (error) {
          results.push({
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        dryRun: false,
        results,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      };
    },
  );

  // 5. Delivery profiles
  register(
    "list_delivery_profiles",
    "List delivery profiles with their zones, method definitions and current flat rates. Requires read_shipping.",
    { ...page },
    false,
    async (w, a) => {
      await w.requireScopes(["read_shipping"]);
      return w.run(PDOCS.listDeliveryProfiles, a);
    },
  );
  register(
    "update_delivery_rate",
    "Change a single flat rate amount on a delivery method definition (deliveryProfileUpdate). Requires write_shipping. Defaults to dryRun:true. Always reads the rate back afterward: Shopify can return success with no userErrors while silently discarding the new amount, and this tool reports that as an error rather than a success.",
    {
      deliveryProfileId: anyGid,
      locationGroupId: anyGid,
      zoneId: anyGid,
      methodDefinitionId: anyGid,
      rateDefinitionId: anyGid,
      amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
      currencyCode: z.string().length(3),
    },
    true,
    async (w, a) => {
      await w.requireScopes(["write_shipping"]);
      if (a.dryRun)
        return {
          dryRun: true,
          wouldApply: { amount: a.amount, currencyCode: a.currencyCode },
          methodDefinitionId: a.methodDefinitionId,
          notice: "Pass dryRun:false to apply.",
        };
      const profile = {
        locationGroupsToUpdate: [
          {
            id: a.locationGroupId,
            zonesToUpdate: [
              {
                id: a.zoneId,
                methodDefinitionsToUpdate: [
                  {
                    id: a.methodDefinitionId,
                    rateDefinition: {
                      id: a.rateDefinitionId,
                      price: { amount: a.amount, currencyCode: a.currencyCode },
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      await w.run(PDOCS.updateDeliveryRate, {
        id: a.deliveryProfileId,
        profile,
      });
      const after = await w.run(PDOCS.listDeliveryProfiles, { first: 50 });
      const method = (after.deliveryProfiles?.nodes ?? [])
        .flatMap((p: Data) => p.profileLocationGroups ?? [])
        .flatMap((g: Data) => g.locationGroupZones?.nodes ?? [])
        .flatMap((z: Data) => z.methodDefinitions?.nodes ?? [])
        .find((m: Data) => m.id === a.methodDefinitionId);
      const persistedAmount = method?.rateProvider?.price?.amount;
      if (String(persistedAmount) !== String(a.amount))
        throw new WorkflowError(
          "Shopify accepted the delivery rate update with no userErrors but did not persist the new amount. This is a known Shopify silent-discard behavior; read the current rate before retrying.",
          {
            methodDefinitionId: a.methodDefinitionId,
            requestedAmount: a.amount,
            persistedAmount,
            completedSteps: w.completed,
          },
        );
      return {
        dryRun: false,
        methodDefinitionId: a.methodDefinitionId,
        appliedAmount: a.amount,
        currencyCode: a.currencyCode,
        verified: true,
      };
    },
  );

  // 6. Themes
  register(
    "list_themes",
    "List themes with their role (MAIN is the live theme). Requires read_themes.",
    { ...page },
    false,
    async (w, a) => {
      await w.requireScopes(["read_themes"]);
      return w.run(PDOCS.listThemes, a);
    },
  );
  register(
    "get_theme_files",
    "Read theme file contents. Pass filenames to fetch specific files, or omit to page through all of them. Requires read_themes.",
    {
      themeId: gid("OnlineStoreTheme"),
      filenames: z.array(z.string().min(1)).max(50).optional(),
      ...page,
    },
    false,
    async (w, a) => {
      await w.requireScopes(["read_themes"]);
      const d = await w.run(PDOCS.getThemeFiles, {
        id: a.themeId,
        filenames: a.filenames,
        first: a.first,
        after: a.after,
      });
      if (!d.theme) throw Error("Theme not found in this store.");
      return d.theme;
    },
  );
  register(
    "upsert_theme_files",
    "Write theme files (themeFilesUpsert). Refuses to write to the live (MAIN) theme unless allowLiveTheme:true. Requires write_themes. Defaults to dryRun:true.",
    {
      themeId: gid("OnlineStoreTheme"),
      files: z
        .array(
          z
            .object({
              filename: z.string().min(1),
              content: z.string().min(1).max(500000),
            })
            .strict(),
        )
        .min(1)
        .max(50),
      allowLiveTheme: z.boolean().default(false),
    },
    true,
    async (w, a) => {
      await w.requireScopes(["write_themes", "read_themes"]);
      const list = await w.run(PDOCS.listThemes, { first: 50 });
      const theme = (list.themes?.nodes ?? []).find(
        (t: Data) => t.id === a.themeId,
      );
      if (!theme) throw Error("Theme not found in this store.");
      if (theme.role === "MAIN" && !a.allowLiveTheme)
        throw new WorkflowError(
          "Refusing to write to the live (MAIN) theme without allowLiveTheme:true.",
          { themeId: a.themeId, role: theme.role },
        );
      if (a.dryRun)
        return {
          dryRun: true,
          theme,
          wouldUpsert: a.files.map((f: Data) => f.filename),
          notice: "Pass dryRun:false to apply.",
        };
      const files = a.files.map((f: Data) => ({
        filename: f.filename,
        body: { type: "TEXT", value: f.content },
      }));
      const d = await w.run(PDOCS.upsertThemeFiles, {
        themeId: a.themeId,
        files,
      });
      return {
        dryRun: false,
        theme,
        upserted: d.themeFilesUpsert?.upsertedThemeFiles,
      };
    },
  );

  // 7. Files
  register(
    "list_files",
    "List files (images, videos, generic files) with cursor pagination. Requires read_files.",
    { query: z.string().max(1000).optional(), ...page },
    false,
    async (w, a) => {
      await w.requireScopes(["read_files"]);
      return w.run(PDOCS.listFiles, a);
    },
  );
  register(
    "delete_files",
    "Delete up to 100 files by ID. Requires write_files. Defaults to dryRun:true.",
    { ids: z.array(anyGid).min(1).max(100) },
    true,
    async (w, a) => {
      await w.requireScopes(["write_files"]);
      if (a.dryRun)
        return {
          dryRun: true,
          wouldDelete: a.ids,
          notice: "Pass dryRun:false to apply.",
        };
      const d = await w.run(PDOCS.deleteFiles, { fileIds: a.ids });
      return { dryRun: false, deletedFileIds: d.fileDelete?.deletedFileIds };
    },
  );

  // 8. Orders
  register(
    "create_draft_order",
    "Create a draft order from line items (variant ID and quantity). Requires write_draft_orders. Defaults to dryRun:true.",
    {
      email: z.string().email().optional(),
      note: z.string().max(5000).optional(),
      tags: z.array(z.string()).max(250).optional(),
      lineItems: z
        .array(
          z
            .object({
              variantId: gid("ProductVariant"),
              quantity: z.number().int().min(1).max(100000),
            })
            .strict(),
        )
        .min(1)
        .max(250),
    },
    true,
    async (w, a) => {
      await w.requireScopes(["write_draft_orders"]);
      const input = {
        ...pick(a, DRAFT_ORDER_INPUT_FIELDS),
        lineItems: a.lineItems.map((l: Data) => ({
          variantId: l.variantId,
          quantity: l.quantity,
        })),
      };
      if (a.dryRun)
        return {
          dryRun: true,
          wouldCreate: input,
          notice: "Pass dryRun:false to apply.",
        };
      const d = await w.run(PDOCS.createDraftOrder, { input });
      return { dryRun: false, draftOrder: d.draftOrderCreate?.draftOrder };
    },
  );
  register(
    "update_order",
    "Update order tags, note, email and/or shipping address (orderUpdate) with a before/after result. Requires write_orders. Defaults to dryRun:true.",
    {
      id: gid("Order"),
      tags: z.array(z.string()).max(250).optional(),
      note: z.string().max(5000).nullable().optional(),
      email: z.string().email().optional(),
      shippingAddress: z
        .object({
          address1: z.string().optional(),
          address2: z.string().optional(),
          city: z.string().optional(),
          company: z.string().optional(),
          countryCode: z.string().optional(),
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          phone: z.string().optional(),
          provinceCode: z.string().optional(),
          zip: z.string().optional(),
        })
        .strict()
        .optional(),
    },
    true,
    async (w, a) => {
      await w.requireScopes(["write_orders"]);
      const before = await w.run(PDOCS.getOrderTagsNote, { id: a.id });
      if (!before.order) throw Error("Order not found in this store.");
      const id = a.id;
      const fields = pick(a, ORDER_INPUT_FIELDS);
      if (a.dryRun)
        return {
          dryRun: true,
          before: before.order,
          wouldApply: fields,
          notice: "Pass dryRun:false to apply.",
        };
      if (Object.keys(fields).length)
        await w.run(PDOCS.updateOrder, { input: { id, ...fields } });
      const after = await w.run(PDOCS.getOrderTagsNote, { id: a.id });
      return { dryRun: false, before: before.order, after: after.order };
    },
  );
  register(
    "tags",
    "Add and/or remove tags on a product, order, customer or draft order by GID (tagsAdd/tagsRemove). Defaults to dryRun:true.",
    {
      ownerId: anyGid,
      add: z.array(z.string().min(1)).max(50).optional(),
      remove: z.array(z.string().min(1)).max(50).optional(),
    },
    true,
    async (w, a) => {
      if (!a.add?.length && !a.remove?.length)
        throw Error("Supply add and/or remove tags.");
      if (a.dryRun)
        return {
          dryRun: true,
          wouldAdd: a.add ?? [],
          wouldRemove: a.remove ?? [],
          notice: "Pass dryRun:false to apply.",
        };
      let node: Data | undefined;
      if (a.add?.length) {
        const d = await w.run(PDOCS.tagsAdd, { id: a.ownerId, tags: a.add });
        node = d.tagsAdd?.node;
      }
      if (a.remove?.length) {
        const d = await w.run(PDOCS.tagsRemove, {
          id: a.ownerId,
          tags: a.remove,
        });
        node = d.tagsRemove?.node;
      }
      return { dryRun: false, node };
    },
  );

  // 9. Customers
  register(
    "update_customer",
    "Update customer tags, note and/or email (customerUpdate) with a before/after result. Email marketing consent is out of scope. Requires write_customers. Defaults to dryRun:true.",
    {
      id: gid("Customer"),
      tags: z.array(z.string()).max(250).optional(),
      note: z.string().max(5000).optional(),
      email: z.string().email().optional(),
    },
    true,
    async (w, a) => {
      await w.requireScopes(["write_customers"]);
      const before = await w.run(PDOCS.getCustomer, { id: a.id });
      if (!before.customer) throw Error("Customer not found in this store.");
      const id = a.id;
      const fields = pick(a, CUSTOMER_INPUT_FIELDS);
      if (a.dryRun)
        return {
          dryRun: true,
          before: before.customer,
          wouldApply: fields,
          notice: "Pass dryRun:false to apply.",
        };
      if (Object.keys(fields).length)
        await w.run(PDOCS.updateCustomer, { input: { id, ...fields } });
      const after = await w.run(PDOCS.getCustomer, { id: a.id });
      return { dryRun: false, before: before.customer, after: after.customer };
    },
  );

  // 10. Fulfillment
  register(
    "create_fulfillment",
    "Fulfill an order's open fulfillment orders with optional tracking. notifyCustomer defaults to false. Requires write_fulfillments. Defaults to dryRun:true.",
    {
      orderId: gid("Order"),
      trackingNumber: z.string().min(1).optional(),
      trackingCompany: z.string().min(1).optional(),
      trackingUrl: z.string().url().optional(),
      notifyCustomer: z.boolean().default(false),
    },
    true,
    async (w, a) => {
      await w.requireScopes(["write_fulfillments"]);
      const d = await w.run(PDOCS.getOrderFulfillmentOrders, { id: a.orderId });
      if (!d.order) throw Error("Order not found in this store.");
      const open = (d.order.fulfillmentOrders?.nodes ?? []).filter(
        (fo: Data) => fo.status === "OPEN",
      );
      if (!open.length) throw Error("No open fulfillment orders on this order.");
      if (a.dryRun)
        return {
          dryRun: true,
          openFulfillmentOrders: open.map((o: Data) => o.id),
          notifyCustomer: a.notifyCustomer,
          notice: "Pass dryRun:false to apply.",
        };
      const fulfillment = {
        notifyCustomer: a.notifyCustomer,
        lineItemsByFulfillmentOrder: open.map((o: Data) => ({
          fulfillmentOrderId: o.id,
        })),
        ...(a.trackingNumber || a.trackingCompany || a.trackingUrl
          ? {
              trackingInfo: {
                number: a.trackingNumber,
                company: a.trackingCompany,
                url: a.trackingUrl,
              },
            }
          : {}),
      };
      const result = await w.run(PDOCS.createFulfillment, { fulfillment });
      return {
        dryRun: false,
        fulfillment: result.fulfillmentCreateV2?.fulfillment,
      };
    },
  );

  // 11. Pages and blog articles
  register(
    "list_pages",
    "List Online Store pages with cursor pagination. Requires read_content.",
    { query: z.string().max(1000).optional(), ...page },
    false,
    async (w, a) => {
      await w.requireScopes(["read_content"]);
      return w.run(PDOCS.listPages, a);
    },
  );
  register(
    "upsert_page",
    "Create a page (omit id) or update one (pass id) with a before/after result. Requires write_content. Defaults to dryRun:true.",
    {
      id: gid("Page").optional(),
      title: z.string().min(1).max(255).optional(),
      handle: z.string().max(255).optional(),
      body: z.string().max(500000).optional(),
      isPublished: z.boolean().optional(),
    },
    true,
    async (w, a) => {
      await w.requireScopes(["write_content"]);
      if (!a.id && !a.title) throw Error("title is required to create a page.");
      const before = a.id ? await w.run(PDOCS.getPage, { id: a.id }) : undefined;
      if (a.id && !before?.page) throw Error("Page not found in this store.");
      const page = pick(a, PAGE_INPUT_FIELDS);
      if (a.dryRun)
        return {
          dryRun: true,
          before: before?.page,
          wouldApply: a.id ? { id: a.id, ...page } : page,
          notice: "Pass dryRun:false to apply.",
        };
      if (a.id) {
        const id = a.id;
        await w.run(PDOCS.updatePage, { id, page });
        const after = await w.run(PDOCS.getPage, { id });
        return { dryRun: false, before: before?.page, after: after.page };
      }
      const d = await w.run(PDOCS.createPage, { page });
      return { dryRun: false, page: d.pageCreate?.page };
    },
  );
  register(
    "list_blog_articles",
    "List a blog's articles with cursor pagination. Requires read_content.",
    { blogId: gid("Blog"), ...page },
    false,
    async (w, a) => {
      await w.requireScopes(["read_content"]);
      const d = await w.run(PDOCS.listBlogArticles, { id: a.blogId, first: a.first, after: a.after });
      if (!d.blog) throw Error("Blog not found in this store.");
      return d.blog;
    },
  );

  // 12. Markets
  register(
    "list_markets",
    "List markets with cursor pagination. Requires read_markets.",
    { ...page },
    false,
    async (w, a) => {
      await w.requireScopes(["read_markets"]);
      return w.run(PDOCS.listMarkets, a);
    },
  );

  // 13. Access-scope diagnostics
  server.registerTool(
    "shopify_check_access",
    {
      description:
        "For one or many stores, compare granted Admin API access scopes against every tool's requirement (see src/scope-requirements.ts) and report granted scopes, missing scopes, and which tools would fail. Omit stores to check every configured store.",
      inputSchema: z
        .object({ stores: z.array(store).min(1).max(50).optional() })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const a = args as Data;
      try {
        const configured = await loadStores();
        const aliases: string[] = a.stores?.length
          ? a.stores
          : configured.map((s) => s.alias);
        const results = await mapConcurrent(
          aliases,
          async (alias: string) => {
            try {
              const w = await workflow(alias);
              w.store = { ...w.store, apiVersion: PARITY_API_VERSION };
              const data = await w.run(PDOCS.capabilities);
              const granted = new Set<string>(
                (data.currentAppInstallation?.accessScopes ?? []).map(
                  (s: Data) => s.handle,
                ),
              );
              const hasScope = (s: string) =>
                granted.has(s) ||
                (s.startsWith("read_") &&
                  granted.has(s.replace(/^read_/, "write_")));
              const failingTools = Object.entries(REQUIRED_SCOPES)
                .map(([tool, required]) => ({
                  tool,
                  missingScopes: required.filter((s) => !hasScope(s)),
                }))
                .filter((t) => t.missingScopes.length);
              return {
                store: w.store.alias,
                ok: true,
                grantedScopes: [...granted].sort(),
                missingScopes: [
                  ...new Set(failingTools.flatMap((t) => t.missingScopes)),
                ].sort(),
                failingTools,
                variableScopeTools: Object.entries(VARIABLE_SCOPE_TOOLS).map(
                  ([tool, note]) => ({ tool, note }),
                ),
              };
            } catch (error) {
              return {
                store: alias,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
          5,
        );
        return textResult({ stores: results });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
