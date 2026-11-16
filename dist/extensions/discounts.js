import { z } from "zod/v4";
import { registerGetResource, registerManageOperation, registerSearchResource } from "../extension-registry.js";
// Discounts (code and automatic): list, read in full, create, activate, deactivate, delete,
// add redeem codes and a small update. Percentages in this file are fractions from 0 to 1
// (0.2 is 20%), the way the Admin API takes them. Money is a decimal string in shop currency.
const MONEY = "amount currencyCode";
const CONTEXT = `context { __typename ... on DiscountCustomerSegments { segments { id name } } ... on DiscountCustomers { customers { id } } ... on DiscountMarkets { marketsCount markets(first: 10) { nodes { id name } } } }`;
const COMBINES = "combinesWith { productDiscounts orderDiscounts shippingDiscounts }";
const MINIMUM = `minimumRequirement { __typename ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { ${MONEY} } } ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity } }`;
const ITEMS = `items { __typename ... on DiscountProducts { products(first: 25) { nodes { id title } } productVariants(first: 25) { nodes { id displayName } } } ... on DiscountCollections { collections(first: 25) { nodes { id title } } } }`;
const EFFECT = `effect { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { ${MONEY} } appliesOnEachItem } }`;
const GETS = `customerGets { appliesOnOneTimePurchase appliesOnSubscription ${ITEMS} value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { ${MONEY} } appliesOnEachItem } ... on DiscountOnQuantity { quantity { quantity } ${EFFECT} } } }`;
const BUYS = `customerBuys { isOneTimePurchase isSubscription ${ITEMS} value { __typename ... on DiscountPurchaseAmount { amount } ... on DiscountQuantity { quantity } } }`;
const DESTINATION = "destinationSelection { __typename ... on DiscountCountries { countries includeRestOfWorld } ... on DiscountCountryAll { allCountries } }";
const SHIPPING = `${DESTINATION} maximumShippingPrice { ${MONEY} } appliesOnOneTimePurchase appliesOnSubscription`;
const BASE = `title status startsAt endsAt createdAt updatedAt asyncUsageCount discountClasses ${COMBINES} ${CONTEXT}`;
const CODE_BASE = `${BASE} summary usageLimit appliesOncePerCustomer totalSales { ${MONEY} } codesCount { count precision } codes(first: 20) { nodes { code asyncUsageCount } }`;
const AUTO_BASE = `${BASE} summary`;
const DETAIL = `id discount { __typename
  ... on DiscountCodeBasic { ${CODE_BASE} ${GETS} ${MINIMUM} }
  ... on DiscountCodeBxgy { ${CODE_BASE} ${BUYS} ${GETS} usesPerOrderLimit }
  ... on DiscountCodeFreeShipping { ${CODE_BASE} ${MINIMUM} ${SHIPPING} }
  ... on DiscountCodeApp { title status startsAt endsAt createdAt updatedAt asyncUsageCount usageLimit appliesOncePerCustomer ${COMBINES} ${CONTEXT} codesCount { count precision } codes(first: 20) { nodes { code asyncUsageCount } } }
  ... on DiscountAutomaticBasic { ${AUTO_BASE} ${GETS} ${MINIMUM} }
  ... on DiscountAutomaticBxgy { ${AUTO_BASE} ${BUYS} ${GETS} automaticUsesPerOrderLimit: usesPerOrderLimit }
  ... on DiscountAutomaticFreeShipping { ${AUTO_BASE} ${MINIMUM} ${SHIPPING} }
  ... on DiscountAutomaticApp { ${BASE} }
}`;
const LIST_CODE = "title status summary startsAt endsAt asyncUsageCount codesCount { count } codes(first: 3) { nodes { code } }";
const LIST_AUTO = "title status summary startsAt endsAt asyncUsageCount";
const LIST = `id discount { __typename
  ... on DiscountCodeBasic { ${LIST_CODE} }
  ... on DiscountCodeBxgy { ${LIST_CODE} }
  ... on DiscountCodeFreeShipping { ${LIST_CODE} }
  ... on DiscountCodeApp { title status startsAt endsAt asyncUsageCount codesCount { count } codes(first: 3) { nodes { code } } }
  ... on DiscountAutomaticBasic { ${LIST_AUTO} }
  ... on DiscountAutomaticBxgy { ${LIST_AUTO} }
  ... on DiscountAutomaticFreeShipping { ${LIST_AUTO} }
  ... on DiscountAutomaticApp { title status startsAt endsAt asyncUsageCount }
}`;
/** Shopify's names for the three native discount kinds, per method: [type suffix, mutation argument]. */
const NATIVE = {
    code: { Basic: "basicCodeDiscount", Bxgy: "bxgyCodeDiscount", FreeShipping: "freeShippingCodeDiscount" },
    automatic: { Basic: "automaticBasicDiscount", Bxgy: "automaticBxgyDiscount", FreeShipping: "freeShippingAutomaticDiscount" },
};
function writeDocuments() {
    const docs = {};
    for (const method of ["code", "automatic"]) {
        const Method = method === "code" ? "Code" : "Automatic";
        const node = method === "code" ? "codeDiscountNode" : "automaticDiscountNode";
        for (const native of ["Basic", "Bxgy", "FreeShipping"]) {
            const type = `Discount${Method}${native}Input`;
            const field = `discount${Method}${native}`;
            const arg = NATIVE[method][native];
            docs[`create${Method}${native}`] = `mutation Create${Method}${native}($input: ${type}!) { ${field}Create(${arg}: $input) { ${node} { id } userErrors { field message code } } }`;
            docs[`update${Method}${native}`] = `mutation Update${Method}${native}($id: ID!, $input: ${type}!) { ${field}Update(id: $id, ${arg}: $input) { ${node} { id } userErrors { field message code } } }`;
        }
    }
    return docs;
}
export const DISCOUNT_DOCS = {
    list: `query ListDiscounts($first: Int!, $after: String, $query: String) {
  discountNodes(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { ${LIST} } pageInfo { hasNextPage endCursor } }
}`,
    get: `query GetDiscount($id: ID!) { discountNode(id: $id) { ${DETAIL} } }`,
    byCode: `query DiscountByCode($code: String!) { codeDiscountNodeByCode(code: $code) { id codeDiscount { __typename ... on DiscountCodeBasic { title } ... on DiscountCodeBxgy { title } ... on DiscountCodeFreeShipping { title } ... on DiscountCodeApp { title } } } }`,
    codeActivate: `mutation ActivateCodeDiscount($id: ID!) { discountCodeActivate(id: $id) { codeDiscountNode { id } userErrors { field message code } } }`,
    codeDeactivate: `mutation DeactivateCodeDiscount($id: ID!) { discountCodeDeactivate(id: $id) { codeDiscountNode { id } userErrors { field message code } } }`,
    codeDelete: `mutation DeleteCodeDiscount($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { field message code } } }`,
    automaticActivate: `mutation ActivateAutomaticDiscount($id: ID!) { discountAutomaticActivate(id: $id) { automaticDiscountNode { id } userErrors { field message code } } }`,
    automaticDeactivate: `mutation DeactivateAutomaticDiscount($id: ID!) { discountAutomaticDeactivate(id: $id) { automaticDiscountNode { id } userErrors { field message code } } }`,
    automaticDelete: `mutation DeleteAutomaticDiscount($id: ID!) { discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { field message code } } }`,
    addCodes: `mutation AddRedeemCodes($id: ID!, $codes: [DiscountRedeemCodeInput!]!) { discountRedeemCodeBulkAdd(discountId: $id, codes: $codes) { bulkCreation { id done codesCount importedCount failedCount } userErrors { field message code } } }`,
    bulkStatus: `query RedeemCodeBulkStatus($id: ID!) { discountRedeemCodeBulkCreation(id: $id) { id done codesCount importedCount failedCount codes(first: 250) { nodes { code errors { field message code } } } } }`,
    ...writeDocuments(),
};
/** A lookup document for n codes at once, so add_codes checks every code in few requests. */
export function codeLookupDocument(n) {
    const vars = Array.from({ length: n }, (_, i) => `$c${i}: String!`).join(", ");
    const fields = Array.from({ length: n }, (_, i) => `c${i}: codeDiscountNodeByCode(code: $c${i}) { id }`).join(" ");
    return `query DiscountByCodes(${vars}) { ${fields} }`;
}
// ---------------------------------------------------------------- input rules
const money = z
    .string()
    .regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/, 'must be a decimal string such as "10.00"')
    .refine((value) => Number(value) > 0, "must be greater than 0");
