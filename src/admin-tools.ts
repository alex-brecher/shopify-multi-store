import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { DOCS } from "./admin-documents.js";
import {
  workflow,
  textResult,
  toolError,
  type Workflow,
  type Data,
  WorkflowError,
  applyTagChanges,
  checkTagArgs,
  tagPreview,
} from "./admin-workflows.js";
import { inspectType, validateDocument } from "./schema.js";
import { uploadImage } from "./media.js";
import { LEGACY_COLLECTION_API_VERSION } from "./api-versions.js";
import { schemaAvailable } from "./platform/schema-source.js";

/**
 * Smart-collection ruleSet writes use the legacy input on LEGACY_COLLECTION_API_VERSION. Where
 * that schema is not bundled and schemas are never downloaded (a Cloudflare Worker), refuse
 * up front, dry run included, instead of failing halfway.
 */
function checkLegacyRuleSetAvailable(): void {
  if (schemaAvailable(LEGACY_COLLECTION_API_VERSION)) return;
  throw Error(
    `Smart-collection rules (ruleSet) are written with the Admin API ${LEGACY_COLLECTION_API_VERSION} input, and this deployment (Cloudflare Workers) bundles only the default API schema. Use shopify_run_action with collectionCreate or collectionUpdate and the current \`sources\` input instead (check it first with shopify_describe_action), or run this ruleSet write from a local or \`serve\` install.`,
  );
}

