import {
  getNamedType,
  getNullableType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
} from "graphql";
import { adminSchema } from "../schema.js";

/**
 * A catalog of every Admin API mutation in a bundled schema, for the generic action tools.
 * Everything here is derived from the schema at runtime, except three small hand-kept tables:
 * category overrides, the dedicated-tool map, and scope hints.
 */

export const CATEGORIES = [
  "orders",
  "fulfillment",
  "inventory",
  "products",
  "customers",
  "discounts",
  "content",
  "markets",
  "marketing",
  "checkout",
  "subscriptions",
  "pos",
  "platform",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Exceptions to the prefix rules below. */
const CATEGORY_OVERRIDES: Readonly<Record<string, Category>> = {
  removeFromReturn: "orders",
  productJoinSellingPlanGroups: "subscriptions",
  productLeaveSellingPlanGroups: "subscriptions",
  productVariantJoinSellingPlanGroups: "subscriptions",
  productVariantLeaveSellingPlanGroups: "subscriptions",
  productFeedCreate: "platform",
  productFeedDelete: "platform",
  productFullSync: "platform",
  customerPaymentMethodCreateFromDuplicationData: "subscriptions",
  customerPaymentMethodCreditCardCreate: "subscriptions",
  customerPaymentMethodCreditCardUpdate: "subscriptions",
  customerPaymentMethodGetDuplicationData: "subscriptions",
  customerPaymentMethodGetUpdateUrl: "subscriptions",
  customerPaymentMethodPaypalBillingAgreementCreate: "subscriptions",
  customerPaymentMethodPaypalBillingAgreementUpdate: "subscriptions",
  customerPaymentMethodRemoteCreate: "subscriptions",
  customerPaymentMethodRevoke: "subscriptions",
  customerPaymentMethodSendUpdateEmail: "subscriptions",
  deliveryCustomizationActivation: "checkout",
  deliveryCustomizationCreate: "checkout",
  deliveryCustomizationDelete: "checkout",
  deliveryCustomizationUpdate: "checkout",
  fulfillmentConstraintRuleCreate: "checkout",
  fulfillmentConstraintRuleDelete: "checkout",
  fulfillmentConstraintRuleUpdate: "checkout",
  eventBridgeServerPixelUpdate: "marketing",
  pubSubServerPixelUpdate: "marketing",
  locationLocalPickupDisable: "fulfillment",
  locationLocalPickupEnable: "fulfillment",
  giftCardProductSet: "products",
};

/** Ordered prefix rules; the first match wins. Every mutation must match one (tested). */
const CATEGORY_RULES: ReadonlyArray<readonly [RegExp, Category]> = [
  [/^(order|draftOrder|refund|return|reverse|transactionVoid|dispute|abandonment|paymentReminder|paymentSchedule|paymentTerms|shopifyPayments)/, "orders"],
  [/^(fulfillment|shipping|carrierService|delivery)/, "fulfillment"],
  [/^(inventory|location)/, "inventory"],
  [/^(product|collection|combinedListing|quantity|publication|publishable|bulkProductResourceFeedback|channel)/, "products"],
  [/^(customer|compan|segment|giftCard|storeCredit)/, "customers"],
  [/^discount/, "discounts"],
  [/^(article|blog|page|comment|menu|urlRedirect|theme|file|staged|metafield|metaobject|standardMeta|translations|shopLocale|shopPolicy|scriptTag)/, "content"],
  [/^(market(?!ing)|catalog|priceList|webPresence|backupRegion)/, "markets"],
  [/^(marketing|webPixel|serverPixel)/, "marketing"],
  [/^(checkout|cartTransform|validation|paymentCustomization|taxApp)/, "checkout"],
  [/^(subscription|sellingPlanGroup)/, "subscriptions"],
  [/^(pointOfSale|cashDrawer|cashManagement)/, "pos"],
  [/^(app|bulkOperation|delegateAccessToken|storefrontAccessToken|mobilePlatformApplication|webhookSubscription|eventBridgeWebhook|pubSubWebhook|flow|shopResourceFeedback|savedSearch|privacyFeatures|dataSaleOptOut|consentPolicy|taxSummary|previewInstall|tags)/, "platform"],
];

/** The category for a mutation, or undefined when no rule matches (a test keeps that at zero). */
export function classifyMutation(name: string): Category | undefined {
  const override = CATEGORY_OVERRIDES[name];
  if (override) return override;
  for (const [pattern, category] of CATEGORY_RULES) if (pattern.test(name)) return category;
  return undefined;
}

/**
 * Name fragments that make a mutation destructive: shopify_run_action then requires confirm
 * equal to the mutation name. Keep this the only list.
 */
export const DESTRUCTIVE_WORDS = [
  "delete", "remove", "cancel", "refund", "void", "debit", "deactivate", "revoke", "close",
  "archive", "disable", "erasure", "uninstall", "destroy", "merge", "expire", "dispose", "unpublish",
] as const;
const DESTRUCTIVE_PATTERN = new RegExp(DESTRUCTIVE_WORDS.join("|"), "i");

/**
 * Mutations whose names do not say so but that overwrite or replace data wholesale, move money,
 * or change what customers see at once. They need confirm like the name-matched ones.
 */
export const DESTRUCTIVE_MUTATIONS: ReadonlySet<string> = new Set([
  // Replace whole records or lists: fields, options, variants, addresses, or files left out are removed or overwritten.
  "productSet",
  "customerSet",
  "customerReplaceTaxExemptions",
  "themeFilesUpsert",
  "themeFilesCopy",
  "inventorySetQuantities",
  "inventorySetOnHandQuantities",
  "priceListFixedPricesByProductUpdate",
  "urlRedirectImportSubmit",
  // Change the live storefront at once.
  "themePublish",
  // Commit irreversible order or money changes.
  "orderEditCommit",
  "orderCapture",
  "orderMarkAsPaid",
  "orderCreateMandatePayment",
  "orderCreateManualPayment",
  "paymentScheduleCapture",
  "draftOrderComplete",
  "shippingLabelPurchase",
  "subscriptionBillingAttemptCreate",
  "subscriptionBillingCycleCharge",
  "subscriptionBillingCycleBulkCharge",
  "subscriptionContractPause",
  // Runs arbitrary mutations in bulk; denylisted by default, destructive if an operator allows it.
  "bulkOperationRunMutation",
  // Change what customers see at once: publish to a sales channel, or make a discount live.
  "publishablePublish",
  "publishablePublishToCurrentChannel",
  "productPublish",
  "collectionPublish",
  "discountAutomaticActivate",
  "discountCodeActivate",
  "discountCodeBulkActivate",
  // Email customers; a sent message cannot be recalled.
  "orderInvoiceSend",
  "draftOrderInvoiceSend",
  "paymentReminderSend",
  "customerSendAccountInviteEmail",
  "customerPaymentMethodSendUpdateEmail",
  "companyContactSendWelcomeEmail",
  "giftCardSendNotificationToCustomer",
  "giftCardSendNotificationToRecipient",
  // Issue money or money-equivalent value.
  "giftCardCreate",
  "giftCardCredit",
  "storeCreditAccountCredit",
]);

type Arguments = Readonly<Record<string, unknown>>;

/** One argument-driven rule: the mutation is destructive only when `when` holds for its arguments. */
export interface DestructiveArgumentRule {
  /** Mutation name, or "*" for every mutation. */
  mutation: string;
  /** Why the call is destructive, shown by shopify_describe_action. */
  reason: string;
  when: (args: Arguments) => boolean;
}

const record = (value: unknown): Arguments | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Arguments) : undefined;
const hidesProduct = (status: unknown) => status === "ARCHIVED" || status === "DRAFT";

