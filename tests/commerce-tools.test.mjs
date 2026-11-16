import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "graphql";
import { registerCommerceTools, MANAGE_OPERATIONS, variantInput } from "../dist/commerce-tools.js";
import { registerReadTools } from "../dist/read-tools.js";
import { CDOCS } from "../dist/commerce-documents.js";
import { validateDocument } from "../dist/schema.js";
import { PARITY_API_VERSION } from "../dist/api-versions.js";
import { mutationErrors } from "../dist/operations.js";

const gid = (type, id = 1) => `gid://shopify/${type}/${id}`;
const money = (amount, currencyCode = "USD") => ({ shopMoney: { amount, currencyCode }, presentmentMoney: { amount, currencyCode } });
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const SCOPES = [
  "read_products", "write_products", "read_inventory", "read_customers", "write_customers", "read_orders", "write_orders",
  "read_draft_orders", "write_draft_orders", "read_locations", "write_customer_merge",
];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "shopify-commerce-tools-"));
  const saved = { fetch: globalThis.fetch, config: process.env.SHOPIFY_MULTI_STORE_CONFIG, token: process.env.SHOPIFY_TOKEN_FIXTURE };
  process.env.SHOPIFY_MULTI_STORE_CONFIG = join(directory, "stores.json");
  process.env.SHOPIFY_TOKEN_FIXTURE = "fixture-token";
  await writeFile(process.env.SHOPIFY_MULTI_STORE_CONFIG, JSON.stringify({ stores: [{ alias: "fixture", shop: "fixture.myshopify.com", apiVersion: "2026-07" }] }));
  t.after(async () => {
    globalThis.fetch = saved.fetch;
    if (saved.config === undefined) delete process.env.SHOPIFY_MULTI_STORE_CONFIG;
    else process.env.SHOPIFY_MULTI_STORE_CONFIG = saved.config;
    if (saved.token === undefined) delete process.env.SHOPIFY_TOKEN_FIXTURE;
    else process.env.SHOPIFY_TOKEN_FIXTURE = saved.token;
    await rm(directory, { recursive: true, force: true });
  });

  const tools = new Map();
  const server = { registerTool: (name, definition, callback) => tools.set(name, { definition, callback }) };
  registerCommerceTools(server);
  registerReadTools(server);

  const state = {
    requests: [],
    scopes: [...SCOPES],
    order: { id: gid("Order"), name: "#1001", closed: false, closedAt: null, cancelledAt: null, cancelReason: null, canMarkAsPaid: true, displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED", currentTotalPriceSet: money("50.00"), totalOutstandingSet: money("50.00") },
    product: {
      id: gid("Product"), title: "Tee", status: "ACTIVE",
      options: [{ id: gid("ProductOption"), name: "Size", position: 1, optionValues: [{ id: gid("ProductOptionValue"), name: "S", hasVariants: true }] }],
      variants: { nodes: [{ id: gid("ProductVariant", 1), title: "S", sku: "TEE-S", price: "20.00" }, { id: gid("ProductVariant", 2), title: "M", sku: "TEE-M", price: "20.00" }], pageInfo: { hasNextPage: false } },
    },
    addresses: [{ id: `${gid("MailingAddress", 7)}?model_name=CustomerAddress`, city: "Boston", countryCodeV2: "US" }],
    mergeBlocked: false,
    suggestedTotal: "21.50",
    reject: undefined,
  };

  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const op = parse(body.query).definitions.find((d) => d.kind === "OperationDefinition");
    const name = op.name?.value;
    const root = op.selectionSet.selections[0].name.value;
    const v = body.variables ?? {};
    state.requests.push({ name, variables: v, url: String(url) });
    if (state.reject === name) {
      const errorField = name === "CommerceOrderCancel" ? "orderCancelUserErrors" : "userErrors";
      return Response.json({ data: { [root]: { [errorField]: [{ field: ["id"], message: "Rejected fixture" }] } } });
    }
    let data;
    switch (name) {
      case "StoreCapabilities":
      case "ParityCapabilities":
        data = { shop: { id: gid("Shop"), name: "Fixture", myshopifyDomain: "fixture.myshopify.com" }, currentAppInstallation: { id: gid("AppInstallation"), accessScopes: state.scopes.map((handle) => ({ handle })) } };
        break;
      // reads
      case "CommerceCustomer":
        data = { customer: v.id === gid("Customer") ? { id: v.id, displayName: "Ada", tags: [], orders: page([{ id: gid("Order"), name: "#1001" }]) } : null };
        break;
      case "CommerceDraftOrder":
        data = { draftOrder: { id: v.id, name: "#D1", status: state.draftStatus ?? "OPEN", order: null, lineItems: page([]) } };
        break;
      case "CommerceVariants":
        data = { product: { id: v.id, title: "Tee", options: [], variants: page([{ id: gid("ProductVariant"), barcode: "123", taxable: true, inventoryItem: { harmonizedSystemCode: "610910" } }]) } };
        break;
      case "CommerceOrderTransactions":
        data = { order: { id: v.id, name: "#1001", transactions: [{ id: gid("OrderTransaction"), kind: "SALE", status: "SUCCESS", gateway: "manual", amountSet: money("50.00") }] } };
        break;
      case "CommerceOrderRefunds":
        data = { order: { id: v.id, name: "#1001", refunds: [] } };
        break;
      case "CommerceFulfillmentOrders":
        data = { order: { id: v.id, name: "#1001", fulfillmentOrders: page([{ id: gid("FulfillmentOrder"), status: "OPEN", lineItems: page([]) }]) } };
        break;
      case "CommerceLocations":
        data = { locations: page([{ id: gid("Location"), name: "Warehouse", isActive: true }]) };
        break;
      case "CommercePriceLists":
        data = { priceLists: page([{ id: gid("PriceList"), name: "CAD", currency: "CAD" }]) };
        break;
      case "CommerceMetafieldDefinitions":
        data = { metafieldDefinitions: page([{ id: gid("MetafieldDefinition"), namespace: "custom", key: "care", ownerType: v.type }]) };
        break;
      case "CommerceDraftOrders":
        data = { draftOrders: page([{ id: gid("DraftOrder"), name: "#D1" }]) };
        break;
      // products
      case "CommerceProductShape":
        data = { product: v.id === gid("Product") ? state.product : null };
        break;
      case "CommerceVariantsCreate":
        data = { productVariantsBulkCreate: { productVariants: v.variants.map((x, i) => ({ id: gid("ProductVariant", 100 + i), title: "new", sku: x.inventoryItem?.sku ?? null, price: x.price })), userErrors: [] } };
        break;
      case "CommerceVariantsUpdate":
        data = { productVariantsBulkUpdate: { productVariants: v.variants.map((x) => ({ id: x.id, title: "S", sku: null, price: x.price ?? "20.00" })), userErrors: [] } };
        break;
      case "CommerceVariantsDelete":
        data = { productVariantsBulkDelete: { product: { id: v.productId }, userErrors: [] } };
        break;
      case "CommerceOptionsCreate":
      case "CommerceOptionUpdate":
      case "CommerceOptionsDelete":
        data = { [root]: { product: { id: v.productId, options: state.product.options }, ...(name === "CommerceOptionsDelete" ? { deletedOptionsIds: v.options } : {}), userErrors: [] } };
        break;
      case "CommerceProductSummary":
        data = { product: { id: v.id, title: "Tee", handle: "tee", status: "ACTIVE", totalInventory: 3, variantsCount: { count: 2 } } };
        break;
      case "CommerceProductDelete":
        data = { productDelete: { deletedProductId: v.input.id, userErrors: [] } };
        break;
      case "CommerceCustomerSummary":
        data = { customer: { id: v.id, displayName: "Ada", email: "ada@example.com", numberOfOrders: "0", amountSpent: { amount: "0.0", currencyCode: "USD" } } };
        break;
      case "CommerceCustomerDelete":
        data = { customerDelete: { deletedCustomerId: v.input.id, userErrors: [] } };
        break;
      // customers
      case "ListCustomers":
        data = { customers: page(state.existingEmail && v.query.includes(state.existingEmail) ? [{ id: gid("Customer", 9), displayName: "Existing", email: state.existingEmail }] : []) };
        break;
      case "CommerceCustomerCreate":
        data = { customerCreate: { customer: { id: gid("Customer", 2), displayName: "New", ...v.input }, userErrors: [] } };
        break;
      case "CommerceAddressCreate":
        data = { customerAddressCreate: { address: { id: gid("MailingAddress", 8), ...v.address }, userErrors: [] } };
        break;
      case "CommerceCustomerAddresses":
        data = { customer: { id: v.id, displayName: "Ada", defaultAddress: { id: state.addresses[0]?.id }, addressesV2: page(state.addresses) } };
        break;
      case "CommerceAddressUpdate":
        data = { customerAddressUpdate: { address: { id: v.addressId, ...v.address }, userErrors: [] } };
        break;
      case "CommerceAddressDelete":
        data = { customerAddressDelete: { deletedAddressId: v.addressId, userErrors: [] } };
        break;
      case "CommerceAddressDefault":
        data = { customerUpdateDefaultAddress: { customer: { id: v.customerId, defaultAddress: { id: v.addressId } }, userErrors: [] } };
        break;
      case "CommerceMergePreview":
        data = { customerMergePreview: { resultingCustomerId: v.two, blockingFields: null, customerMergeErrors: state.mergeBlocked ? [{ errorFields: ["NOTE"], message: "Note too long" }] : [], defaultFields: { displayName: "Ada" } } };
        break;
      case "CommerceCustomerMerge":
        data = { customerMerge: { resultingCustomerId: v.two, job: { id: gid("Job"), done: false }, userErrors: [] } };
        break;
      // draft orders
      case "CommerceShopCurrency":
        data = { shop: { currencyCode: "USD" } };
        break;
      case "CommerceDraftCalculate":
        data = { draftOrderCalculate: { calculatedDraftOrder: { currencyCode: "USD", totalPriceSet: money("45.00"), lineItems: [] }, userErrors: [] } };
        break;
      case "CommerceDraftCreate":
        data = { draftOrderCreate: { draftOrder: { id: gid("DraftOrder"), name: "#D1", status: "OPEN" }, userErrors: [] } };
        break;
      case "CommerceDraftComplete":
        data = { draftOrderComplete: { draftOrder: { id: v.id, status: "COMPLETED", order: { id: gid("Order", 5), name: "#1005", displayFinancialStatus: "PAID" } }, userErrors: [] } };
        break;
      // orders
      case "CommerceOrderState":
        data = { order: state.order };
        break;
      case "CommerceOrderCancel":
        state.order = { ...state.order, cancelledAt: "2026-11-16T12:00:00Z" };
        data = { orderCancel: { job: { id: gid("Job"), done: false }, orderCancelUserErrors: [] } };
        break;
      case "CommerceOrderClose":
        state.order = { ...state.order, closed: true };
        data = { orderClose: { order: { id: v.input.id, closed: true, closedAt: "now" }, userErrors: [] } };
        break;
      case "CommerceOrderOpen":
        state.order = { ...state.order, closed: false };
        data = { orderOpen: { order: { id: v.input.id, closed: false, closedAt: null }, userErrors: [] } };
        break;
      case "CommerceOrderMarkAsPaid":
        state.order = { ...state.order, canMarkAsPaid: false, displayFinancialStatus: "PAID" };
        data = { orderMarkAsPaid: { order: { id: v.input.id, displayFinancialStatus: "PAID", totalOutstandingSet: money("0.00") }, userErrors: [] } };
        break;
      case "CommerceSuggestedRefund":
        data = { order: { id: v.id, name: "#1001", presentmentCurrencyCode: "USD", totalRefundedSet: money("0.00"), suggestedRefund: {
          amountSet: money(state.suggestedTotal), subtotalSet: money("20.00"), totalTaxSet: money("1.50"),
          shipping: { amountSet: money("0.00"), maximumRefundableSet: money("5.00") }, refundLineItems: [],
          suggestedTransactions: [
            { kind: "SUGGESTED_REFUND", gateway: "shopify_payments", amountSet: money(state.suggestedTotal), maximumRefundableSet: money("50.00"), parentTransaction: { id: gid("OrderTransaction"), kind: "SALE" } },
            { kind: "SUGGESTED_REFUND", gateway: "gift_card", amountSet: money("0.00"), maximumRefundableSet: money("0.00"), parentTransaction: null },
          ],
        } } };
        break;
      case "CommerceRefundCreate":
        data = { refundCreate: { refund: { id: gid("Refund"), totalRefundedSet: money(state.suggestedTotal), transactions: page([]) }, order: { id: v.input.orderId, displayFinancialStatus: "PARTIALLY_REFUNDED" }, userErrors: [] } };
        break;
      default:
        throw new Error(`Unmocked operation ${name}`);
    }
    return Response.json({ data });
  };

  const manage = async (operation, input = {}, dryRun = true, confirm) => {
    const tool = tools.get("shopify_manage");
    const result = await tool.callback(tool.definition.inputSchema.parse({ store: "fixture", operation, input, dryRun, ...(confirm ? { confirm } : {}) }));
    return { ...result, json: JSON.parse(result.content[0].text) };
  };
  const read = async (tool, args) => {
    const t = tools.get(`shopify_${tool}`);
    const result = await t.callback(t.definition.inputSchema.parse({ store: "fixture", ...args }));
    return { ...result, json: JSON.parse(result.content[0].text) };
  };
  const sent = (name) => state.requests.filter((r) => r.name === name);
  return { state, tools, manage, read, sent };
}