const store = z.string().min(1).max(64);
const gid = (type: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${type}/[0-9]+$`));
const first = z.number().int().min(1).max(100).default(25);
const after = z.string().max(1000).optional();
const page = { first, after };
const dryRun = z
  .boolean()
  .default(true)
  .describe(
    "True (the default) returns a before/after preview without changing anything in Shopify. Pass false, after the user authorizes this store and exact change, to apply it; the tool then reads the result back.",
  );
const tagList = z.array(z.string().min(1).max(255)).max(250);
/** Tag arguments for update tools. replaceTags replaces the whole list; addTags and removeTags leave other tags alone. */
export const tagFields = {
  replaceTags: tagList
    .optional()
    .describe("Replaces all tags: every current tag not in this list is removed. Prefer addTags or removeTags."),
  addTags: tagList.optional().describe("Tags to add (tagsAdd). Other tags are kept."),
  removeTags: tagList.optional().describe("Tags to remove (tagsRemove). Other tags are kept."),
};
const PREVIEW_NOTICE = "Nothing was changed. Pass dryRun:false to apply.";
const status = z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]);
const money = z.string().regex(/^\d+(\.\d{1,4})?$/);
const image = z
  .object({
    url: z.url().startsWith("https://"),
    altText: z.string().max(1000).optional(),
  })
  .strict();
const optionValues = z
  .array(
    z
      .object({ optionName: z.string().min(1), name: z.string().min(1) })
      .strict(),
  )
  .min(1)
  .max(3);
const rules = z
  .object({
    appliedDisjunctively: z.boolean(),
    rules: z
      .array(
        z
          .object({
            column: z.string(),
            relation: z.string(),
            condition: z.string(),
          })
          .strict(),
      )
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
const mediaInputs = (images?: Data[]) =>
  images?.map((i) => ({
    originalSource: i.url,
    alt: i.altText,
    mediaContentType: "IMAGE",
  }));
const collectionInput = (a: Data) => ({
  ...a,
  ...(a.image ? { image: { src: a.image.url, altText: a.image.altText } } : {}),
});

export function registerAdminTools(server: McpServer) {
  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    write: boolean,
    handler: (w: Workflow, a: z.infer<z.ZodObject<S>> & { dryRun?: boolean }) => Promise<Data>,
  ) {
    server.registerTool(
      `shopify_${name}`,
      {
        description,
        inputSchema: z
          .object({ store, ...shape, ...(write ? { dryRun } : {}) })
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
          const { store: _store, ...input } = a;
          const result = await handler(w, input as z.infer<z.ZodObject<S>> & { dryRun?: boolean });
          return {
            ...textResult({
              store: w.store.alias,
              shop: w.store.shop,
              apiVersion: w.store.apiVersion,
              ...result,
            }, false, write),
          };
        } catch (error) {
          if (w) {
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
              write,
            );
          }
          return toolError(error);
        }
      },
    );
  }
  register(
    "graphql_schema",
    "Explore the Admin GraphQL schema for this store's API version.",
    { type_name: z.string().min(1).max(255) },
    false,
    (w, a) => inspectType(a.type_name, w.store.apiVersion),
  );
  register(
    "validate_graphql_codeblocks",
    "Validate Admin GraphQL operations against this store's API version without executing them.",
    {
      codeblocks: z
        .array(
          z
            .object({
              content: z.string().min(1).max(50000),
              artifactId: z.string().optional(),
              revision: z.number().int().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    },
    false,
    async (w, a) => {
      const results = await Promise.all(
        a.codeblocks.map(async (b) => ({
          ...b,
          errors: await validateDocument(b.content, w.store.apiVersion),
        })),
      );
      return { valid: results.every((r) => !r.errors.length), results };
    },
  );
  register(
    "create_product",
    "Create a product with options, variants and images, and optionally add it to a manual collection. Defaults to status DRAFT and to dryRun:true, which previews the input without creating anything.",
    {
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
        .array(
          z
            .object({
              price: money,
              sku: z.string().optional(),
              optionValues: optionValues.optional(),
              inventoryItem: z
                .object({ tracked: z.boolean().optional() })
                .strict()
                .optional(),
            })
            .strict(),
        )
        .min(1)
        .max(100)
        .optional(),
      collectionId: gid("Collection").optional(),
    },
    true,
    async (w, a) => {
      await w.requireScopes(["write_products"]);
      if (a.price && a.variants) throw Error("Use either price or variants.");
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
          if (
            v.optionValues?.length !== a.options!.length ||
            a.options!.some(
              (o) => !v.optionValues?.some((x) => x.optionName === o),
            )
          )
            throw Error(
              "Each variant must specify every named option exactly once.",
            );
      if (a.collectionId) {
        const c = await w.collection(a.collectionId, 1);
        if (c.collection.ruleSet)
          throw Error("Cannot add products to a smart collection manually.");
      }
      const { images, variants, options, collectionId, price, dryRun: preview, ...input } = a;
      const productOptions = options?.map((name) => ({
        name,
        values: [
          ...new Set(
            variants!.flatMap((v) =>
              v
                .optionValues!.filter((o) => o.optionName === name)
                .map((o) => o.name),
            ),
          ),
        ].map((name) => ({ name })),
      }));
      const product = { ...input, ...(productOptions ? { productOptions } : {}) };
      if (preview)
        return {
          dryRun: true,
          wouldCreate: { product, variants, images, collectionId },
          notice: PREVIEW_NOTICE,
        };
      const created = await w.run(DOCS.productCreate, {
        input: product,
        media: mediaInputs(images),
      });
      const id = created.productCreate?.product?.id;
      if (!id) throw Error("No product ID returned.");
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
      return { dryRun: false, ...(await w.product(id)), completedSteps: w.completed };
    },
  );
  register(
    "update_product",
    "Update product fields, variants, media and tags. dryRun:true (the default) returns the current product and the change without applying it; dryRun:false applies it and returns before and after. Tags: addTags and removeTags change only the named tags; replaceTags replaces all tags. A status of ARCHIVED or DRAFT takes the product off every sales channel.",
    {
      id: gid("Product"),
      title: z.string().min(1).optional(),
      descriptionHtml: z.string().max(50000).optional(),
      status: status.optional(),
      vendor: z.string().optional(),
      productType: z.string().optional(),
      ...tagFields,
      images: z.array(image).max(50).optional(),
      removeMediaIds: z.array(gid("MediaImage")).max(50).optional(),
      variants: z
        .array(
          z
            .object({
              id: gid("ProductVariant"),
              price: money.optional(),
              compareAtPrice: money.nullable().optional(),
              sku: z.string().optional(),
              optionValues: optionValues.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(100)
        .optional(),
    },
    true,
    async (w, a) => {
      checkTagArgs(a);
      await w.requireScopes(["write_products"]);
      const before = await w.product(a.id);
      const {
        images,
        variants,
        removeMediaIds,
        replaceTags,
        addTags,
        removeTags,
        dryRun: preview,
        ...fields
      } = a;
      const input = { ...fields, ...(replaceTags ? { tags: replaceTags } : {}) };
      if (preview)
        return {
          dryRun: true,
          before: before.product,
          wouldApply: {
            ...fields,
            ...tagPreview(a, before.product.tags),
            ...(variants ? { variants } : {}),
            ...(images?.length ? { addImages: images } : {}),
            ...(removeMediaIds?.length ? { removeMediaIds } : {}),
          },
          notice: PREVIEW_NOTICE,
        };
      if (Object.keys(input).length > 1 || images?.length)
        await w.run(DOCS.productUpdate, { input, media: mediaInputs(images) });
      await applyTagChanges(w, a.id, { addTags, removeTags });
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
        dryRun: false,
        before: before.product,
        after: (await w.product(a.id)).product,
        completedSteps: w.completed,
      };
    },
  );
  register(
    "create_collection",
    "Create a manual collection (optional productIds) or a smart collection (ruleSet). Pass publicationIds to publish to explicitly selected channels. Defaults to dryRun:true, which previews the input without creating anything.",
    {
      ...collectionFields,
      title: z.string().min(1).max(255),
      productIds: z.array(gid("Product")).min(1).max(250).optional(),
      publicationIds: z.array(gid("Publication")).max(20).default([]),
    },
    true,
    async (w, a) => {
      if (a.productIds && a.ruleSet)
        throw Error("productIds and ruleSet are mutually exclusive.");
      if (a.ruleSet) checkLegacyRuleSetAvailable();
      await w.requireScopes([
        "write_products",
        ...(a.publicationIds.length ? ["write_publications"] : []),
      ]);
      const { productIds, publicationIds, dryRun: preview, ...fields } = a;
      if (preview)
        return {
          dryRun: true,
          wouldCreate: { ...fields, productIds, publicationIds },
          notice: PREVIEW_NOTICE,
        };
      // Smart-collection rules need the legacy input; everything else uses the 2026-07 input,
      // with products added afterwards (see api-versions.ts).
      const d = fields.ruleSet
        ? await w.run(DOCS.collectionCreateLegacy, { input: collectionInput(fields) })
        : await w.run(DOCS.collectionCreate, { input: collectionInput(fields) });
      const id = d.collectionCreate?.collection?.id;
      if (!id) throw Error("No collection ID returned.");
      if (productIds?.length)
        await w.run(DOCS.addCollection, { id, productIds: [...new Set(productIds)] });
      await w.publish(id, publicationIds);
      return { dryRun: false, ...(await w.collection(id)), completedSteps: w.completed };
    },
  );
  register(
    "update_collection",
    "Update collection fields, rules or image, and add products to a manual collection (addProductIds). dryRun:true (the default) returns the current collection and the change without applying it; dryRun:false applies it and returns before and after.",
    {
      id: gid("Collection"),
      ...collectionFields,
      addProductIds: z
        .array(gid("Product"))
        .min(1)
        .max(250)
        .optional()
        .describe("Products to add to a manual collection. Smart collection membership follows its rules."),
    },
    true,
    async (w, a) => {
      if (a.ruleSet) checkLegacyRuleSetAvailable();
      await w.requireScopes(["write_products"]);
      const before = await w.collection(a.id, 1);
      const { addProductIds, dryRun: preview, ...fields } = a;
      if (addProductIds && before.collection.ruleSet)
        throw Error("Smart collection membership is controlled by rules.");
      if (preview)
        return {
          dryRun: true,
          before: before.collection,
          wouldApply: { ...fields, ...(addProductIds ? { addProductIds } : {}) },
          notice: PREVIEW_NOTICE,
        };
      if (Object.keys(fields).length > 1)
        await w.run(fields.ruleSet ? DOCS.collectionUpdateLegacy : DOCS.collectionUpdate, {
          input: collectionInput(fields),
        });
      if (addProductIds)
        await w.run(DOCS.addCollection, {
          id: a.id,
          productIds: [...new Set(addProductIds)],
        });
      return {
        dryRun: false,
        before: before.collection,
        after: (await w.collection(a.id)).collection,
        completedSteps: w.completed,
      };
    },
  );
  register(
    "set_inventory",
    "Set available inventory at one location using compare-and-set protection: compareQuantity must equal the current available quantity. Read inventory first (shopify_get resource inventory). dryRun:true (the default) checks and previews without changing anything.",
    {
      inventoryItemId: gid("InventoryItem"),
      locationId: gid("Location"),
      quantity: z.number().int().min(0).max(1000000000),
      compareQuantity: z.number().int(),
      idempotencyKey: z.string().uuid().optional(),
      reason: z.string().min(1).default("correction"),
    },
    true,
    async (w, a) => {
      await w.requireScopes(["write_inventory"]);
      const variables = { id: a.inventoryItemId, location: a.locationId };
      const before = await w.run(DOCS.inventoryAt, variables);
      if (!before.inventoryItem?.tracked)
        throw Error("Inventory tracking is disabled.");
      const level = before.inventoryItem.inventoryLevel;
      if (!level)
        throw Error("Inventory item is not stocked at this location.");
      const current = level.quantities.find(
        (q: Data) => q.name === "available",
      )?.quantity;
      if (current !== a.compareQuantity)
        throw new WorkflowError(
          "Inventory changed since the read. No write sent.",
          { expected: a.compareQuantity, actual: current },
        );
      if (a.dryRun)
        return {
          dryRun: true,
          before: before.inventoryItem,
          wouldApply: { available: { from: current, to: a.quantity }, reason: a.reason },
          notice: PREVIEW_NOTICE,
        };
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
      if (
        after?.inventoryLevel?.quantities?.find(
          (q: Data) => q.name === "available",
        )?.quantity !== a.quantity
      )
        throw new WorkflowError(
          "Inventory readback did not match the requested quantity.",
          { idempotencyKey, after, completedSteps: w.completed },
        );
      return {
        dryRun: false,
        idempotencyKey,
        requestedQuantity: a.quantity,
        before: before.inventoryItem,
        after,
        completedSteps: w.completed,
      };
    },
  );
  register(
    "create_discount",
    "Create a percentage discount code with an explicit start date and customer audience. Defaults to dryRun:true, which resolves segments and previews the discount without creating it.",
    {
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
    },
    true,
    async (w, a) => {
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
      let customerSelection: Data = { all: "ALL" };
      if (a.customerSegments) {
        const segments = await w.all(DOCS.segments, {}, "segments");
        const selected = a.customerSegments.map((name) => {
          const matches = segments.filter(
            (s) => s.name.toLowerCase() === name.toLowerCase(),
          );
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
      if (a.dryRun)
        return { dryRun: true, wouldCreate: input, notice: PREVIEW_NOTICE };
      const d = await w.run(DOCS.discount, { input });
      const id = d.discountCodeBasicCreate?.codeDiscountNode?.id;
      if (!id) throw Error("No discount ID returned.");
      return {
        dryRun: false,
        code: a.code,
        percentage: a.percentage,
        ...(await w.run(DOCS.discountRead, { id })),
      };
    },
  );
  register(
    "upload_image",
    "Upload a local image file or an HTTPS image to Shopify Files, wait for processing, and return its CDN URL (check it later with shopify_get resource uploaded_image). Defaults to dryRun:true, which previews the upload without sending anything.",
    {
      imageFile: z.string().optional(),
      sourceUrl: z.url().startsWith("https://").optional(),
      alt: z.string().max(1000).optional(),
      filename: z.string().max(255).optional(),
    },
    true,
    async (w, a) => {
      const { dryRun: preview, ...input } = a;
      if (Boolean(input.imageFile) === Boolean(input.sourceUrl))
        throw Error("Supply exactly one imageFile or sourceUrl.");
      if (preview) {
        await w.requireScopes(["write_files"]);
        return { dryRun: true, wouldUpload: input, notice: PREVIEW_NOTICE };
      }
      return { dryRun: false, ...(await uploadImage(w, input)) };
    },
  );
}
