import { z } from "zod/v4";
import { registerManageOperation, registerSearchResource } from "../extension-registry.js";
import { WorkflowError, type Data, type Workflow } from "../admin-workflows.js";
import { CDOCS } from "../commerce-documents.js";

// Draft order edits and deletes, files of any content type, marketing events and abandoned
// checkouts. Draft order create and complete live in commerce-tools.ts; images-only upload is
// shopify_upload_image.

const MONEY = "amount currencyCode";
const BAG = `shopMoney { ${MONEY} } presentmentMoney { ${MONEY} }`;
const PREVIEW = "Nothing was changed. Pass dryRun:false to apply.";
const gid = (type: string) => z.string().regex(new RegExp(`^gid://shopify/${type}/[0-9]+$`));
const fileGid = z.string().regex(/^gid:\/\/shopify\/(MediaImage|GenericFile|Video|ExternalVideo|Model3d)\/[0-9]+$/);
const money = z.string().regex(/^\d+(\.\d{1,4})?$/);
const shortText = z.string().max(255);

/** A public HTTPS URL without credentials. */
export function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
const httpsUrl = z.string().max(2048).refine(validHttpsUrl, "must be an https:// URL without user name or password");

export const DRAFT_FILES_DOCS = {
  draftUpdate: `mutation DraftOrderEdit($id: ID!, $input: DraftOrderInput!) {
  draftOrderUpdate(id: $id, input: $input) {
    draftOrder { id name status email note2 tags reserveInventoryUntil updatedAt customer { id displayName email } subtotalPriceSet { ${BAG} } totalPriceSet { ${BAG} } }
    userErrors { field message }
  }
}`,
  draftDelete: `mutation DraftOrderRemove($input: DraftOrderDeleteInput!) {
  draftOrderDelete(input: $input) { deletedId userErrors { field message } }
}`,
  draftStatus: `query DraftOrderEditState($id: ID!) {
  draftOrder(id: $id) { id name status email note2 tags reserveInventoryUntil order { id name } customer { id displayName email } totalPriceSet { ${BAG} } lineItems(first: 100) { nodes { id title quantity sku variant { id } } } }
}`,
  fileRead: `query FilesRead($ids: [ID!]!) {
  nodes(ids: $ids) {
    id
    __typename
    ... on File { alt fileStatus createdAt }
    ... on MediaImage { image { url } }
    ... on GenericFile { url mimeType }
    ... on Video { filename }
    ... on Model3d { filename }
    ... on ExternalVideo { originUrl }
  }
}`,
  fileCreate: `mutation FileAdd($files: [FileCreateInput!]!) {
  fileCreate(files: $files) { files { id __typename alt fileStatus createdAt } userErrors { field message code } }
}`,
  fileUpdate: `mutation FileEdit($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) { files { id __typename alt fileStatus updatedAt } userErrors { field message code } }
}`,
  fileDelete: `mutation FileRemove($fileIds: [ID!]!) {
  fileDelete(fileIds: $fileIds) { deletedFileIds userErrors { field message code } }
}`,
  marketingEvents: `query ListMarketingEvents($first: Int!, $after: String, $query: String) {
  marketingEvents(first: $first, after: $after, query: $query, sortKey: STARTED_AT, reverse: true) {
    nodes { id type remoteId startedAt endedAt scheduledToEndAt description marketingChannelType channelHandle utmCampaign utmMedium utmSource sourceAndMedium manageUrl previewUrl }
    pageInfo { hasNextPage endCursor }
  }
}`,
  abandonedCheckouts: `query ListAbandonedCheckouts($first: Int!, $after: String, $query: String) {
  abandonedCheckouts(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
    nodes { id name createdAt updatedAt completedAt abandonedCheckoutUrl lineItemsQuantity totalPriceSet { ${BAG} } customer { id email } }
    pageInfo { hasNextPage endCursor }
  }
}`,
};

// ------------------------------------------------------------------ search resources

registerSearchResource("marketing_events", {
  document: DRAFT_FILES_DOCS.marketingEvents,
  scopes: ["read_marketing_events"],
  description:
    "Marketing events (campaigns, ads, posts) recorded by marketing apps, newest first: id, type, remoteId, startedAt, endedAt, description, marketingChannelType, utm fields and sourceAndMedium. query: Shopify search syntax such as \"started_at:>=2026-10-01\" or \"type:AD\".",
});

registerSearchResource("abandoned_checkouts", {
  document: DRAFT_FILES_DOCS.abandonedCheckouts,
  scopes: ["read_orders"],
  description:
    "Abandoned checkouts, newest first: id, name, createdAt, updatedAt, abandonedCheckoutUrl, totalPriceSet, customer id and email when present, and lineItemsQuantity (units, not distinct lines). Needs the protected customer data permission for customer fields; Shopify returns only checkouts from the last 90 days. query: such as \"created_at:>=2026-10-01\".",
});