test("every commerce document validates against the pinned Admin schema", async () => {
  for (const [name, document] of Object.entries(CDOCS)) {
    const errors = await validateDocument(document, PARITY_API_VERSION);
    assert.deepEqual(errors, [], name);
  }
});

test("shopify_manage registers one tool that lists every operation and its fields", async (t) => {
  const { tools } = await fixture(t);
  const tool = tools.get("shopify_manage");
  assert.ok(tool);
  assert.equal(tool.definition.annotations.readOnlyHint, false);
  for (const name of Object.keys(MANAGE_OPERATIONS)) assert.match(tool.definition.description, new RegExp(`- ${name}: `));
  assert.deepEqual(Object.keys(MANAGE_OPERATIONS).sort(), ["complete_draft_order", "create_customer", "create_draft_order", "customer_address", "delete", "merge_customers", "options", "order_status", "refund", "variants"]);
  assert.match(tool.definition.description, /inventoryPolicy\?: DENY\|CONTINUE/);
});

test("shopify_manage rejects invalid input before any request", async (t) => {
  const { manage, state } = await fixture(t);
  const r = await manage("variants", { productId: "not-a-gid" });
  assert.equal(r.isError, true);
  assert.match(r.json.error, /Invalid input for variants/);
  assert.ok(r.json.expectedFields.includes("productId"));
  const extra = await manage("delete", { id: gid("Product"), surprise: true });
  assert.equal(extra.isError, true);
  assert.equal(state.requests.length, 0);
});

