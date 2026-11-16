import "./extensions/index.js";
import { MANAGE_OPERATIONS, registerManageOperation } from "./extension-registry.js";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { textResult, WorkflowError, type Data, type Workflow } from "./admin-workflows.js";
import { CDOCS } from "./commerce-documents.js";
import { DOCS } from "./admin-documents.js";
import { failure, parityWorkflow, sameMoney } from "./parity-tools.js";

// Typed write tools for products, customers, draft orders, order lifecycle and refunds.
// The tool set mirrors the operations GeLi2001/shopify-mcp (MIT) exposes, reimplemented on
// this server's conventions: every tool takes a store alias, defaults to dryRun:true, reads
// the current state before writing, never notifies customers unless asked, and pins its
// GraphQL to PARITY_API_VERSION. See docs/PARITY.md for the comparison table.

const store = z.string().min(1).max(64);
const gid = (type: string) => z.string().regex(new RegExp(`^gid://shopify/${type}/[0-9]+$`));
const money = z.string().regex(/^\d+(\.\d{1,4})?$/);
const countryCode = z.string().regex(/^[A-Z]{2}$/).describe("Two-letter ISO country code, for example US.");
const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const shortText = z.string().max(255);
const tags = z.array(z.string().min(1).max(255)).max(250);
const dryRun = z
  .boolean()
  .default(true)
  .describe(
    "True (the default) reads the current state and returns a preview without changing anything in Shopify. Pass false, after the user authorizes this store and exact change, to apply it.",
  );
const PREVIEW = "Nothing was changed. Pass dryRun:false to apply.";

const address = z
  .object({
    firstName: shortText.optional(),
    lastName: shortText.optional(),
    company: shortText.optional(),
    address1: shortText.optional(),
    address2: shortText.optional(),
    city: shortText.optional(),
    provinceCode: z.string().max(10).optional(),
    countryCode: countryCode.optional(),
    zip: z.string().max(20).optional(),
    phone: z.string().max(40).optional(),
  })
  .strict();

const optionValue = z.object({ optionName: z.string().min(1).max(255), name: z.string().min(1).max(255) }).strict();
const variantFields = {
  price: money.optional(),
  compareAtPrice: money.nullable().optional(),
  sku: shortText.optional(),
  barcode: shortText.nullable().optional(),
  optionValues: z.array(optionValue).min(1).max(3).optional(),
  inventoryPolicy: z.enum(["DENY", "CONTINUE"]).optional().describe("CONTINUE keeps selling when out of stock."),
  taxable: z.boolean().optional(),
  tracked: z.boolean().optional().describe("Track inventory for this variant."),
  cost: money.optional().describe("Unit cost (inventory item cost)."),
  requiresShipping: z.boolean().optional(),
  weight: z.object({ value: z.number().min(0), unit: z.enum(["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"]) }).strict().optional(),
  countryCodeOfOrigin: countryCode.optional(),
  harmonizedSystemCode: z.string().regex(/^[0-9]{6,13}$/).optional(),
};
const newVariant = z.object({ ...variantFields, price: money, optionValues: z.array(optionValue).min(1).max(3) }).strict();
const changedVariant = z.object({ id: gid("ProductVariant"), ...variantFields }).strict();

/** Tool variant arguments to ProductVariantsBulkInput: inventory fields move under inventoryItem. */
export function variantInput(v: Data): Data {
  const { sku, tracked, cost, requiresShipping, weight, countryCodeOfOrigin, harmonizedSystemCode, ...rest } = v;
  const inventoryItem: Data = {};
  if (sku !== undefined) inventoryItem.sku = sku;
  if (tracked !== undefined) inventoryItem.tracked = tracked;
  if (cost !== undefined) inventoryItem.cost = cost;
  if (requiresShipping !== undefined) inventoryItem.requiresShipping = requiresShipping;
  if (weight !== undefined) inventoryItem.measurement = { weight };
  if (countryCodeOfOrigin !== undefined) inventoryItem.countryCodeOfOrigin = countryCodeOfOrigin;
  if (harmonizedSystemCode !== undefined) inventoryItem.harmonizedSystemCode = harmonizedSystemCode;
  return { ...rest, ...(Object.keys(inventoryItem).length ? { inventoryItem } : {}) };
}

export { MANAGE_OPERATIONS };