/** True when key holds `true` anywhere in value (nested inputs and lists included). */
function deepTrue(value: unknown, key: string, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => deepTrue(item, key, depth + 1));
  return Object.entries(value).some(([name, item]) => (name === key && item === true) || deepTrue(item, key, depth + 1));
}

/**
 * Mutations whose names look safe but whose arguments can make them destructive. The arguments
 * are the call's resolved values: inline literals with variables substituted. Keep this the only
 * table of argument rules.
 */
export const DESTRUCTIVE_ARGUMENT_RULES: readonly DestructiveArgumentRule[] = [
  {
    mutation: "productChangeStatus",
    reason: "status ARCHIVED or DRAFT takes the product off every sales channel.",
    when: (args) => hidesProduct(args.status),
  },
  {
    mutation: "productUpdate",
    reason: "product.status (or legacy input.status) ARCHIVED or DRAFT takes the product off every sales channel.",
    when: (args) => hidesProduct(record(args.product)?.status) || hidesProduct(record(args.input)?.status),
  },
  {
    mutation: "productVariantsBulkCreate",
    reason: "strategy REMOVE_STANDALONE_VARIANT deletes the product's default variant.",
    when: (args) => args.strategy === "REMOVE_STANDALONE_VARIANT",
  },
  {
    mutation: "*",
    reason: "notifyCustomer true emails the customer; a sent message cannot be recalled.",
    when: (args) => deepTrue(args, "notifyCustomer"),
  },
];