test("a write without the required scope stops before reading or writing", async (t) => {
  const { manage, state, sent } = await fixture(t);
  state.scopes = state.scopes.filter((s) => s !== "write_orders");
  const r = await manage("order_status", { id: gid("Order"), action: "close" }, false);
  assert.equal(r.isError, true);
  assert.equal(sent("CommerceOrderClose").length, 0);
});

test("variants: preview, foreign-variant guard, then create, update and delete", async (t) => {
  const { manage, sent } = await fixture(t);
  const preview = await manage("variants", { productId: gid("Product"), create: [{ price: "22.00", sku: "TEE-L", optionValues: [{ optionName: "Size", name: "L" }], cost: "8.00", weight: { value: 200, unit: "GRAMS" } }] });
  assert.equal(preview.isError, undefined);
  assert.equal(preview.json.dryRun, true);
  assert.equal(preview.json.before.variants.nodes.length, 2);
  assert.equal(sent("CommerceVariantsCreate").length, 0);

  const foreign = await manage("variants", { productId: gid("Product"), delete: [gid("ProductVariant", 99)] }, false);
  assert.equal(foreign.isError, true);
  assert.deepEqual(foreign.json.foreign, [gid("ProductVariant", 99)]);

  const dup = await manage("variants", { productId: gid("Product"), delete: [gid("ProductVariant", 1), gid("ProductVariant", 1)] });
  assert.equal(dup.isError, undefined, "a repeated id is not every variant");
  const all = await manage("variants", { productId: gid("Product"), delete: [gid("ProductVariant", 1), gid("ProductVariant", 2)] }, false);
  assert.equal(all.isError, true);
  assert.match(all.json.error, /leave the product with none/);

  const applied = await manage("variants", {
    productId: gid("Product"),
    create: [{ price: "22.00", sku: "TEE-L", optionValues: [{ optionName: "Size", name: "L" }], cost: "8.00" }],
    update: [{ id: gid("ProductVariant", 1), price: "19.00", barcode: "999" }],
    delete: [gid("ProductVariant", 2)],
    strategy: "DEFAULT",
  }, false);
  assert.equal(applied.isError, undefined, applied.content[0].text);
  assert.equal(applied.json.dryRun, false);
  const created = sent("CommerceVariantsCreate")[0].variables;
  assert.deepEqual(created.variants[0].inventoryItem, { sku: "TEE-L", cost: "8.00" });
  assert.equal(created.variants[0].sku, undefined, "sku goes under inventoryItem");
  assert.deepEqual(sent("CommerceVariantsDelete")[0].variables.variantsIds, [gid("ProductVariant", 2)]);
  assert.ok(applied.json.after);
});

