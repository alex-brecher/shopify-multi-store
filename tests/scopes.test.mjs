import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EXCLUDED_SCOPES, FULL_SCOPES, REQUIRED_SCOPES, allRequiredScopes, fullScopes } from "../dist/scope-requirements.js";

const REQUESTED = `read_all_orders read_analytics read_apps read_companies read_legal_policies read_reports write_checkout_branding_settings write_checkouts write_content write_customers write_discounts write_draft_orders write_files write_fulfillments write_inventory write_locales write_locations write_marketing_events write_markets write_merchant_managed_fulfillment_orders write_metaobject_definitions write_metaobjects write_online_store_navigation write_order_edits write_orders write_price_rules write_products write_publications write_returns write_shipping write_themes write_translations write_validations write_gift_cards write_payment_terms write_payment_customizations write_delivery_customizations write_cart_transforms write_pixels write_customer_events write_script_tags write_store_credit_account_transactions write_inventory_transfers write_inventory_shipments write_purchase_options write_legal_policies write_privacy_settings write_packing_slip_templates write_third_party_fulfillment_orders read_customer_merge write_customer_merge write_resource_feedbacks write_product_listings write_companies read_users`.split(" ");

test("the full scope set covers every requested scope and every dedicated tool's scopes", () => {
  const full = new Set(fullScopes());
  for (const scope of REQUESTED) assert.ok(full.has(scope), scope);
  for (const scope of allRequiredScopes()) assert.ok(full.has(scope), scope);
  for (const scope of full) assert.match(scope, /^(read|write)_[a-z_]+$/);
  for (const scope of Object.keys(EXCLUDED_SCOPES)) assert.ok(!FULL_SCOPES.includes(scope), scope);
  for (const tool of ["shopify_find_actions", "shopify_describe_action", "shopify_run_action"]) assert.ok(tool in REQUIRED_SCOPES, tool);
});

test("print-scopes prints the dedicated-tool list, or the full list with --full", () => {
  const script = fileURLToPath(new URL("../scripts/print-scopes.mjs", import.meta.url));
  const plain = execFileSync(process.execPath, [script], { encoding: "utf8" }).trim();
  const full = execFileSync(process.execPath, [script, "--full"], { encoding: "utf8" }).trim();
  assert.equal(plain, allRequiredScopes().join(","));
  assert.equal(full, fullScopes().join(","));
  assert.ok(full.split(",").length > plain.split(",").length);
});

test("the tool surface stays under 30 tools and every tool and resource has a scope entry", async () => {
  const { createServer } = await import("../dist/server.js");
  const { toolOfScopeKey } = await import("../dist/scope-requirements.js");
  const { SEARCH_RESOURCES, GET_RESOURCES } = await import("../dist/read-tools.js");
  const { REPORTS } = await import("../dist/report-tools.js");
  const names = [];
  createServer({ beforeRegister: (server) => {
    const register = server.registerTool.bind(server);
    server.registerTool = (name, ...rest) => { names.push(name); return register(name, ...rest); };
  } });
  assert.ok(names.length < 30, `${names.length} tools: ${names.join(", ")}`);
  const keys = Object.keys(REQUIRED_SCOPES);
  assert.deepEqual([...new Set(keys.map(toolOfScopeKey))].sort(), [...names].sort(), "scope entries match the registered tools");
  for (const resource of Object.keys(SEARCH_RESOURCES)) assert.ok(`shopify_search:${resource}` in REQUIRED_SCOPES, resource);
  for (const resource of Object.keys(GET_RESOURCES)) assert.ok(`shopify_get:${resource}` in REQUIRED_SCOPES, resource);
  for (const report of Object.keys(REPORTS)) assert.ok(`shopify_report:${report}` in REQUIRED_SCOPES, report);
});