function argumentRules(name: string): DestructiveArgumentRule[] {
  return DESTRUCTIVE_ARGUMENT_RULES.filter((rule) => rule.mutation === name || rule.mutation === "*");
}

/** Reasons a call to `name` can be destructive depending on its arguments (for describe output). */
export function destructiveWhen(name: string): string[] {
  return DESTRUCTIVE_ARGUMENT_RULES.filter((rule) => rule.mutation === name).map((rule) => rule.reason);
}

/**
 * Whether a mutation is destructive. By name alone when args is omitted; with args (the call's
 * resolved argument values), argument rules from DESTRUCTIVE_ARGUMENT_RULES apply as well.
 */
export function isDestructive(name: string, args?: Arguments): boolean {
  if (DESTRUCTIVE_MUTATIONS.has(name) || DESTRUCTIVE_PATTERN.test(name)) return true;
  if (!args) return false;
  return argumentRules(name).some((rule) => rule.when(args));
}

/**
 * Mutations refused by default: ones that mint credentials or change this app's own installation
 * or billing; webhook and server-pixel subscriptions, which deliver data to an endpoint with the
 * app's scopes long after the caller's own token has expired; and bulkOperationRunMutation, which
 * hides the inner mutation from the denylist and the confirm check.
 * ACTIONS_DENYLIST adds entries (comma list; a trailing * matches a prefix);
 * ACTIONS_DENYLIST_REPLACE=1 makes it replace this list instead.
 */
export const DEFAULT_DENYLIST: readonly string[] = [
  "delegateAccessTokenCreate",
  "delegateAccessTokenDestroy",
  "storefrontAccessTokenCreate",
  "storefrontAccessTokenDelete",
  "appUninstall",
  "appRevokeAccessScopes",
  "appSubscription*",
  "appPurchaseOneTimeCreate",
  "appUsageRecordCreate",
  "mobilePlatformApplication*",
  "webhookSubscriptionCreate",
  "webhookSubscriptionUpdate",
  "webhookSubscriptionDelete",
  "pubSubWebhookSubscription*",
  "eventBridgeWebhookSubscription*",
  "eventBridgeServerPixelUpdate",
  "pubSubServerPixelUpdate",
  "bulkOperationRunMutation",
];

export function denylist(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.ACTIONS_DENYLIST ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const replace = ["1", "true", "yes", "on"].includes((env.ACTIONS_DENYLIST_REPLACE ?? "").trim().toLowerCase());
  if (replace) return extra;
  return [...new Set([...DEFAULT_DENYLIST, ...extra])];
}

export function isDenied(name: string, list: readonly string[] = denylist()): boolean {
  return list.some((entry) => entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : entry === name);
}

/** Mutations that already have a dedicated, guided tool. */
export const DEDICATED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  productCreate: ["shopify_create_product"],
  productUpdate: ["shopify_update_product"],
  productVariantsBulkCreate: ["shopify_create_product"],
  productVariantsBulkUpdate: ["shopify_update_product", "shopify_update_prices"],
  productDeleteMedia: ["shopify_update_product"],
  collectionCreate: ["shopify_create_collection"],
  collectionUpdate: ["shopify_update_collection"],
  collectionAddProducts: ["shopify_create_collection", "shopify_update_collection"],
  publishablePublish: ["shopify_create_collection"],
  inventorySetQuantities: ["shopify_set_inventory"],
  discountCodeBasicCreate: ["shopify_create_discount"],
  stagedUploadsCreate: ["shopify_upload_image"],
  fileCreate: ["shopify_upload_image"],
  metafieldsSet: ["shopify_metafields"],
  metafieldsDelete: ["shopify_metafields"],
  urlRedirectCreate: ["shopify_redirects"],
  urlRedirectDelete: ["shopify_redirects"],
  orderUpdate: ["shopify_update_order"],
  fulfillmentCreate: ["shopify_create_fulfillment"],
  fulfillmentCreateV2: ["shopify_create_fulfillment"],
  tagsAdd: ["shopify_tags", "shopify_update_product", "shopify_update_order", "shopify_update_customer"],
  tagsRemove: ["shopify_tags", "shopify_update_product", "shopify_update_order", "shopify_update_customer"],
  customerUpdate: ["shopify_update_customer"],
};