test("variantInput moves inventory fields under inventoryItem and keeps variant fields", () => {
  assert.deepEqual(
    variantInput({ id: "x", price: "1", sku: "A", tracked: true, weight: { value: 1, unit: "POUNDS" }, harmonizedSystemCode: "610910", inventoryPolicy: "DENY" }),
    { id: "x", price: "1", inventoryPolicy: "DENY", inventoryItem: { sku: "A", tracked: true, measurement: { weight: { value: 1, unit: "POUNDS" } }, harmonizedSystemCode: "610910" } },
  );
  assert.deepEqual(variantInput({ price: "1" }), { price: "1" });
});

test("options: create, update and delete with variant strategies", async (t) => {
  const { manage, sent } = await fixture(t);
  const foreign = await manage("options", { productId: gid("Product"), delete: [gid("ProductOption", 5)] });
  assert.equal(foreign.isError, true);
  const preview = await manage("options", { productId: gid("Product"), create: [{ name: "Color", values: ["Red"] }] });
  assert.equal(preview.json.dryRun, true);
  assert.equal(sent("CommerceOptionsCreate").length, 0);
  const applied = await manage("options", {
    productId: gid("Product"),
    create: [{ name: "Color", values: ["Red", "Blue"] }],
    update: [{ id: gid("ProductOption"), name: "Fit", addValues: ["XL"], renameValues: [{ id: gid("ProductOptionValue"), name: "Small" }] }],
    delete: [gid("ProductOption")],
    createVariants: true,
  }, false);
  assert.equal(applied.isError, undefined, applied.content[0].text);
  assert.equal(sent("CommerceOptionsCreate")[0].variables.variantStrategy, "CREATE");
  assert.deepEqual(sent("CommerceOptionsCreate")[0].variables.options[0].values, [{ name: "Red" }, { name: "Blue" }]);
  assert.equal(sent("CommerceOptionUpdate")[0].variables.variantStrategy, "MANAGE");
  assert.deepEqual(sent("CommerceOptionUpdate")[0].variables.optionValuesToAdd, [{ name: "XL" }]);
  assert.deepEqual(sent("CommerceOptionsDelete")[0].variables.options, [gid("ProductOption")]);
});