/** A percentage as a fraction: 0.2 is 20%, 1 is 100%. */
const fraction = z.number().gt(0).max(1);
const productId = z.string().regex(/^gid:\/\/shopify\/Product\/[0-9]+$/, "must be a Product GID");
const collectionId = z.string().regex(/^gid:\/\/shopify\/Collection\/[0-9]+$/, "must be a Collection GID");
const discountId = z.string().regex(/^gid:\/\/shopify\/Discount(?:Code|Automatic)Node\/[0-9]+$/, "must be a DiscountCodeNode or DiscountAutomaticNode GID");
const when = z.iso.datetime({ offset: true });
const codePattern = /^\S{1,255}$/;
const OPS = ["create", "activate", "deactivate", "delete", "add_codes", "update"];
const SHAPE = {
    action: z.enum(OPS),
    id: discountId.optional().describe("activate, deactivate, delete, add_codes and update: the discount's DiscountCodeNode or DiscountAutomaticNode GID"),
    kind: z.enum(["amount_off", "percentage", "free_shipping", "bxgy"]).optional().describe("create"),
    method: z.enum(["code", "automatic"]).optional().describe("create: code needs code; automatic applies by itself"),
    title: z.string().min(1).max(255).optional().describe("create and update. For a code discount this is the admin label."),
    code: z.string().regex(codePattern, "a code has no spaces, 1 to 255 characters").optional().describe("create, method code"),
    startsAt: when.optional().describe("create (required) and update: ISO 8601 date-time such as 2026-11-20T00:00:00-05:00"),
    endsAt: when.optional().describe("create and update: ISO 8601 date-time, after startsAt"),
    percentage: fraction.optional().describe("kind percentage: a FRACTION from 0 to 1, so 0.2 is 20% off and 1 is 100% off"),
    amount: money.optional().describe('kind amount_off: money as a decimal string in the shop currency, such as "10.00"'),
    appliesOnEachItem: z.boolean().optional().describe("kind amount_off: take the amount off each eligible item instead of once off the eligible total (default false)"),
    appliesOncePerCustomer: z.boolean().optional().describe("create, method code"),
    usageLimit: z.number().int().min(1).max(1_000_000_000).optional().describe("create and update, method code: total redemptions allowed"),
    minimumSubtotal: money.optional().describe("create: minimum eligible subtotal, decimal string"),
    minimumQuantity: z.number().int().min(1).max(1_000_000).optional().describe("create: minimum eligible item quantity"),
    customerEligibility: z.literal("all_customers").optional().describe("create: all customers is the only option"),
    productIds: z.array(productId).min(1).max(100).optional().describe("amount_off and percentage: only these products (default all items)"),
    collectionIds: z.array(collectionId).min(1).max(100).optional().describe("amount_off and percentage: only these collections (default all items)"),
    combinesWith: z
        .object({ productDiscounts: z.boolean().optional(), orderDiscounts: z.boolean().optional(), shippingDiscounts: z.boolean().optional() })
        .strict()
        .optional()
        .describe("create: which other discount classes this one may combine with (default none)"),
    maximumShippingPrice: money.optional().describe("free_shipping: only rates up to this price qualify (default every rate); applies to all countries"),
    buyQuantity: z.number().int().min(1).max(10_000).optional().describe("bxgy: how many items the customer buys"),
    buyProductIds: z.array(productId).min(1).max(100).optional().describe("bxgy: the products that must be bought"),
    buyCollectionIds: z.array(collectionId).min(1).max(100).optional().describe("bxgy: the collections that must be bought"),
    getQuantity: z.number().int().min(1).max(10_000).optional().describe("bxgy: how many items the customer gets discounted"),
    getProductIds: z.array(productId).min(1).max(100).optional().describe("bxgy: the products that are discounted"),
    getCollectionIds: z.array(collectionId).min(1).max(100).optional().describe("bxgy: the collections that are discounted"),
    getPercentage: fraction.optional().describe("bxgy: discount on the items they get, a FRACTION from 0 to 1 (1 means free)"),
    usesPerOrderLimit: z.number().int().min(1).max(10_000).optional().describe("bxgy: how many times the offer applies per order"),
    codes: z.array(z.string().regex(codePattern, "a code has no spaces, 1 to 255 characters")).min(1).max(250).optional().describe("add_codes: up to 250 new codes"),
};
/** Which fields each create kind accepts; anything else set is refused instead of ignored. */
const COMMON = ["action", "kind", "method", "title", "startsAt", "endsAt", "customerEligibility", "combinesWith"];
const CODE_ONLY = ["code", "appliesOncePerCustomer", "usageLimit"];
const ALLOWED = {
    percentage: [...COMMON, "percentage", "productIds", "collectionIds", "minimumSubtotal", "minimumQuantity"],
    amount_off: [...COMMON, "amount", "appliesOnEachItem", "productIds", "collectionIds", "minimumSubtotal", "minimumQuantity"],
    free_shipping: [...COMMON, "maximumShippingPrice", "minimumSubtotal", "minimumQuantity"],
    bxgy: [...COMMON, "buyQuantity", "buyProductIds", "buyCollectionIds", "getQuantity", "getProductIds", "getCollectionIds", "getPercentage", "usesPerOrderLimit"],
};
function givenFields(a) {
    return Object.keys(a).filter((key) => key !== "dryRun" && a[key] !== undefined);
}
function onlyAllowed(a, allowed, what) {
    const extra = givenFields(a).filter((key) => !allowed.includes(key));
    if (extra.length)
        throw Error(`${what} does not take ${extra.join(", ")}. Remove ${extra.length === 1 ? "it" : "them"}; nothing was sent.`);
}
// ---------------------------------------------------------------- plain words
function pct(fractionValue) {
    return `${Number((fractionValue * 100).toFixed(4))}%`;
}
function day(iso) {
    return /T00:00:00(?:\.000)?(?:Z|\+00:00)$/.test(iso) ? iso.slice(0, 10) : iso;
}
function itemWords(products, collections, all = "all products") {
    if (products?.length)
        return `${products.length} selected product${products.length === 1 ? "" : "s"} (${products.join(", ")})`;
    if (collections?.length)
        return `${collections.length} selected collection${collections.length === 1 ? "" : "s"} (${collections.join(", ")})`;
    return all;
}
function combinesWords(c) {
    const on = ["productDiscounts", "orderDiscounts", "shippingDiscounts"].filter((key) => c?.[key]).map((key) => key.replace("Discounts", ""));
    return on.length ? `combines with ${on.join(", ")} discounts` : "does not combine with other discounts";
}
/** The exact discount a create call would make, in plain words. */
export function describeCreate(a) {
    const parts = [];
    if (a.kind === "percentage")
        parts.push(`${pct(a.percentage)} off ${itemWords(a.productIds, a.collectionIds)}`);
    else if (a.kind === "amount_off")
        parts.push(`${a.amount} off (shop currency) ${a.appliesOnEachItem ? "each eligible item" : "the eligible total"} of ${itemWords(a.productIds, a.collectionIds)}`);
    else if (a.kind === "free_shipping")
        parts.push(`Free shipping to all countries${a.maximumShippingPrice ? ` on rates up to ${a.maximumShippingPrice} (shop currency)` : ""}`);
    else
        parts.push(`Buy ${a.buyQuantity} of ${itemWords(a.buyProductIds, a.buyCollectionIds)}, get ${a.getQuantity} of ${itemWords(a.getProductIds, a.getCollectionIds)} at ${a.getPercentage === 1 ? "100% off (free)" : `${pct(a.getPercentage)} off`}${a.usesPerOrderLimit ? `, applies up to ${a.usesPerOrderLimit} time${a.usesPerOrderLimit === 1 ? "" : "s"} per order` : ""}`);
    parts.push(a.method === "code" ? `code ${a.code}` : "automatic discount (no code)");
    parts.push(a.endsAt ? `from ${day(a.startsAt)} to ${day(a.endsAt)}` : `from ${day(a.startsAt)} with no end date`);
    if (a.minimumSubtotal)
        parts.push(`minimum subtotal ${a.minimumSubtotal} (shop currency)`);
    if (a.minimumQuantity)
        parts.push(`minimum ${a.minimumQuantity} item${a.minimumQuantity === 1 ? "" : "s"}`);
    parts.push("all customers");
    if (a.method === "code")
        parts.push(a.appliesOncePerCustomer ? "once per customer" : "no per-customer limit");
    if (a.usageLimit)
        parts.push(`${a.usageLimit} redemption${a.usageLimit === 1 ? "" : "s"} in total`);
    parts.push(combinesWords(a.combinesWith));
    return parts.join(", ");
}
function warnings(a) {
    const out = [];
    const level = a.kind === "percentage" ? a.percentage : undefined;
    if (level !== undefined && level >= 0.5)
        out.push(`${pct(level)} off is a deep discount; check the margin on every item it covers.`);
    if (a.kind === "bxgy" && a.getPercentage === 1)
        out.push("The items they get are free.");
    if (!a.endsAt)
        out.push("No end date: it stays on until someone turns it off.");
    if ((a.kind === "percentage" || a.kind === "amount_off") && !a.productIds && !a.collectionIds && !a.minimumSubtotal && !a.minimumQuantity)
        out.push("It applies to all items with no minimum.");
    if (a.method === "code" && !a.usageLimit && !a.appliesOncePerCustomer)
        out.push("The code has no usage limit and no per-customer limit.");
    return out;
}
// ---------------------------------------------------------------- building the Shopify input
function itemsInput(products, collections) {
    if (products?.length)
        return { products: { productsToAdd: products } };
    if (collections?.length)
        return { collections: { add: collections } };
    return { all: true };
}
function minimumInput(a) {
    if (a.minimumSubtotal)
        return { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: a.minimumSubtotal } } };
    if (a.minimumQuantity)
        return { minimumRequirement: { quantity: { greaterThanOrEqualToQuantity: String(a.minimumQuantity) } } };
    return {};
}
function checkCreate(a) {
    if (!a.kind || !a.method)
        throw Error("create needs kind (amount_off, percentage, free_shipping or bxgy) and method (code or automatic).");
    onlyAllowed(a, [...ALLOWED[a.kind], ...(a.method === "code" ? CODE_ONLY : [])], `A ${a.method} ${a.kind} discount`);
    if (!a.title)
        throw Error("create needs title.");
    if (!a.startsAt)
        throw Error("create needs startsAt, an explicit start date-time.");
    if (a.endsAt && Date.parse(a.endsAt) <= Date.parse(a.startsAt))
        throw Error("endsAt must follow startsAt.");
    if (a.method === "code" && !a.code)
        throw Error("A code discount needs code.");
    if (a.minimumSubtotal && a.minimumQuantity)
        throw Error("Choose a minimum subtotal or a minimum quantity, not both.");
    if (a.kind === "percentage" && a.percentage === undefined)
        throw Error("percentage discounts need percentage, a fraction from 0 to 1 (0.2 is 20%).");
    if (a.kind === "amount_off" && a.amount === undefined)
        throw Error("amount_off discounts need amount, a decimal string such as \"10.00\".");
    if ((a.kind === "percentage" || a.kind === "amount_off") && a.productIds && a.collectionIds)
        throw Error("Choose products or collections, not both.");
    if (a.kind === "bxgy") {
        for (const key of ["buyQuantity", "getQuantity", "getPercentage"])
            if (a[key] === undefined)
                throw Error(`bxgy needs ${key}.`);
        if (Boolean(a.buyProductIds) === Boolean(a.buyCollectionIds))
            throw Error("bxgy needs the items to buy: exactly one of buyProductIds or buyCollectionIds.");
        if (Boolean(a.getProductIds) === Boolean(a.getCollectionIds))
            throw Error("bxgy needs the items to get: exactly one of getProductIds or getCollectionIds.");
    }
}
/** The Discount*Input for a create call. */
export function buildInput(a) {
    const input = {
        title: a.title,
        startsAt: a.startsAt,
        ...(a.endsAt ? { endsAt: a.endsAt } : {}),
        context: { all: "ALL" },
        ...(a.combinesWith ? { combinesWith: a.combinesWith } : {}),
    };
    if (a.method === "code") {
        input.code = a.code;
        input.appliesOncePerCustomer = a.appliesOncePerCustomer ?? false;
        if (a.usageLimit)
            input.usageLimit = a.usageLimit;
    }
    if (a.kind === "percentage") {
        input.customerGets = { value: { percentage: a.percentage }, items: itemsInput(a.productIds, a.collectionIds) };
        Object.assign(input, minimumInput(a));
    }
    else if (a.kind === "amount_off") {
        input.customerGets = { value: { discountAmount: { amount: a.amount, appliesOnEachItem: a.appliesOnEachItem ?? false } }, items: itemsInput(a.productIds, a.collectionIds) };
        Object.assign(input, minimumInput(a));
    }
    else if (a.kind === "free_shipping") {
        input.destination = { all: true };
        if (a.maximumShippingPrice)
            input.maximumShippingPrice = a.maximumShippingPrice;
        Object.assign(input, minimumInput(a));
    }
    else {
        input.customerBuys = { value: { quantity: String(a.buyQuantity) }, items: itemsInput(a.buyProductIds, a.buyCollectionIds) };
        input.customerGets = {
            value: { discountOnQuantity: { quantity: String(a.getQuantity), effect: { percentage: a.getPercentage } } },
            items: itemsInput(a.getProductIds, a.getCollectionIds),
        };
        if (a.usesPerOrderLimit)
            input.usesPerOrderLimit = a.method === "code" ? a.usesPerOrderLimit : String(a.usesPerOrderLimit);
    }
    return input;
}
// ---------------------------------------------------------------- reads
const NATIVE_TYPES = {
    DiscountCodeBasic: { method: "code", native: "Basic" },
    DiscountCodeBxgy: { method: "code", native: "Bxgy" },
    DiscountCodeFreeShipping: { method: "code", native: "FreeShipping" },
    DiscountAutomaticBasic: { method: "automatic", native: "Basic" },
    DiscountAutomaticBxgy: { method: "automatic", native: "Bxgy" },
    DiscountAutomaticFreeShipping: { method: "automatic", native: "FreeShipping" },
};
function isCodeId(id) {
    return id.includes("/DiscountCodeNode/");
}
/** A short, plain description of an existing discount for previews. */
function brief(node) {
    const d = node.discount ?? {};
    return {
        id: node.id,
        type: d.__typename,
        title: d.title,
        status: d.status,
        summary: d.summary,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
        codes: d.codes?.nodes?.map((c) => c.code),
        timesUsed: d.asyncUsageCount,
    };
}
async function current(w, id) {
    const node = (await w.run(DISCOUNT_DOCS.get, { id })).discountNode;
    if (!node?.discount)
        throw Error(`No discount ${id} on this store.`);
    return node;
}
async function mutate(w, document, variables, field) {
    return (await w.run(document, variables))[field] ?? {};
}
const PREVIEW_ENDING = "Nothing was changed. Pass dryRun:false to apply.";
// ---------------------------------------------------------------- resources
registerSearchResource("discounts", {
    document: DISCOUNT_DOCS.list,
    scopes: ["read_discounts"],
    description: 'Code and automatic discounts, newest first, with title, status (ACTIVE, SCHEDULED, EXPIRED), type (__typename), summary, startsAt, endsAt, usage count and the first 3 codes of code discounts. query: Shopify discount search syntax, such as "status:active", "method:code", "type:percentage" (also fixed_amount, free_shipping, bxgy), "title:summer", "times_used:>0" or "starts_at:>2026-11-01".',
});
registerGetResource("discount", {
    document: DISCOUNT_DOCS.get,
    root: "discountNode",
    types: ["DiscountNode", "DiscountCodeNode", "DiscountAutomaticNode"],
    label: "Discount",
    scopes: ["read_discounts"],
    description: "One discount in full: status, summary, dates, value, minimum requirement, who is eligible, items it covers, combinesWith, usage limits and usage, and the first 20 codes with a code count. id: DiscountNode, DiscountCodeNode or DiscountAutomaticNode GID.",
});
// ---------------------------------------------------------------- operation
registerManageOperation("discount", {
    description: "Create, activate, deactivate, delete, add codes to, or lightly update a discount, code or automatic. Percentages are FRACTIONS from 0 to 1 (0.2 is 20% off). Money is a decimal string in the shop currency. create: kind amount_off, percentage, free_shipping or bxgy, method code or automatic, all customers only; refuses a code that already exists; needs an explicit startsAt; the dry run states the exact discount in words. activate and deactivate work on code and automatic discounts. delete needs confirm:\"delete\". add_codes adds up to 250 codes to a code discount and refuses codes that already exist. update changes only title, startsAt, endsAt and usageLimit. Use shopify_create_discount for a quick percentage code with customer segments.",
    shape: SHAPE,
    scopes: ["write_discounts"],
    confirmWord: (a) => (a.action === "delete" ? "delete" : undefined),
    handler: async (w, a) => {
        if (a.action === "create")
            return create(w, a);
        if (!a.id)
            throw Error(`${a.action} needs id, a DiscountCodeNode or DiscountAutomaticNode GID.`);
        const node = await current(w, a.id);
        const was = brief(node);
        const code = isCodeId(a.id);
        switch (a.action) {
            case "activate":
            case "deactivate": {
                onlyAllowed(a, ["action", "id"], a.action);
                const verb = a.action === "activate" ? "Activate" : "Deactivate";
                const doc = DISCOUNT_DOCS[`${code ? "code" : "automatic"}${verb}`];
                if (a.dryRun)
                    return { dryRun: true, current: was, message: `Would ${a.action} "${was.title}" (now ${was.status}). ${PREVIEW_ENDING}` };
                await mutate(w, doc, { id: a.id }, `discount${code ? "Code" : "Automatic"}${verb}`);
                return { dryRun: false, before: was, after: brief(await current(w, a.id)) };
            }
            case "delete": {
                onlyAllowed(a, ["action", "id"], "delete");
                if (a.dryRun)
                    return { dryRun: true, wouldDelete: was, message: 'Nothing was changed. This cannot be undone. Pass dryRun:false and confirm:"delete" to apply.' };
                const d = await w.run(DISCOUNT_DOCS[code ? "codeDelete" : "automaticDelete"], { id: a.id });
                return { dryRun: false, deleted: d.discountCodeDelete?.deletedCodeDiscountId ?? d.discountAutomaticDelete?.deletedAutomaticDiscountId, was };
            }
            case "add_codes":
                return addCodes(w, a, node, was);
            case "update":
                return update(w, a, node, was);
        }
        throw Error(`Unknown action ${a.action}.`);
    },
});
async function create(w, a) {
    checkCreate(a);
    if (a.method === "code") {
        const existing = (await w.run(DISCOUNT_DOCS.byCode, { code: a.code })).codeDiscountNodeByCode;
        if (existing)
            throw Error(`The code ${a.code} already exists (${existing.id}${existing.codeDiscount?.title ? `, "${existing.codeDiscount.title}"` : ""}). Pick a different code, or use add_codes, update or delete on that discount.`);
    }
    const description = describeCreate(a);
    const input = buildInput(a);
    if (a.dryRun)
        return { dryRun: true, wouldCreate: description, warnings: warnings(a), input, message: PREVIEW_ENDING };
    const native = { percentage: "Basic", amount_off: "Basic", free_shipping: "FreeShipping", bxgy: "Bxgy" }[a.kind];
    const Method = a.method === "code" ? "Code" : "Automatic";
    const field = `discount${Method}${native}Create`;
    const d = await w.run(DISCOUNT_DOCS[`create${Method}${native}`], { input });
    const id = d[field]?.codeDiscountNode?.id ?? d[field]?.automaticDiscountNode?.id;
    if (!id)
        throw Error("Shopify returned no discount ID.");
    return { dryRun: false, created: description, warnings: warnings(a), discount: await current(w, id) };
}
async function addCodes(w, a, node, was) {
    onlyAllowed(a, ["action", "id", "codes"], "add_codes");
    if (!isCodeId(a.id))
        throw Error("add_codes works on code discounts; an automatic discount has no codes.");
    if (!a.codes?.length)
        throw Error("add_codes needs codes, 1 to 250 of them.");
    if (node.discount.__typename === "DiscountCodeApp")
        throw Error("This is an app-managed code discount; add its codes in that app.");
    const seen = new Set();
    const duplicates = new Set();
    for (const code of a.codes)
        (seen.has(code.toLowerCase()) ? duplicates : seen).add(code.toLowerCase());
    if (duplicates.size)
        throw Error(`The list repeats ${[...duplicates].slice(0, 10).join(", ")}. Send each code once; nothing was sent.`);
    const taken = [];
    const codes = a.codes;
    for (let i = 0; i < codes.length; i += 50) {
        const chunk = codes.slice(i, i + 50);
        const found = await w.run(codeLookupDocument(chunk.length), Object.fromEntries(chunk.map((code, j) => [`c${j}`, code])));
        chunk.forEach((code, j) => found[`c${j}`] && taken.push(code));
    }
    if (taken.length)
        throw Error(`These codes already exist on this store: ${taken.slice(0, 20).join(", ")}${taken.length > 20 ? ` and ${taken.length - 20} more` : ""}. Remove them and try again; nothing was sent.`);
    if (a.dryRun)
        return { dryRun: true, current: was, wouldAdd: codes.length, sample: codes.slice(0, 10), message: `Would add ${codes.length} code${codes.length === 1 ? "" : "s"} to "${was.title}". ${PREVIEW_ENDING}` };
    const added = await mutate(w, DISCOUNT_DOCS.addCodes, { id: a.id, codes: codes.map((code) => ({ code })) }, "discountRedeemCodeBulkAdd");
    const bulkId = added.bulkCreation?.id;
    let status = added.bulkCreation;
    for (let tries = 0; bulkId && !status?.done && tries < 10; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        status = (await w.run(DISCOUNT_DOCS.bulkStatus, { id: bulkId })).discountRedeemCodeBulkCreation ?? status;
    }
    const failed = (status?.codes?.nodes ?? []).filter((item) => item.errors?.length).map((item) => ({ code: item.code, errors: item.errors }));
    return {
        dryRun: false,
        requested: codes.length,
        bulkCreation: status ? { id: status.id, done: status.done, imported: status.importedCount, failed: status.failedCount } : undefined,
        ...(failed.length ? { failedCodes: failed } : {}),
        ...(status?.done ? {} : { note: "Shopify is still adding the codes; read the discount again in a minute." }),
        discount: brief(await current(w, a.id)),
    };
}
async function update(w, a, node, was) {
    onlyAllowed(a, ["action", "id", "title", "startsAt", "endsAt", "usageLimit"], "update");
    const changes = {};
    for (const key of ["title", "startsAt", "endsAt", "usageLimit"])
        if (a[key] !== undefined)
            changes[key] = a[key];
    if (!Object.keys(changes).length)
        throw Error("update needs at least one of title, startsAt, endsAt or usageLimit.");
    const type = NATIVE_TYPES[node.discount.__typename];
    if (!type)
        throw Error("This is an app-managed discount; change it in the app that made it.");
    if (changes.usageLimit !== undefined && type.method === "automatic")
        throw Error("Automatic discounts have no usage limit.");
    const starts = Date.parse(changes.startsAt ?? node.discount.startsAt);
    const ends = changes.endsAt ?? node.discount.endsAt;
    if (ends && Date.parse(ends) <= starts)
        throw Error("endsAt must follow startsAt.");
    const words = Object.entries(changes).map(([key, value]) => `${key} from ${node.discount[key] ?? "none"} to ${value}`);
    if (a.dryRun)
        return { dryRun: true, current: was, changes, message: `Would change "${was.title}": ${words.join("; ")}. ${PREVIEW_ENDING}` };
    const Method = type.method === "code" ? "Code" : "Automatic";
    await mutate(w, DISCOUNT_DOCS[`update${Method}${type.native}`], { id: a.id, input: changes }, `discount${Method}${type.native}Update`);
    return { dryRun: false, before: was, after: brief(await current(w, a.id)) };
}
//# sourceMappingURL=discounts.js.map