// ------------------------------------------------------------------ draft orders

const address = z
  .object({
    firstName: shortText.optional(),
    lastName: shortText.optional(),
    company: shortText.optional(),
    address1: shortText.optional(),
    address2: shortText.optional(),
    city: shortText.optional(),
    provinceCode: z.string().max(10).optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
    zip: z.string().max(20).optional(),
    phone: z.string().max(40).optional(),
  })
  .strict();

const lineItem = z
  .object({
    variantId: gid("ProductVariant").optional(),
    title: shortText.optional().describe("Custom line item title (with price, instead of variantId)."),
    price: money.optional().describe("Unit price: the price of a custom line item, or a price override for a variant."),
    quantity: z.number().int().min(1).max(10000),
    sku: shortText.optional(),
    taxable: z.boolean().optional(),
    requiresShipping: z.boolean().optional(),
  })
  .strict();

const draftShape = {
  action: z.enum(["update", "delete"]),
  id: gid("DraftOrder"),
  lineItems: z.array(lineItem).min(1).max(100).optional().describe("update: REPLACES the whole line item list."),
  customerId: gid("Customer").optional().describe("update: attach this customer."),
  email: z.email().optional(),
  note: z.string().max(5000).optional(),
  tags: z.array(z.string().min(1).max(255)).max(250).optional().describe("update: replaces all tags."),
  shippingAddress: address.optional(),
  billingAddress: address.optional(),
  appliedDiscount: z
    .object({ value: z.number().min(0), valueType: z.enum(["FIXED_AMOUNT", "PERCENTAGE"]), title: shortText.optional(), description: shortText.optional() })
    .strict()
    .optional(),
  shippingLine: z.object({ title: shortText, price: money }).strict().optional(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).optional().describe("Currency for custom prices and shipping; defaults to the shop currency."),
  reserveInventoryUntil: z.iso.datetime().optional().describe("update: hold inventory until this ISO 8601 time."),
};

async function lineItemInput(w: Workflow, a: Data): Promise<Data> {
  for (const li of a.lineItems ?? [])
    if (!li.variantId && !(li.title && li.price)) throw Error("Each line item needs variantId, or title and price.");
  const needsCurrency = (a.lineItems ?? []).some((li: Data) => li.price) || a.shippingLine;
  const currency = a.currencyCode ?? (needsCurrency ? (await w.run(CDOCS.shopCurrency)).shop?.currencyCode : undefined);
  const input: Data = {};
  if (a.lineItems)
    input.lineItems = a.lineItems.map((li: Data) => ({
      quantity: li.quantity,
      ...(li.variantId ? { variantId: li.variantId } : { title: li.title }),
      ...(li.price ? { [li.variantId ? "priceOverride" : "originalUnitPriceWithCurrency"]: { amount: li.price, currencyCode: currency } } : {}),
      ...(li.sku !== undefined ? { sku: li.sku } : {}),
      ...(li.taxable !== undefined ? { taxable: li.taxable } : {}),
      ...(li.requiresShipping !== undefined ? { requiresShipping: li.requiresShipping } : {}),
    }));
  if (a.customerId) input.purchasingEntity = { customerId: a.customerId };
  if (a.shippingLine) input.shippingLine = { title: a.shippingLine.title, priceWithCurrency: { amount: a.shippingLine.price, currencyCode: currency } };
  for (const key of ["email", "note", "tags", "shippingAddress", "billingAddress", "appliedDiscount", "reserveInventoryUntil"]) if (a[key] !== undefined) input[key] = a[key];
  return input;
}

registerManageOperation("draft_order", {
  description:
    "Edit or delete an existing draft order. update (draftOrderUpdate): any of lineItems (replaces the whole list), customerId, email, note, tags (replaces), shippingAddress, billingAddress, appliedDiscount, shippingLine and reserveInventoryUntil; the preview runs draftOrderCalculate when lineItems change. delete (draftOrderDelete) cannot be undone and needs confirm:\"delete\". Completed draft orders are refused. No invoice is sent. Create and complete are separate operations.",
  shape: draftShape,
  scopes: ["write_draft_orders"],
  confirmWord: (a) => (a.action === "delete" ? "delete" : undefined),
  handler: async (w, a) => {
    const current = (await w.run(DRAFT_FILES_DOCS.draftStatus, { id: a.id })).draftOrder;
    if (!current) throw Error("Draft order not found in this store.");
    if (current.status === "COMPLETED") throw new WorkflowError(`Draft order ${current.name} is already completed${current.order ? ` (order ${current.order.name})` : ""}. No write sent.`, { order: current.order });
    if (a.action === "delete") {
      if (a.dryRun) return { dryRun: true, wouldDelete: current, irreversible: true, notice: `${PREVIEW} Also pass confirm:"delete".` };
      const d = await w.run(DRAFT_FILES_DOCS.draftDelete, { input: { id: a.id } });
      return { dryRun: false, deleted: d.draftOrderDelete?.deletedId, was: current };
    }
    const input = await lineItemInput(w, a);
    if (!Object.keys(input).length) throw Error("update needs at least one field to change.");
    if (a.appliedDiscount?.valueType === "PERCENTAGE" && a.appliedDiscount.value > 100) throw Error("A percentage discount cannot exceed 100.");
    if (a.dryRun) {
      const calculated = input.lineItems ? (await w.run(CDOCS.draftCalculate, { input })).draftOrderCalculate?.calculatedDraftOrder : undefined;
      return {
        dryRun: true, current, calculated, wouldChange: input, notice: PREVIEW,
        ...(calculated ? { calculatedNote: "calculated prices only the fields being changed; the saved draft keeps its other customer, address, shipping and discount settings, so final tax, shipping and total can differ." } : {}),
      };
    }
    const d = await w.run(DRAFT_FILES_DOCS.draftUpdate, { id: a.id, input });
    return { dryRun: false, before: current, draftOrder: d.draftOrderUpdate?.draftOrder };
  },
});