test("delete: previews the record, then deletes a product or customer with the matching scope", async (t) => {
  const { manage, sent, state } = await fixture(t);
  const preview = await manage("delete", { id: gid("Product") });
  assert.equal(preview.json.irreversible, true);
  assert.equal(preview.json.wouldDelete.title, "Tee");
  assert.equal(sent("CommerceProductDelete").length, 0);
  const unconfirmed = await manage("delete", { id: gid("Product") }, false);
  assert.equal(unconfirmed.isError, true);
  assert.equal(unconfirmed.json.requiredConfirm, "delete");
  assert.equal(sent("CommerceProductSummary").length, 1, "no request without confirm");
  const wrongWord = await manage("delete", { id: gid("Product") }, false, "yes");
  assert.equal(wrongWord.isError, true);
  const inner = await manage("delete", { id: gid("Product", 4), confirm: "delete" }, false);
  assert.equal(inner.isError, undefined, "confirm inside input is accepted");
  const product = await manage("delete", { id: gid("Product") }, false, "delete");
  assert.equal(product.json.deletedId, gid("Product"));
  const customer = await manage("delete", { id: gid("Customer") }, false, "delete");
  assert.equal(customer.json.deletedId, gid("Customer"));
  state.scopes = state.scopes.filter((s) => s !== "write_customers");
  const denied = await manage("delete", { id: gid("Customer", 3) }, false, "delete");
  assert.equal(denied.isError, true);
  assert.equal(sent("CommerceCustomerDelete").length, 1);
  const order = await manage("delete", { id: gid("Order") });
  assert.equal(order.isError, true, "only products and customers");
});

test("create_customer: warns about an existing email, creates and adds addresses with the first as default", async (t) => {
  const { manage, sent, state } = await fixture(t);
  state.existingEmail = "ada@example.com";
  const preview = await manage("create_customer", { email: "ada@example.com", firstName: "Ada" });
  assert.equal(preview.json.existingCustomersWithEmail.length, 1);
  assert.match(preview.json.warning, /already exists/);
  const none = await manage("create_customer", { note: "x" });
  assert.equal(none.isError, true);
  const created = await manage("create_customer", { email: "new@example.com", firstName: "New", tags: ["vip"], addresses: [{ city: "Boston", countryCode: "US" }, { city: "Austin", countryCode: "US" }] }, false);
  assert.equal(created.isError, undefined, created.content[0].text);
  assert.equal(sent("CommerceCustomerCreate")[0].variables.input.addresses, undefined, "addresses are added separately");
  assert.deepEqual(sent("CommerceAddressCreate").map((r) => r.variables.setAsDefault), [true, false]);
  assert.equal(created.json.addresses.length, 2);
  const badPhone = await manage("create_customer", { phone: "555-1234" });
  assert.equal(badPhone.isError, true);
});