/** Best-effort scope hints by name prefix; the first match wins. Scopes named in the description win over these. */
const SCOPE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^orderEdit/, "write_order_edits"],
  [/^draftOrder/, "write_draft_orders"],
  [/^(return|removeFromReturn|reverse)/, "write_returns"],
  [/^(order|refund|transactionVoid|abandonment)/, "write_orders"],
  [/^paymentTerms|^paymentReminder|^paymentSchedule/, "write_payment_terms"],
  [/^dispute/, "write_shopify_payments_dispute_evidences"],
  [/^fulfillmentConstraintRule/, "write_fulfillment_constraint_rules"],
  [/^fulfillmentOrder/, "write_merchant_managed_fulfillment_orders"],
  [/^fulfillment/, "write_fulfillments"],
  [/^deliveryCustomization/, "write_delivery_customizations"],
  [/^(carrierService|delivery|shipping|locationLocalPickup)/, "write_shipping"],
  [/^inventoryTransfer/, "write_inventory_transfers"],
  [/^inventoryShipment/, "write_inventory_shipments"],
  [/^inventory/, "write_inventory"],
  [/^location/, "write_locations"],
  [/^(product|sellingPlanGroup)(Join|Leave)SellingPlanGroups|^productVariant(Join|Leave)SellingPlanGroups|^sellingPlanGroup/, "write_purchase_options"],
  [/^productFeed|^productFullSync/, "write_product_feeds"],
  [/^(publication|publishable|productPublish|productUnpublish|collectionPublish|collectionUnpublish)/, "write_publications"],
  [/^(product|collection|combinedListing|quantity|priceList|catalog|giftCardProductSet)/, "write_products"],
  [/^(bulkProductResourceFeedback|shopResourceFeedback)/, "write_resource_feedbacks"],
  [/^customerMerge/, "write_customer_merge"],
  [/^customerPaymentMethod/, "write_customer_payment_methods"],
  [/^compan/, "write_customers"],
  [/^(customer|segment)/, "write_customers"],
  [/^giftCard/, "write_gift_cards"],
  [/^storeCredit/, "write_store_credit_account_transactions"],
  [/^discount/, "write_discounts"],
  [/^(article|blog|page|comment)/, "write_content"],
  [/^(menu|urlRedirect)/, "write_online_store_navigation"],
  [/^theme/, "write_themes"],
  [/^(file|staged)/, "write_files"],
  [/^(metaobjectDefinition|standardMetaobject)/, "write_metaobject_definitions"],
  [/^metaobject/, "write_metaobjects"],
  [/^translations/, "write_translations"],
  [/^shopLocale/, "write_locales"],
  [/^shopPolicy/, "write_legal_policies"],
  [/^scriptTag/, "write_script_tags"],
  [/^(market(?!ing)|webPresence|backupRegion)/, "write_markets"],
  [/^marketing/, "write_marketing_events"],
  [/^(webPixel|serverPixel|eventBridgeServerPixel|pubSubServerPixel)/, "write_pixels"],
  [/^checkoutBranding/, "write_checkout_branding_settings"],
  [/^checkout/, "write_checkouts"],
  [/^cartTransform/, "write_cart_transforms"],
  [/^validation/, "write_validations"],
  [/^paymentCustomization/, "write_payment_customizations"],
  [/^subscription/, "write_own_subscription_contracts"],
  [/^(privacyFeatures|dataSaleOptOut|consentPolicy)/, "write_privacy_settings"],
];