// ------------------------------------------------------------------ files

const ASYNC_NOTE = "Shopify processes files asynchronously: fileStatus starts as UPLOADED or PROCESSING and becomes READY. Check with shopify_search files or shopify_get uploaded_image.";

registerManageOperation("file", {
  description: `Create, rename or delete files in Content > Files, any content type. create (fileCreate) copies a public HTTPS originalSource URL into Shopify as FILE, IMAGE, VIDEO, EXTERNAL_VIDEO or MODEL_3D, with alt and filename. update (fileUpdate) changes alt and filename. delete (fileDelete, up to 50 ids) cannot be undone and needs confirm:"delete"; it lists the files first. ${ASYNC_NOTE}`,
  shape: {
    action: z.enum(["create", "update", "delete"]),
    originalSource: httpsUrl.optional().describe("create: public https:// URL of the file, or the video URL for EXTERNAL_VIDEO."),
    contentType: z.enum(["FILE", "IMAGE", "VIDEO", "EXTERNAL_VIDEO", "MODEL_3D"]).optional().describe("create: defaults to what Shopify detects."),
    alt: z.string().max(512).optional(),
    filename: z.string().min(1).max(255).regex(/^[^/\\]+$/, "filename must not contain slashes").optional(),
    id: fileGid.optional().describe("update: one file GID."),
    ids: z.array(fileGid).min(1).max(50).optional().describe("delete: up to 50 file GIDs."),
  },
  scopes: ["write_files"],
  confirmWord: (a) => (a.action === "delete" ? "delete" : undefined),
  handler: async (w, a) => {
    if (a.action === "create") {
      if (!a.originalSource) throw Error("create needs originalSource.");
      const file: Data = { originalSource: a.originalSource };
      for (const key of ["contentType", "alt", "filename"]) if (a[key] !== undefined) file[key] = a[key];
      if (a.dryRun) return { dryRun: true, wouldCreate: file, notice: PREVIEW };
      const created = (await w.run(DRAFT_FILES_DOCS.fileCreate, { files: [file] })).fileCreate?.files ?? [];
      return { dryRun: false, created, id: created[0]?.id, fileStatus: created[0]?.fileStatus, notice: ASYNC_NOTE };
    }
    const wanted: string[] = a.action === "delete" ? (a.ids ?? []) : a.id ? [a.id] : [];
    if (!wanted.length) throw Error(a.action === "delete" ? "delete needs ids." : "update needs id.");
    if (new Set(wanted).size !== wanted.length) throw Error("ids contains duplicates.");
    const found = ((await w.run(DRAFT_FILES_DOCS.fileRead, { ids: wanted })).nodes ?? []) as (Data | null)[];
    const current = found.filter((node): node is Data => Boolean(node));
    const missing = wanted.filter((id) => !current.some((node) => node.id === id));
    if (missing.length) throw new WorkflowError("These files were not found in this store. No write sent.", { missing });
    if (a.action === "update") {
      const change: Data = { id: a.id };
      for (const key of ["alt", "filename"]) if (a[key] !== undefined) change[key] = a[key];
      if (Object.keys(change).length < 2) throw Error("update needs alt and/or filename.");
      if (a.dryRun) return { dryRun: true, current, wouldChange: change, notice: PREVIEW };
      const updated = (await w.run(DRAFT_FILES_DOCS.fileUpdate, { files: [change] })).fileUpdate?.files ?? [];
      return { dryRun: false, before: current, updated };
    }
    if (a.dryRun) return { dryRun: true, wouldDelete: current, count: current.length, irreversible: true, notice: `${PREVIEW} Also pass confirm:"delete". Pages, products and themes that use a deleted file lose it.` };
    const d = await w.run(DRAFT_FILES_DOCS.fileDelete, { fileIds: wanted });
    return { dryRun: false, deleted: d.fileDelete?.deletedFileIds, was: current };
  },
});