test("customer_address: checks ownership, accepts Shopify's address id form, and runs each action", async (t) => {
  const { manage, sent } = await fixture(t);
  const foreign = await manage("customer_address", { customerId: gid("Customer"), action: "delete", addressId: gid("MailingAddress", 99) }, false);
  assert.equal(foreign.isError, true);
  assert.match(foreign.json.error, /not one of this customer's addresses/);
  const missing = await manage("customer_address", { customerId: gid("Customer"), action: "update", addressId: gid("MailingAddress", 7) });
  assert.equal(missing.isError, true, "update needs address");
  const preview = await manage("customer_address", { customerId: gid("Customer"), action: "create", address: { city: "Austin", countryCode: "US" } });
  assert.equal(preview.json.dryRun, true);
  assert.equal(sent("CommerceAddressCreate").length, 0);
  await manage("customer_address", { customerId: gid("Customer"), action: "create", address: { city: "Austin" }, setAsDefault: true }, false);
  await manage("customer_address", { customerId: gid("Customer"), action: "update", addressId: gid("MailingAddress", 7), address: { city: "Cambridge" } }, false);
  await manage("customer_address", { customerId: gid("Customer"), action: "set_default", addressId: gid("MailingAddress", 7) }, false);
  const del = await manage("customer_address", { customerId: gid("Customer"), action: "delete", addressId: gid("MailingAddress", 7) }, false);
  assert.equal(del.isError, undefined, del.content[0].text);
  assert.equal(sent("CommerceAddressUpdate")[0].variables.addressId, `${gid("MailingAddress", 7)}?model_name=CustomerAddress`);
  assert.equal(sent("CommerceAddressDefault").length, 1);
  assert.equal(sent("CommerceAddressDelete").length, 1);
});

test("merge_customers: previews with customerMergePreview and refuses a blocked or self merge", async (t) => {
  const { manage, sent, state } = await fixture(t);
  const self = await manage("merge_customers", { customerOneId: gid("Customer"), customerTwoId: gid("Customer") });
  state.scopes = state.scopes.filter((s) => s !== "write_customer_merge");
  const noScope = await manage("merge_customers", { customerOneId: gid("Customer", 1), customerTwoId: gid("Customer", 2) });
  assert.deepEqual(noScope.json.missingScopes, ["write_customer_merge"]);
  state.scopes.push("write_customer_merge");
  assert.equal(self.isError, true);
  const preview = await manage("merge_customers", { customerOneId: gid("Customer", 1), customerTwoId: gid("Customer", 2) });
  assert.equal(preview.json.irreversible, true);
  assert.equal(preview.json.preview.resultingCustomerId, gid("Customer", 2));
  assert.equal(sent("CommerceCustomerMerge").length, 0);
  state.mergeBlocked = true;
  const blocked = await manage("merge_customers", { customerOneId: gid("Customer", 1), customerTwoId: gid("Customer", 2) }, false, "merge_customers");
  assert.equal(blocked.isError, true);
  assert.equal(sent("CommerceCustomerMerge").length, 0);
  state.mergeBlocked = false;
  const unconfirmed = await manage("merge_customers", { customerOneId: gid("Customer", 1), customerTwoId: gid("Customer", 2) }, false);
  assert.equal(unconfirmed.json.requiredConfirm, "merge_customers");
  const merged = await manage("merge_customers", { customerOneId: gid("Customer", 1), customerTwoId: gid("Customer", 2), overrideFields: { customerIdOfEmailToKeep: gid("Customer", 1) } }, false, "merge_customers");
  assert.equal(merged.json.resultingCustomerId, gid("Customer", 2));
  assert.deepEqual(sent("CommerceCustomerMerge")[0].variables.overrideFields, { customerIdOfEmailToKeep: gid("Customer", 1) });
});

test("create_draft_order: preview calculates real totals; apply creates with the shop currency for custom prices", async (t) => {
  const { manage, sent } = await fixture(t);
  const bad = await manage("create_draft_order", { lineItems: [{ title: "Custom", quantity: 1 }] });
  assert.equal(bad.isError, true, "custom line items need a price");
  const pct = await manage("create_draft_order", { lineItems: [{ variantId: gid("ProductVariant"), quantity: 1 }], appliedDiscount: { value: 150, valueType: "PERCENTAGE" } });
  assert.equal(pct.isError, true);
  const preview = await manage("create_draft_order", {
    lineItems: [{ variantId: gid("ProductVariant"), quantity: 2 }, { title: "Engraving", price: "5.00", quantity: 1 }],
    customerId: gid("Customer"),
    shippingLine: { title: "Ground", price: "7.00" },
    tags: ["phone-order"],
  });
  assert.equal(preview.json.calculated.totalPriceSet.shopMoney.amount, "45.00");
  assert.equal(sent("CommerceDraftCreate").length, 0);
  const input = sent("CommerceDraftCalculate")[0].variables.input;
  assert.deepEqual(input.purchasingEntity, { customerId: gid("Customer") });
  assert.deepEqual(input.lineItems[1].originalUnitPriceWithCurrency, { amount: "5.00", currencyCode: "USD" });
  assert.deepEqual(input.shippingLine, { title: "Ground", priceWithCurrency: { amount: "7.00", currencyCode: "USD" } });
  const override = await manage("create_draft_order", { lineItems: [{ variantId: gid("ProductVariant"), price: "9.00", quantity: 1 }] });
  const overrideInput = sent("CommerceDraftCalculate")[1].variables.input.lineItems[0];
  assert.deepEqual(overrideInput.priceOverride, { amount: "9.00", currencyCode: "USD" });
  assert.equal(overrideInput.originalUnitPriceWithCurrency, undefined);
  assert.equal(override.isError, undefined);
  const created = await manage("create_draft_order", { lineItems: [{ variantId: gid("ProductVariant"), quantity: 1 }] }, false);
  assert.equal(created.json.draftOrder.id, gid("DraftOrder"));
  assert.equal(sent("CommerceShopCurrency").length, 2, "currency only looked up when a price needs it");
});

test("complete_draft_order: previews, refuses a completed draft, and completes", async (t) => {
  const { manage, sent, state } = await fixture(t);
  const preview = await manage("complete_draft_order", { id: gid("DraftOrder") });
  assert.equal(preview.json.markedAsPaid, true);
  state.draftStatus = "COMPLETED";
  const done = await manage("complete_draft_order", { id: gid("DraftOrder") }, false);
  assert.equal(done.isError, true);
  state.draftStatus = "OPEN";
  const completed = await manage("complete_draft_order", { id: gid("DraftOrder") }, false);
  assert.equal(completed.json.draftOrder.status, "COMPLETED");
  assert.equal(sent("CommerceDraftComplete").length, 1);
});

test("order_status: blocks impossible actions and applies cancel without notifying by default", async (t) => {
  const { manage, sent, state } = await fixture(t);
  const open = await manage("order_status", { id: gid("Order"), action: "open" });
  assert.equal(open.isError, true, "already open");
  const preview = await manage("order_status", { id: gid("Order"), action: "cancel", reason: "CUSTOMER", restock: true });
  assert.equal(preview.json.irreversible, true);
  assert.equal(preview.json.wouldApply.notifyCustomer, false);
  assert.equal(sent("CommerceOrderCancel").length, 0);
  const unconfirmed = await manage("order_status", { id: gid("Order"), action: "cancel" }, false);
  assert.equal(unconfirmed.json.requiredConfirm, "cancel");
  assert.equal(sent("CommerceOrderCancel").length, 0);
  const cancelled = await manage("order_status", { id: gid("Order"), action: "cancel", reason: "CUSTOMER", restock: true, refund: true }, false, "cancel");
  assert.equal(cancelled.isError, undefined, cancelled.content[0].text);
  const vars = sent("CommerceOrderCancel")[0].variables;
  assert.equal(vars.notifyCustomer, false);
  assert.deepEqual(vars.refundMethod, { originalPaymentMethodsRefund: true });
  assert.ok(cancelled.json.after.cancelledAt);
  const again = await manage("order_status", { id: gid("Order"), action: "cancel" }, false, "cancel");
  assert.equal(again.isError, true, "already cancelled");
  await manage("order_status", { id: gid("Order"), action: "mark_paid" }, false);
  await manage("order_status", { id: gid("Order"), action: "close" }, false);
  assert.equal(state.order.closed, true);
  await manage("order_status", { id: gid("Order"), action: "open" }, false);
  assert.equal(state.order.closed, false);
});

test("order_status: Shopify's orderCancelUserErrors are reported as a rejection, not success", async (t) => {
  const { manage, state } = await fixture(t);
  state.reject = "CommerceOrderCancel";
  const r = await manage("order_status", { id: gid("Order"), action: "cancel" }, false, "cancel");
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.json), /Rejected fixture/);
});