export function scopeHint(name: string, description = ""): string[] {
  const named = [...new Set([...description.matchAll(/\b(write_[a-z_]+[a-z])\b/g)].map((match) => match[1]!))];
  if (named.length) return named;
  for (const [pattern, scope] of SCOPE_RULES) if (pattern.test(name)) return [scope];
  return [];
}

export interface CatalogEntry {
  name: string;
  summary: string;
  category: Category;
  destructive: boolean;
  denied: boolean;
  deprecated: boolean;
  dedicatedTools: string[];
  inputTypes: string[];
  scopeHint: string[];
  /** Lower-case search text: split name words, input type names, and description. */
  searchText: string;
}

/** First sentence of a GraphQL description, without markdown links, capped. */
export function summarize(description: string | null | undefined, max = 200): string {
  if (!description) return "";
  const plain = description.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence.length > max ? `${sentence.slice(0, max - 3)}...` : sentence;
}

function splitWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

const catalogs = new Map<string, Promise<CatalogEntry[]>>();

export function mutationFields(schema: GraphQLSchema): GraphQLField<unknown, unknown>[] {
  const root = schema.getMutationType();
  return root ? Object.values(root.getFields()) : [];
}

/** The catalog for one API version, built once and cached. */
export function actionCatalog(version: string): Promise<CatalogEntry[]> {
  let pending = catalogs.get(version);
  if (!pending) {
    pending = adminSchema(version).then((schema) => {
      const list = denylist();
      return mutationFields(schema).map((field) => {
        const inputTypes = [...new Set(field.args.map((arg) => getNamedType(arg.type).name))];
        const description = field.description ?? "";
        return {
          name: field.name,
          summary: summarize(description),
          category: classifyMutation(field.name) ?? "platform",
          destructive: isDestructive(field.name),
          denied: isDenied(field.name, list),
          deprecated: field.deprecationReason != null,
          dedicatedTools: [...(DEDICATED_TOOLS[field.name] ?? [])],
          inputTypes,
          scopeHint: scopeHint(field.name, description),
          searchText: `${field.name.toLowerCase()} ${splitWords(field.name)} ${inputTypes.join(" ").toLowerCase()} ${splitWords(inputTypes.join(" "))} ${description.toLowerCase()}`,
        };
      });
    });
    catalogs.set(version, pending);
    pending.catch(() => catalogs.delete(version));
  }
  return pending;
}

export interface FindOptions {
  query?: string;
  category?: Category;
  includeDeprecated?: boolean;
  limit: number;
  offset: number;
}