/** The strict schema one operation's input is checked against (dryRun defaults to true). */
export function operationSchema(name: string) {
  const op = MANAGE_OPERATIONS[name];
  if (!op) throw new Error(`Unknown operation ${name}.`);
  return z.object({ ...op.shape, dryRun }).strict();
}

/** A compact, one-level-deep field list for the tool description: ? marks optional fields. */
function describeSchema(schema: z.ZodType, depth: number): string {
  let inner: any = schema;
  while (["optional", "default", "nullable", "prefault"].includes(inner?.def?.type)) inner = inner.def.innerType;
  const type = inner?.def?.type;
  if (type === "enum") return (inner.options as string[]).join("|");
  if (type === "array") return `[${describeSchema(inner.def.element, depth) || "..."}]`;
  if (type === "object") return depth > 1 ? "{...}" : `{${fieldList(inner.shape, depth + 1)}}`;
  return "";
}
function fieldList(shape: z.ZodRawShape, depth = 0): string {
  return Object.entries(shape)
    .map(([key, schema]) => {
      const optional = (schema as z.ZodType).safeParse(undefined).success ? "?" : "";
      const detail = describeSchema(schema as z.ZodType, depth);
      return `${key}${optional}${detail ? `: ${detail}` : ""}`;
    })
    .join(", ");
}