test("mutationErrors finds any *UserErrors payload field", () => {
  const document = "mutation X($id:ID!) { orderCancel(orderId:$id, reason:OTHER, restock:false) { orderCancelUserErrors { field message } } }";
  const errors = mutationErrors(document, { orderCancel: { orderCancelUserErrors: [{ field: ["orderId"], message: "nope" }] } });
  assert.equal(errors.length, 1);
});

test("refund: previews Shopify's suggestion and applies only with a matching expectedAmount", async (t) => {
  const { manage, sent, state } = await fixture(t);
  const empty = await manage("refund", { orderId: gid("Order") });
  assert.equal(empty.isError, true);
  const both = await manage("refund", { orderId: gid("Order"), refundShipping: true, shippingAmount: "2.00" });
  assert.equal(both.isError, true);
  const items = [{ lineItemId: gid("LineItem"), quantity: 1, restockType: "RETURN", locationId: gid("Location") }];
  const preview = await manage("refund", { orderId: gid("Order"), lineItems: items });
  assert.equal(preview.json.expectedAmount, "21.50");
  assert.equal(preview.json.wouldRefundTransactions.length, 1, "zero-amount suggestions are dropped");
  assert.equal(sent("CommerceRefundCreate").length, 0);
  const noExpected = await manage("refund", { orderId: gid("Order"), lineItems: items }, false);
  assert.equal(noExpected.isError, true);
  assert.match(noExpected.json.error, /needs expectedAmount/);
  const mismatch = await manage("refund", { orderId: gid("Order"), lineItems: items, expectedAmount: "20.00" }, false);
  assert.equal(mismatch.isError, true);
  assert.equal(sent("CommerceRefundCreate").length, 0);
  state.suggestedTotal = "21.5";
  const applied = await manage("refund", { orderId: gid("Order"), lineItems: items, expectedAmount: "21.50", note: "Damaged" }, false);
  assert.equal(applied.isError, undefined, applied.content[0].text);
  const input = sent("CommerceRefundCreate")[0].variables.input;
  assert.equal(input.notify, false);
  assert.equal(input.currency, "USD");
  assert.deepEqual(input.transactions, [{ orderId: gid("Order"), kind: "REFUND", gateway: "shopify_payments", amount: "21.5", parentId: gid("OrderTransaction") }]);
  assert.deepEqual(input.refundLineItems, items);
});