/** Keyword search ranked by where the words match: name first, then input types, then description. */
export function searchCatalog(entries: CatalogEntry[], options: FindOptions) {
  const words = (options.query ?? "").toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  const scored: Array<{ entry: CatalogEntry; score: number }> = [];
  for (const entry of entries) {
    if (options.category && entry.category !== options.category) continue;
    if (!options.includeDeprecated && entry.deprecated) continue;
    let score = 0;
    let matchedAll = true;
    const nameWords = `${entry.name.toLowerCase()} ${splitWords(entry.name)}`;
    const typeWords = `${entry.inputTypes.join(" ").toLowerCase()} ${splitWords(entry.inputTypes.join(" "))}`;
    for (const word of words) {
      const stem = word.length > 3 ? word.replace(/(es|s)$/, "") : word;
      if (nameWords.includes(stem)) score += 10;
      else if (typeWords.includes(stem)) score += 4;
      else if (entry.searchText.includes(stem)) score += 1;
      else matchedAll = false;
    }
    if (words.length && (!matchedAll || score === 0)) continue;
    if (words.length) {
      // Prefer names made of exactly the query words (in any order), then shorter names.
      const parts = splitWords(entry.name).split(" ");
      const stems = words.map((word) => (word.length > 3 ? word.replace(/(es|s)$/, "") : word));
      const covered = parts.filter((part) => stems.some((stem) => part.startsWith(stem))).length;
      if (covered === parts.length) score += 50;
      score -= (parts.length - covered) * 0.5;
    }
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  const page = scored.slice(options.offset, options.offset + options.limit);
  return {
    total: scored.length,
    offset: options.offset,
    ...(options.offset + page.length < scored.length ? { nextOffset: options.offset + page.length } : {}),
    actions: page.map(({ entry }) => ({
      name: entry.name,
      description: entry.summary,
      category: entry.category,
      destructive: entry.destructive,
      ...(entry.deprecated ? { deprecated: true } : {}),
      ...(entry.denied ? { denied: true } : {}),
      dedicatedTools: entry.dedicatedTools,
      scopeHint: entry.scopeHint,
    })),
  };
}

// ---------- Describe ----------

export interface InputFieldDescription {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  defaultValue?: unknown;
  enumValues?: string[];
  fields?: InputFieldDescription[];
  /** Set when the nested fields were not expanded (depth limit or a recursive type). */
  seeType?: string;
}

const ENUM_LIMIT = 60;

function describeInput(type: GraphQLInputType, depth: number, seen: Set<string>): Pick<InputFieldDescription, "enumValues" | "fields" | "seeType"> {
  const named = getNamedType(type);
  if (isEnumType(named)) {
    const values = named.getValues().filter((value) => value.deprecationReason == null).map((value) => value.name);
    return { enumValues: values.length > ENUM_LIMIT ? [...values.slice(0, ENUM_LIMIT), `...${values.length - ENUM_LIMIT} more`] : values };
  }
  if (!isInputObjectType(named)) return {};
  if (depth <= 0 || seen.has(named.name)) return { seeType: named.name };
  const next = new Set(seen).add(named.name);
  return {
    fields: Object.values(named.getFields())
      .filter((field) => field.deprecationReason == null)
      .map((field) => ({
        name: field.name,
        type: String(field.type),
        required: isNonNullType(field.type) && field.defaultValue === undefined,
        ...(field.description ? { description: summarize(field.description, 160) } : {}),
        ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
        ...describeInput(field.type, depth - 1, next),
      })),
  };
}

/** Scalar fields that label a record in previews and default selections. */
export const LABEL_FIELDS = ["title", "name", "displayName", "handle", "sku", "email", "status", "code"] as const;

function simpleField(type: GraphQLObjectType | ReturnType<typeof getNamedType>, name: string): boolean {
  if (!isObjectType(type) && !isInterfaceType(type)) return false;
  const field = type.getFields()[name];
  if (!field || field.args.some((arg) => isNonNullType(arg.type))) return false;
  const named = getNamedType(field.type);
  return isScalarType(named) || isEnumType(named);
}

function isErrorListField(name: string): boolean {
  return /userErrors$/i.test(name);
}

/** A small selection for a returned record: id plus a few label fields, or __typename. */
function recordSelection(type: GraphQLNamedType): string | undefined {
  if (isUnionType(type)) {
    const members = type.getTypes().filter((member) => simpleField(member, "id"));
    return `{ __typename${members.length ? ` ${members.slice(0, 20).map((member) => `... on ${member.name} { id }`).join(" ")}` : ""} }`;
  }
  if (!isObjectType(type) && !isInterfaceType(type)) return undefined;
  if (type.name.endsWith("Connection")) return undefined;
  const picked = ["id", ...LABEL_FIELDS].filter((name) => simpleField(type, name));
  if (!picked.length) return undefined;
  return `{ ${picked.join(" ")} }`;
}

/** Default selection for a mutation payload: scalars, record ids and labels, and every *userErrors list. */
export function defaultSelection(payload: GraphQLOutputType): string {
  const type = getNamedType(payload);
  if (isScalarType(type) || isEnumType(type)) return "";
  if (!isObjectType(type)) return recordSelection(type) ?? "{ __typename }";
  const fields = Object.values(type.getFields()).filter((field) => !field.args.some((arg) => isNonNullType(arg.type)));
  const errorFields = fields.filter((field) => isErrorListField(field.name));
  const liveErrors = errorFields.filter((field) => field.deprecationReason == null);
  const parts: string[] = [];
  for (const field of fields) {
    if (isErrorListField(field.name)) continue;
    if (field.deprecationReason != null) continue;
    const named = getNamedType(field.type);
    if (isScalarType(named) || isEnumType(named)) parts.push(field.name);
    else {
      const selection = recordSelection(named);
      if (selection) parts.push(`${field.name} ${selection}`);
    }
  }
  for (const field of liveErrors.length ? liveErrors : errorFields) {
    const errorType = getNamedType(field.type);
    const picked = ["field", "message", "code"].filter((name) => simpleField(errorType, name));
    parts.push(`${field.name} { ${picked.length ? picked.join(" ") : "__typename"} }`);
  }
  return `{ ${parts.length ? parts.join(" ") : "__typename"} }`;
}

export function findMutation(schema: GraphQLSchema, name: string): GraphQLField<unknown, unknown> | undefined {
  return schema.getMutationType()?.getFields()[name];
}

/** A ready-to-edit document that declares every argument as a variable. */
export function buildDocument(field: GraphQLField<unknown, unknown>, selection = defaultSelection(field.type)): string {
  const operationName = field.name.charAt(0).toUpperCase() + field.name.slice(1);
  const declarations = field.args.map((arg) => `$${arg.name}: ${String(arg.type)}`).join(", ");
  const call = field.args.map((arg) => `${arg.name}: $${arg.name}`).join(", ");
  return `mutation ${operationName}${declarations ? `(${declarations})` : ""} { ${field.name}${call ? `(${call})` : ""}${selection ? ` ${selection}` : ""} }`;
}

/** A variables skeleton with only the required arguments and required input fields. */
function requiredSkeleton(type: GraphQLInputType, depth: number, fieldName = ""): unknown {
  const nullable = getNullableType(type);
  if (isListType(nullable)) return [requiredSkeleton(nullable.ofType as GraphQLInputType, depth, fieldName.replace(/s$/, ""))];
  const named = getNamedType(type);
  if (isEnumType(named)) return named.getValues()[0]?.name ?? null;
  if (isInputObjectType(named)) {
    if (depth <= 0) return {};
    const out: Record<string, unknown> = {};
    for (const field of Object.values(named.getFields())) {
      if (isNonNullType(field.type) && field.defaultValue === undefined) out[field.name] = requiredSkeleton(field.type, depth - 1, field.name);
    }
    return out;
  }
  if (named.name === "ID") {
    const owner = /^(.+?)Id$/.exec(fieldName)?.[1];
    return `gid://shopify/${owner ? owner.charAt(0).toUpperCase() + owner.slice(1) : "<Type>"}/<id>`;
  }
  if (named.name === "Boolean") return false;
  if (named.name === "Int" || named.name === "Float") return 0;
  return `<${named.name}>`;
}

export async function describeAction(name: string, version: string, depth = 3) {
  const schema = await adminSchema(version);
  const field = findMutation(schema, name);
  if (!field) throw new Error(`Unknown mutation ${name} in Admin API ${version}. Use shopify_find_actions to search.`);
  const payload = getNamedType(field.type);
  const variablesTemplate: Record<string, unknown> = {};
  for (const arg of field.args) {
    if (isNonNullType(arg.type) && arg.defaultValue === undefined) variablesTemplate[arg.name] = requiredSkeleton(arg.type, depth, arg.name);
  }
  return {
    name: field.name,
    apiVersion: version,
    description: field.description ?? "",
    category: classifyMutation(field.name) ?? "platform",
    destructive: isDestructive(field.name),
    ...(isDestructive(field.name) ? { confirmRequired: field.name } : {}),
    ...(destructiveWhen(field.name).length ? { destructiveWhen: destructiveWhen(field.name), confirmRequiredWhen: field.name } : {}),
    denied: isDenied(field.name),
    ...(field.deprecationReason != null ? { deprecated: field.deprecationReason } : {}),
    dedicatedTools: [...(DEDICATED_TOOLS[field.name] ?? [])],
    scopeHint: scopeHint(field.name, field.description ?? ""),
    arguments: field.args.map((arg) => ({
      name: arg.name,
      type: String(arg.type),
      required: isNonNullType(arg.type) && arg.defaultValue === undefined,
      ...(arg.description ? { description: summarize(arg.description, 300) } : {}),
      ...(arg.defaultValue !== undefined ? { defaultValue: arg.defaultValue } : {}),
      ...describeInput(arg.type, depth, new Set()),
    })),
    returns: {
      type: String(field.type),
      fields: isObjectType(payload)
        ? Object.values(payload.getFields()).map((child) => ({
            name: child.name,
            type: String(child.type),
            ...(child.deprecationReason != null ? { deprecated: true } : {}),
            ...(child.description ? { description: summarize(child.description, 160) } : {}),
          }))
        : [],
    },
    document: buildDocument(field),
    variablesTemplate,
  };
}