export function registerCommerceTools(server: McpServer) {
  // Built-in operations register when this module loads; extension areas register on import.
  const names = Object.keys(MANAGE_OPERATIONS) as [string, ...string[]];
  server.registerTool(
    "shopify_manage",
    {
      description: `Guided writes for one store, chosen by operation. Every operation reads the current state first, defaults to dryRun:true (a preview that changes nothing), never notifies customers unless asked, and reads the result back after a write. Put the operation's fields in input. Operations:\n${names
        .map((name) => `- ${name}: ${MANAGE_OPERATIONS[name]!.description} input: {${fieldList(MANAGE_OPERATIONS[name]!.shape)}}`)
        .join("\n")}`,
      inputSchema: z
        .object({
          store,
          operation: z.enum(names),
          input: z.record(z.string(), z.unknown()).default({}).describe("The operation's fields, as listed in the description."),
          dryRun,
          confirm: z
            .string()
            .max(64)
            .optional()
            .describe("Irreversible operations need this with dryRun:false: \"delete\" for delete, \"merge_customers\" for merge_customers, \"cancel\" for order_status cancel."),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const a = args as Data;
      let w: Workflow | undefined;
      try {
        const op = MANAGE_OPERATIONS[a.operation]!;
        // Accept confirm inside input too; it is a tool-level guard, not an operation field.
        const { confirm: innerConfirm, ...fields } = (a.input ?? {}) as Data;
        const confirm = a.confirm ?? innerConfirm;
        const checked = operationSchema(a.operation).safeParse({ ...fields, dryRun: a.dryRun });
        if (!checked.success)
          throw new WorkflowError(`Invalid input for ${a.operation}. No request sent.`, {
            issues: checked.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`),
            expectedFields: fieldList(op.shape),
          });
        const word = checked.data.dryRun ? undefined : op.confirmWord?.(checked.data as Data);
        if (word && confirm !== word)
          throw new WorkflowError(`${a.operation} cannot be undone. Pass confirm:"${word}" with dryRun:false after the user approves this exact change. No request sent.`, { requiredConfirm: word });
        w = await parityWorkflow(a.store);
        if (op.scopes.length) await w.requireScopes(op.scopes);
        const result = await op.handler(w, checked.data as Data);
        return textResult({ store: w.store.alias, shop: w.store.shop, apiVersion: w.store.apiVersion, operation: a.operation, ...result }, false, true);
      } catch (error) {
        return failure(w, error, true);
      }
    },
  );
}

function register(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  scopes: string[],
  handler: (w: Workflow, a: Data) => Promise<Data>,
  confirmWord?: (a: Data) => string | undefined,
) {
  registerManageOperation(name, { description, shape, scopes, handler, confirmWord });
}

  // ---------------------------------------------------------------- products
  register(
    "variants",
    "Create, update and/or delete variants of one product (productVariantsBulkCreate / BulkUpdate / BulkDelete). Updates and deletes must name variants of this product. sku, tracked, cost, weight, requiresShipping, countryCodeOfOrigin and harmonizedSystemCode set the variant's inventory item.",
    {
      productId: gid("Product"),
      create: z.array(newVariant).min(1).max(100).optional(),
      update: z.array(changedVariant).min(1).max(100).optional(),
      delete: z.array(gid("ProductVariant")).min(1).max(100).optional(),
      strategy: z
        .enum(["DEFAULT", "REMOVE_STANDALONE_VARIANT", "PRESERVE_STANDALONE_VARIANT"])
        .optional()
        .describe("For create: REMOVE_STANDALONE_VARIANT replaces the placeholder 'Default Title' variant."),
    },
    ["write_products"],
    async (w, a) => {
      if (!a.create?.length && !a.update?.length && !a.delete?.length) throw Error("Supply create, update and/or delete.");
      const before = (await w.run(CDOCS.productShape, { id: a.productId })).product;
      if (!before) throw Error("Product not found in this store.");
      const known = new Set((before.variants?.nodes ?? []).map((v: Data) => v.id));
      const complete = !before.variants?.pageInfo?.hasNextPage;
      const deleting = new Set<string>(a.delete ?? []);
      const named = [...(a.update ?? []).map((v: Data) => v.id), ...deleting];
      const foreign = complete ? named.filter((id) => !known.has(id)) : [];
      if (foreign.length) throw new WorkflowError("These variants do not belong to this product. No write sent.", { foreign });
      if (complete && deleting.size && [...known].every((id) => deleting.has(id as string)) && !a.create?.length)
        throw Error("Deleting every variant would leave the product with none. Delete the product instead (operation delete).");
      if (a.dryRun)
        return {
          dryRun: true,
          before,
          ...(a.create ? { wouldCreate: a.create } : {}),
          ...(a.update ? { wouldUpdate: a.update } : {}),
          ...(a.delete ? { wouldDelete: a.delete } : {}),
          notice: PREVIEW,
        };
      const out: Data = { dryRun: false, before };
      if (a.update?.length)
        out.updated = (await w.run(CDOCS.variantsUpdate, { productId: a.productId, variants: a.update.map(variantInput) })).productVariantsBulkUpdate?.productVariants;
      if (a.create?.length)
        out.created = (await w.run(CDOCS.variantsCreate, { productId: a.productId, variants: a.create.map(variantInput), strategy: a.strategy })).productVariantsBulkCreate?.productVariants;
      if (a.delete?.length) {
        await w.run(CDOCS.variantsDelete, { productId: a.productId, variantsIds: a.delete });
        out.deleted = a.delete;
      }
      out.after = (await w.run(CDOCS.productShape, { id: a.productId })).product;
      return out;
    },
  );

  register(
    "options",
    "Create, update and/or delete product options such as Size or Color (productOptionsCreate / productOptionUpdate / productOptionsDelete). createVariants:true also creates or removes the variants an option change implies; the default leaves variants as they are.",
    {
      productId: gid("Product"),
      create: z.array(z.object({ name: z.string().min(1).max(255), values: z.array(z.string().min(1).max(255)).min(1).max(100), position: z.number().int().min(1).max(3).optional() }).strict()).min(1).max(3).optional(),
      update: z
        .array(
          z
            .object({
              id: gid("ProductOption"),
              name: z.string().min(1).max(255).optional(),
              position: z.number().int().min(1).max(3).optional(),
              addValues: z.array(z.string().min(1).max(255)).max(100).optional(),
              renameValues: z.array(z.object({ id: gid("ProductOptionValue"), name: z.string().min(1).max(255) }).strict()).max(100).optional(),
              deleteValueIds: z.array(gid("ProductOptionValue")).max(100).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(3)
        .optional(),
      delete: z.array(gid("ProductOption")).min(1).max(3).optional(),
      createVariants: z.boolean().default(false),
    },
    ["write_products"],
    async (w, a) => {
      if (!a.create?.length && !a.update?.length && !a.delete?.length) throw Error("Supply create, update and/or delete.");
      const before = (await w.run(CDOCS.productShape, { id: a.productId })).product;
      if (!before) throw Error("Product not found in this store.");
      const options = new Set((before.options ?? []).map((o: Data) => o.id));
      const foreign = [...(a.update ?? []).map((o: Data) => o.id), ...(a.delete ?? [])].filter((id) => !options.has(id));
      if (foreign.length) throw new WorkflowError("These options do not belong to this product. No write sent.", { foreign });
      if (a.dryRun)
        return {
          dryRun: true,
          before: { id: before.id, title: before.title, options: before.options },
          ...(a.create ? { wouldCreate: a.create } : {}),
          ...(a.update ? { wouldUpdate: a.update } : {}),
          ...(a.delete ? { wouldDelete: a.delete } : {}),
          createVariants: a.createVariants,
          notice: PREVIEW,
        };
      for (const o of a.update ?? [])
        await w.run(CDOCS.optionUpdate, {
          productId: a.productId,
          option: { id: o.id, ...(o.name ? { name: o.name } : {}), ...(o.position ? { position: o.position } : {}) },
          optionValuesToAdd: o.addValues?.map((name: string) => ({ name })),
          optionValuesToUpdate: o.renameValues,
          optionValuesToDelete: o.deleteValueIds,
          variantStrategy: a.createVariants ? "MANAGE" : "LEAVE_AS_IS",
        });
      if (a.create?.length)
        await w.run(CDOCS.optionsCreate, {
          productId: a.productId,
          options: a.create.map((o: Data) => ({ name: o.name, position: o.position, values: o.values.map((name: string) => ({ name })) })),
          variantStrategy: a.createVariants ? "CREATE" : "LEAVE_AS_IS",
        });
      if (a.delete?.length) await w.run(CDOCS.optionsDelete, { productId: a.productId, options: a.delete });
      const after = (await w.run(CDOCS.productShape, { id: a.productId })).product;
      return { dryRun: false, before: before.options, after: after?.options, variantCount: after?.variants?.nodes?.length };
    },
  );

  register(
    "delete",
    "Permanently delete one product or customer by GID (productDelete / customerDelete). This cannot be undone: archive a product (shopify_update_product status ARCHIVED) when it may come back. Shopify refuses to delete a customer who has orders.",
    { id: z.string().regex(/^gid:\/\/shopify\/(Product|Customer)\/[0-9]+$/) },
    [],
    async (w, a) => {
      const isProduct = a.id.includes("/Product/");
      await w.requireScopes([isProduct ? "write_products" : "write_customers"]);
      const record = isProduct
        ? (await w.run(CDOCS.productSummary, { id: a.id })).product
        : (await w.run(CDOCS.customerSummary, { id: a.id })).customer;
      if (!record) throw Error(`${isProduct ? "Product" : "Customer"} not found in this store.`);
      if (a.dryRun) return { dryRun: true, wouldDelete: record, irreversible: true, notice: `${PREVIEW} Also pass confirm:"delete".` };
      const d = isProduct
        ? (await w.run(CDOCS.productDelete, { input: { id: a.id } })).productDelete?.deletedProductId
        : (await w.run(CDOCS.customerDelete, { input: { id: a.id } })).customerDelete?.deletedCustomerId;
      return { dryRun: false, deleted: record, deletedId: d };
    },
    () => "delete",
  );

  // --------------------------------------------------------------- customers
  register(
    "create_customer",
    "Create a customer (customerCreate) and add any addresses (customerAddressCreate; the first becomes the default). Marketing consent is out of scope: record it only from the customer's own opt-in. dryRun:true (the default) checks for an existing customer with the same email and previews the input.",
    {
      firstName: shortText.optional(),
      lastName: shortText.optional(),
      email: z.email().optional(),
      phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/).optional().describe("E.164, for example +16135551111."),
      note: z.string().max(5000).optional(),
      tags: tags.optional(),
      taxExempt: z.boolean().optional(),
      locale: z.string().max(10).optional(),
      addresses: z.array(address).min(1).max(10).optional(),
    },
    ["write_customers"],
    async (w, a) => {
      const { dryRun: preview, addresses, ...input } = a;
      if (!input.email && !input.phone && !input.firstName && !input.lastName) throw Error("Supply at least an email, phone or name.");
      const existing = input.email
        ? ((await w.run(DOCS.customers, { query: `email:"${String(input.email).replace(/["\\]/g, "")}"`, first: 5 })).customers?.nodes ?? [])
        : [];
      if (preview)
        return {
          dryRun: true,
          wouldCreate: input,
          ...(addresses ? { wouldAddAddresses: addresses } : {}),
          ...(existing.length ? { existingCustomersWithEmail: existing, warning: "A customer with this email already exists. Shopify rejects a duplicate email." } : {}),
          notice: PREVIEW,
        };
      const customer = (await w.run(CDOCS.customerCreate, { input })).customerCreate?.customer;
      const added: Data[] = [];
      for (const [index, addr] of (addresses ?? []).entries())
        added.push((await w.run(CDOCS.addressCreate, { customerId: customer.id, address: addr, setAsDefault: index === 0 })).customerAddressCreate?.address);
      return { dryRun: false, customer, addresses: added };
    },
  );

  register(
    "customer_address",
    "Create, update, delete or set the default mailing address of a customer (customerAddressCreate / Update / Delete, customerUpdateDefaultAddress). addressId must belong to the customer.",
    {
      customerId: gid("Customer"),
      action: z.enum(["create", "update", "delete", "set_default"]),
      addressId: z.string().regex(/^gid:\/\/shopify\/MailingAddress\/[0-9]+(\?model_name=CustomerAddress)?$/).optional(),
      address: address.optional(),
      setAsDefault: z.boolean().optional(),
    },
    ["write_customers"],
    async (w, a) => {
      if (a.action !== "create" && !a.addressId) throw Error(`${a.action} needs addressId.`);
      if ((a.action === "create" || a.action === "update") && !a.address) throw Error(`${a.action} needs address.`);
      const before = (await w.run(CDOCS.customerAddresses, { id: a.customerId })).customer;
      if (!before) throw Error("Customer not found in this store.");
      const bare = (id: unknown) => String(id).split("?")[0];
      const match = a.addressId ? (before.addressesV2?.nodes ?? []).find((n: Data) => bare(n.id) === bare(a.addressId)) : undefined;
      if (a.addressId && !match) throw Error("addressId is not one of this customer's addresses.");
      if (match) a.addressId = match.id;
      if (a.dryRun)
        return { dryRun: true, before, wouldApply: { action: a.action, addressId: a.addressId, address: a.address, setAsDefault: a.setAsDefault }, notice: PREVIEW };
      let result: Data | undefined;
      if (a.action === "create")
        result = (await w.run(CDOCS.addressCreate, { customerId: a.customerId, address: a.address, setAsDefault: a.setAsDefault })).customerAddressCreate;
      else if (a.action === "update")
        result = (await w.run(CDOCS.addressUpdate, { customerId: a.customerId, addressId: a.addressId, address: a.address, setAsDefault: a.setAsDefault })).customerAddressUpdate;
      else if (a.action === "delete")
        result = (await w.run(CDOCS.addressDelete, { customerId: a.customerId, addressId: a.addressId })).customerAddressDelete;
      else result = (await w.run(CDOCS.addressDefault, { customerId: a.customerId, addressId: a.addressId })).customerUpdateDefaultAddress;
      const after = (await w.run(CDOCS.customerAddresses, { id: a.customerId })).customer;
      return { dryRun: false, result, before, after };
    },
  );

  register(
    "merge_customers",
    "Merge two customer records into one (customerMerge). This cannot be undone. dryRun:true (the default) runs Shopify's customerMergePreview, which shows the resulting customer, the fields kept and anything blocking the merge. overrideFields chooses which customer's name, email, phone or default address to keep.",
    {
      customerOneId: gid("Customer"),
      customerTwoId: gid("Customer"),
      overrideFields: z
        .object({
          customerIdOfFirstNameToKeep: gid("Customer").optional(),
          customerIdOfLastNameToKeep: gid("Customer").optional(),
          customerIdOfEmailToKeep: gid("Customer").optional(),
          customerIdOfPhoneNumberToKeep: gid("Customer").optional(),
          customerIdOfDefaultAddressToKeep: gid("Customer").optional(),
          note: z.string().max(5000).optional(),
          tags: tags.optional(),
        })
        .strict()
        .optional(),
    },
    ["write_customers", "write_customer_merge"],
    async (w, a) => {
      if (a.customerOneId === a.customerTwoId) throw Error("customerOneId and customerTwoId must differ.");
      const variables = { one: a.customerOneId, two: a.customerTwoId, overrideFields: a.overrideFields };
      const preview = (await w.run(CDOCS.mergePreview, variables)).customerMergePreview;
      const blocked = Boolean(preview?.customerMergeErrors?.length);
      if (a.dryRun) return { dryRun: true, preview, blocked, irreversible: true, notice: `${PREVIEW} Also pass confirm:"merge_customers".` };
      if (blocked) throw new WorkflowError("Shopify reports this merge is blocked. No write sent.", { preview });
      const result = (await w.run(CDOCS.customerMerge, variables)).customerMerge;
      return { dryRun: false, resultingCustomerId: result?.resultingCustomerId, job: result?.job, notice: "Shopify merges in the background; read the resulting customer to confirm." };
    },
    () => "merge_customers",
  );

  // ------------------------------------------------------------ draft orders
  const lineItem = z
    .object({
      variantId: gid("ProductVariant").optional(),
      title: shortText.optional().describe("Custom line item title (with price, instead of variantId)."),
      price: money.optional().describe("Unit price in the order currency: the price of a custom line item, or a price override for a variant."),
      quantity: z.number().int().min(1).max(10000),
      sku: shortText.optional(),
      taxable: z.boolean().optional(),
      requiresShipping: z.boolean().optional(),
    })
    .strict();
  register(
    "create_draft_order",
    "Create a draft order (draftOrderCreate) from variants and/or custom line items, with an optional customer, addresses, discount and shipping line. No invoice is sent. dryRun:true (the default) runs draftOrderCalculate, which returns Shopify's real totals without creating anything.",
    {
      lineItems: z.array(lineItem).min(1).max(100),
      customerId: gid("Customer").optional(),
      email: z.email().optional(),
      phone: z.string().max(40).optional(),
      note: z.string().max(5000).optional(),
      tags: tags.optional(),
      poNumber: shortText.optional(),
      taxExempt: z.boolean().optional(),
      shippingAddress: address.optional(),
      billingAddress: address.optional(),
      useCustomerDefaultAddress: z.boolean().optional(),
      appliedDiscount: z
        .object({ value: z.number().min(0), valueType: z.enum(["FIXED_AMOUNT", "PERCENTAGE"]), title: shortText.optional(), description: shortText.optional() })
        .strict()
        .optional(),
      discountCodes: z.array(z.string().min(1).max(255)).max(5).optional(),
      shippingLine: z.object({ title: shortText, price: money }).strict().optional(),
      currencyCode: currencyCode.optional().describe("Currency for custom prices and shipping; defaults to the shop currency."),
    },
    ["write_draft_orders"],
    async (w, a) => {
      for (const li of a.lineItems)
        if (!li.variantId && !(li.title && li.price)) throw Error("Each line item needs variantId, or title and price.");
      if (a.appliedDiscount?.valueType === "PERCENTAGE" && a.appliedDiscount.value > 100) throw Error("A percentage discount cannot exceed 100.");
      const needsCurrency = a.lineItems.some((li: Data) => li.price) || a.shippingLine;
      const currency = a.currencyCode ?? (needsCurrency ? (await w.run(CDOCS.shopCurrency)).shop?.currencyCode : undefined);
      const input: Data = {
        lineItems: a.lineItems.map((li: Data) => ({
          quantity: li.quantity,
          ...(li.variantId ? { variantId: li.variantId } : { title: li.title }),
          // A custom line item takes its price as originalUnitPrice; a variant line needs priceOverride.
          ...(li.price ? { [li.variantId ? "priceOverride" : "originalUnitPriceWithCurrency"]: { amount: li.price, currencyCode: currency } } : {}),
          ...(li.sku !== undefined ? { sku: li.sku } : {}),
          ...(li.taxable !== undefined ? { taxable: li.taxable } : {}),
          ...(li.requiresShipping !== undefined ? { requiresShipping: li.requiresShipping } : {}),
        })),
        ...(a.customerId ? { purchasingEntity: { customerId: a.customerId } } : {}),
        ...(a.shippingLine ? { shippingLine: { title: a.shippingLine.title, priceWithCurrency: { amount: a.shippingLine.price, currencyCode: currency } } } : {}),
      };
      for (const key of ["email", "phone", "note", "tags", "poNumber", "taxExempt", "shippingAddress", "billingAddress", "useCustomerDefaultAddress", "appliedDiscount", "discountCodes"])
        if (a[key] !== undefined) input[key] = a[key];
      if (a.currencyCode) input.presentmentCurrencyCode = a.currencyCode;
      if (a.dryRun) {
        const calculated = (await w.run(CDOCS.draftCalculate, { input })).draftOrderCalculate?.calculatedDraftOrder;
        return { dryRun: true, calculated, wouldCreate: input, notice: PREVIEW };
      }
      const draftOrder = (await w.run(CDOCS.draftCreate, { input })).draftOrderCreate?.draftOrder;
      return { dryRun: false, draftOrder };
    },
  );

  register(
    "complete_draft_order",
    "Complete a draft order and turn it into a real order (draftOrderComplete). Inventory is reserved and the order appears in the orders list. Without paymentGatewayId Shopify marks the order as paid.",
    { id: gid("DraftOrder"), paymentGatewayId: gid("PaymentGateway").optional() },
    ["write_draft_orders"],
    async (w, a) => {
      const draft = (await w.run(CDOCS.draftOrder, { id: a.id })).draftOrder;
      if (!draft) throw Error("Draft order not found in this store.");
      if (draft.status === "COMPLETED") throw new WorkflowError("This draft order is already completed. No write sent.", { order: draft.order });
      if (a.dryRun) return { dryRun: true, draftOrder: draft, markedAsPaid: !a.paymentGatewayId, notice: PREVIEW };
      const result = (await w.run(CDOCS.draftComplete, { id: a.id, paymentGatewayId: a.paymentGatewayId })).draftOrderComplete;
      return { dryRun: false, draftOrder: result?.draftOrder };
    },
  );

  // ---------------------------------------------------------- order actions
  register(
    "order_status",
    "Cancel, close, reopen or mark an order as paid (orderCancel / orderClose / orderOpen / orderMarkAsPaid). cancel cannot be undone; it refunds the original payment only with refund:true and restocks only with restock:true. notifyCustomer defaults to false. The preview checks the action is allowed.",
    {
      id: gid("Order"),
      action: z.enum(["cancel", "close", "open", "mark_paid"]),
      reason: z.enum(["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "STAFF", "OTHER"]).default("OTHER").describe("cancel only."),
      refund: z.boolean().default(false).describe("cancel only: refund to the original payment methods."),
      restock: z.boolean().default(false).describe("cancel only: return items to inventory."),
      notifyCustomer: z.boolean().default(false).describe("cancel only."),
      staffNote: z.string().max(255).optional().describe("cancel only: internal note."),
    },
    ["write_orders"],
    async (w, a) => {
      const before = (await w.run(CDOCS.orderState, { id: a.id })).order;
      if (!before) throw Error("Order not found in this store.");
      const blocked =
        a.action === "cancel" && before.cancelledAt ? "The order is already cancelled."
        : a.action === "close" && before.closed ? "The order is already closed."
        : a.action === "open" && !before.closed ? "The order is already open."
        : a.action === "mark_paid" && !before.canMarkAsPaid ? "Shopify reports this order cannot be marked as paid."
        : undefined;
      if (blocked) throw new WorkflowError(`${blocked} No write sent.`, { order: before });
      const cancel = { reason: a.reason, refund: a.refund, restock: a.restock, notifyCustomer: a.notifyCustomer, staffNote: a.staffNote };
      if (a.dryRun)
        return { dryRun: true, before, wouldApply: { action: a.action, ...(a.action === "cancel" ? cancel : {}) }, ...(a.action === "cancel" ? { irreversible: true } : {}), notice: a.action === "cancel" ? `${PREVIEW} Also pass confirm:"cancel".` : PREVIEW };
      let result: Data | undefined;
      if (a.action === "cancel")
        result = (await w.run(CDOCS.orderCancel, {
          orderId: a.id,
          reason: a.reason,
          restock: a.restock,
          notifyCustomer: a.notifyCustomer,
          staffNote: a.staffNote,
          ...(a.refund ? { refundMethod: { originalPaymentMethodsRefund: true } } : {}),
        })).orderCancel;
      else if (a.action === "close") result = (await w.run(CDOCS.orderClose, { input: { id: a.id } })).orderClose;
      else if (a.action === "open") result = (await w.run(CDOCS.orderOpen, { input: { id: a.id } })).orderOpen;
      else result = (await w.run(CDOCS.orderMarkAsPaid, { input: { id: a.id } })).orderMarkAsPaid;
      const after = (await w.run(CDOCS.orderState, { id: a.id })).order;
      return {
        dryRun: false,
        result,
        before,
        after,
        ...(a.action === "cancel" ? { notice: "Shopify cancels in the background (job). Read the order again to confirm cancelledAt." } : {}),
      };
    },
    (a) => (a.action === "cancel" ? "cancel" : undefined),
  );

  register(
    "refund",
    "Refund line items and/or shipping on an order (refundCreate). The tool asks Shopify for the suggested refund (amounts, tax and the transactions to refund against) and refunds exactly that. dryRun:true (the default) returns the suggestion. To apply, pass dryRun:false with expectedAmount equal to the suggested total from the preview; any difference stops the write. notify defaults to false.",
    {
      orderId: gid("Order"),
      lineItems: z
        .array(
          z
            .object({
              lineItemId: gid("LineItem"),
              quantity: z.number().int().min(1),
              restockType: z.enum(["NO_RESTOCK", "CANCEL", "RETURN"]).default("NO_RESTOCK"),
              locationId: gid("Location").optional(),
            })
            .strict(),
        )
        .max(250)
        .optional(),
      refundShipping: z.boolean().optional().describe("Refund all remaining shipping."),
      shippingAmount: money.optional().describe("Refund this much shipping instead of all of it."),
      note: z.string().max(5000).optional(),
      notify: z.boolean().default(false),
      expectedAmount: money.optional().describe("Required when dryRun is false: the suggested total (presentment currency) from the preview."),
    },
    ["write_orders"],
    async (w, a) => {
      if (!a.lineItems?.length && !a.refundShipping && !a.shippingAmount) throw Error("Supply lineItems, refundShipping or shippingAmount.");
      if (a.refundShipping && a.shippingAmount) throw Error("Use refundShipping or shippingAmount, not both.");
      const refundLineItems = a.lineItems?.map((li: Data) => ({ lineItemId: li.lineItemId, quantity: li.quantity, restockType: li.restockType, ...(li.locationId ? { locationId: li.locationId } : {}) }));
      const order = (await w.run(CDOCS.suggestedRefund, { id: a.orderId, refundLineItems, refundShipping: a.refundShipping, shippingAmount: a.shippingAmount })).order;
      if (!order) throw Error("Order not found in this store.");
      const suggestion = order.suggestedRefund;
      const total = suggestion?.amountSet?.presentmentMoney?.amount;
      const transactions = (suggestion?.suggestedTransactions ?? [])
        .filter((t: Data) => Number(t.amountSet?.presentmentMoney?.amount) > 0)
        .map((t: Data) => ({ orderId: a.orderId, kind: "REFUND", gateway: t.gateway, amount: t.amountSet.presentmentMoney.amount, ...(t.parentTransaction?.id ? { parentId: t.parentTransaction.id } : {}) }));
      if (a.dryRun)
        return { dryRun: true, order: { id: order.id, name: order.name, totalRefunded: order.totalRefundedSet }, suggestedRefund: suggestion, expectedAmount: total, currency: order.presentmentCurrencyCode, wouldRefundTransactions: transactions, notice: `${PREVIEW} To apply, also pass expectedAmount:"${total}".` };
      if (!a.expectedAmount) throw Error(`dryRun:false needs expectedAmount. Run the preview first; the suggested total is ${total} ${order.presentmentCurrencyCode}.`);
      if (total === undefined || !sameMoney(a.expectedAmount, total))
        throw new WorkflowError("The suggested refund no longer matches expectedAmount. No write sent.", { expectedAmount: a.expectedAmount, suggestedAmount: total });
      const refund = (await w.run(CDOCS.refundCreate, {
        input: {
          orderId: a.orderId,
          notify: a.notify,
          currency: order.presentmentCurrencyCode,
          ...(a.note ? { note: a.note } : {}),
          ...(refundLineItems ? { refundLineItems } : {}),
          ...(a.refundShipping ? { shipping: { fullRefund: true } } : a.shippingAmount ? { shipping: { amount: a.shippingAmount } } : {}),
          ...(transactions.length ? { transactions } : {}),
        },
      })).refundCreate;
      return { dryRun: false, refund: refund?.refund, order: refund?.order };
    },
  );