test("shopify_get: customer, draft_order, variants, order_transactions, order_refunds and fulfillment_orders", async (t) => {
  const { read, state } = await fixture(t);
  const customer = await read("get", { resource: "customer", id: gid("Customer") });
  assert.equal(customer.isError, undefined, customer.content[0].text);
  assert.equal(customer.json.orders.nodes[0].name, "#1001");
  const saved = state.scopes;
  state.scopes = saved.filter((s) => s !== "read_orders" && s !== "write_orders");
  const noOrders = await read("get", { resource: "customer", id: gid("Customer") });
  assert.equal(noOrders.isError, true, "read_orders is checked before the read");
  assert.deepEqual(noOrders.json.missingScopes, ["read_orders"]);
  state.scopes = saved;
  const missing = await read("get", { resource: "customer", id: gid("Customer", 404) });
  assert.equal(missing.isError, true);
  const wrongType = await read("get", { resource: "customer", id: gid("Order") });
  assert.equal(wrongType.isError, true);
  assert.equal((await read("get", { resource: "draft_order", id: gid("DraftOrder") })).json.name, "#D1");
  assert.equal((await read("get", { resource: "variants", id: gid("Product") })).json.variants.nodes[0].barcode, "123");
  assert.equal((await read("get", { resource: "order_transactions", id: gid("Order") })).json.transactions[0].kind, "SALE");
  assert.deepEqual((await read("get", { resource: "order_refunds", id: gid("Order") })).json.refunds, []);
  assert.equal((await read("get", { resource: "fulfillment_orders", id: gid("Order") })).json.fulfillmentOrders.nodes[0].status, "OPEN");
});

test("shopify_search: locations, price_lists, metafield_definitions and draft_orders", async (t) => {
  const { read, sent } = await fixture(t);
  assert.equal((await read("search", { resource: "locations" })).json.locations.nodes[0].name, "Warehouse");
  assert.equal((await read("search", { resource: "price_lists" })).json.priceLists.nodes[0].currency, "CAD");
  const needsType = await read("search", { resource: "metafield_definitions" });
  assert.equal(needsType.isError, true);
  const defs = await read("search", { resource: "metafield_definitions", type: "PRODUCT" });
  assert.equal(defs.json.metafieldDefinitions.nodes[0].ownerType, "PRODUCT");
  const badType = await read("search", { resource: "metafield_definitions", type: "NOT_A_TYPE" });
  assert.equal(badType.isError, true, "enum checked before the request");
  assert.equal(sent("CommerceMetafieldDefinitions").length, 1);
  assert.equal((await read("search", { resource: "draft_orders", query: "status:open" })).json.draftOrders.nodes[0].name, "#D1");
});
