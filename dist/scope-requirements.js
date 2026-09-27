// Best-effort map of every registered tool to the Shopify Admin API access-scope
// handles it needs. Used by shopify_check_access and by scripts/print-scopes.mjs
// to derive the scope list for a shopify.app.toml.
//
// A few tools accept an arbitrary caller-supplied GraphQL document or owner GID
// (the raw GraphQL passthrough tools, the generic metafield tools and the generic
// tags tool). Their real scope need depends on what the caller asks for, so they
// are listed in VARIABLE_SCOPE_TOOLS with the broadest scopes they could plausibly
// need; shopify_check_access reports them separately rather than as a hard miss.
export const REQUIRED_SCOPES = {
    // src/admin-tools.ts
    shopify_get_store_capabilities: [],
    shopify_switch_shop: [],
    shopify_search_products: ["read_products"],
    shopify_get_product: ["read_products"],
    shopify_search_collections: ["read_products"],
    shopify_get_collection: ["read_products"],
    shopify_list_orders: ["read_orders"],
    shopify_get_order: ["read_orders"],
    shopify_list_customers: ["read_customers"],
    shopify_get_inventory_levels: ["read_products", "read_inventory"],
    shopify_graphql_schema: [],
    shopify_validate_graphql_codeblocks: [],
    shopify_run_analytics_query: ["read_reports"],
    shopify_create_product: ["write_products"],
    shopify_update_product: ["write_products"],
    shopify_create_collection: ["write_products", "write_publications"],
    shopify_update_collection: ["write_products"],
    shopify_add_to_collection: ["write_products"],
    shopify_list_publications: ["read_publications"],
    shopify_publish_resource: ["write_publications"],
    shopify_bulk_update_product_status: ["write_products"],
    shopify_set_inventory: ["write_inventory"],
    shopify_create_discount: ["write_discounts"],
    shopify_upload_image: ["write_files"],
    shopify_get_uploaded_image: ["read_files"],
    shopify_bulk_export_start: ["read_products"],
    shopify_bulk_export_status: [],
    // src/index.ts
    shopify_list_stores: [],
    shopify_get_shop_info: [],
    shopify_graphql_query: [],
    shopify_graphql_query_many: [],
    shopify_graphql_mutation: [],
    shopify_portfolio_snapshot: ["read_products", "read_orders"],
    shopify_compare_inventory: ["read_products", "read_inventory"],
    shopify_get_product_everywhere: ["read_products"],
    shopify_search_products_many: ["read_products"],
    shopify_list_unfulfilled_orders: ["read_orders"],
    shopify_fulfillment_sla_report: ["read_orders"],
    shopify_compare_catalog: ["read_products"],
    shopify_catalog_gap_report: ["read_products"],
    shopify_order_summary: ["read_orders"],
    shopify_low_stock_report: ["read_products", "read_inventory"],
    shopify_catalog_health: ["read_products"],
    shopify_recent_product_changes: ["read_products"],
    shopify_customer_growth: ["read_customers"],
    shopify_compare_collections: ["read_products"],
    shopify_store_locations: ["read_locations"],
    shopify_duplicate_sku_report: ["read_products"],
    shopify_compare_prices: ["read_products"],
    // src/discovery-tools.ts
    shopify_search_docs_chunks: [],
    shopify_find_sample_product: [],
    // src/preview-designs.ts, src/previews.ts (operate on temporary shopify_cli stores)
    shopify_get_new_store_preview_status: [],
    shopify_get_new_store_previews: [],
    shopify_create_preview_store: [],
    shopify_get_preview_store: [],
    // src/parity-tools.ts
    shopify_update_prices: ["write_products", "write_inventory"],
    shopify_update_prices_many: ["write_products", "write_inventory"],
    shopify_get_metafields: [],
    shopify_set_metafields: [],
    shopify_delete_metafields: [],
    shopify_list_metaobjects: ["read_metaobjects"],
    shopify_upsert_metaobject: ["write_metaobjects"],
    shopify_list_redirects: ["read_online_store_navigation"],
    shopify_create_redirects: ["write_online_store_navigation"],
    shopify_delete_redirects: ["write_online_store_navigation"],
    shopify_list_delivery_profiles: ["read_shipping"],
    shopify_update_delivery_rate: ["write_shipping"],
    shopify_list_themes: ["read_themes"],
    shopify_get_theme_files: ["read_themes"],
    shopify_upsert_theme_files: ["write_themes"],
    shopify_list_files: ["read_files"],
    shopify_delete_files: ["write_files"],
    shopify_create_draft_order: ["write_draft_orders"],
    shopify_update_order: ["write_orders"],
    shopify_tags: [],
    shopify_update_customer: ["write_customers"],
    shopify_create_fulfillment: ["read_merchant_managed_fulfillment_orders", "write_merchant_managed_fulfillment_orders"],
    shopify_list_pages: ["read_content"],
    shopify_upsert_page: ["write_content"],
    shopify_list_blog_articles: ["read_content"],
    shopify_list_markets: ["read_markets"],
    shopify_check_access: [],
    // src/actions/tools.ts
    shopify_find_actions: [],
    shopify_describe_action: [],
    shopify_run_action: [],
};
/**
 * Tools whose real scope need depends on a caller-supplied GraphQL document or
 * owner GID rather than a fixed resource. Their REQUIRED_SCOPES entry (often [])
 * understates what they might need; shopify_check_access flags them separately.
 */
export const VARIABLE_SCOPE_TOOLS = {
    shopify_graphql_query: "Scope depends on the caller-supplied query.",
    shopify_graphql_query_many: "Scope depends on the caller-supplied query.",
    shopify_graphql_mutation: "Scope depends on the caller-supplied mutation.",
    shopify_bulk_export_start: "Scope depends on the caller-supplied bulk query.",
    shopify_get_metafields: "Scope depends on the owner resource type (e.g. read_products for a product owner).",
    shopify_set_metafields: "Scope depends on the owner resource type (e.g. write_products for a product owner).",
    shopify_delete_metafields: "Scope depends on the owner resource type.",
    shopify_tags: "Scope depends on the owner resource type (write_products, write_orders, write_customers or write_draft_orders).",
    shopify_run_action: "Scope depends on the mutation; shopify_describe_action shows a hint. Request the full set (print-scopes --full).",
};
/** The union of every scope handle any tool in REQUIRED_SCOPES might need, for generating a shopify.app.toml. */
export function allRequiredScopes() {
    const scopes = new Set();
    for (const list of Object.values(REQUIRED_SCOPES))
        for (const scope of list)
            scopes.add(scope);
    return [...scopes].sort();
}
/**
 * The "full" scope set: everything a Dev Dashboard app can reasonably request so that the
 * generic action tools (shopify_find_actions, shopify_describe_action, shopify_run_action)
 * can reach every Admin API mutation Shopify lets a third-party app use.
 *
 * A write_ scope implies its read_ scope, so mostly write_ is listed; a few read_ handles are
 * listed too because Shopify documents them separately.
 * In per-user mode Shopify further narrows each token to the scopes the signed-in staff member
 * holds (associated_user_scope), so requesting the full set never gives anyone more than
 * their own Shopify permissions.
 *
 * Scopes Shopify gates behind extra approval are marked. Requesting them without the approval
 * makes the install or version release fail for that scope; drop them with SHOPIFY_APP_SCOPES
 * if your app is not approved.
 */
export const FULL_SCOPES = [
    // Orders, fulfillment and returns.
    "read_all_orders", // APPROVAL: Shopify must grant access to orders older than 60 days (Partner Dashboard request).
    "write_orders", // PROTECTED CUSTOMER DATA: order customer fields need protected customer data approval.
    "write_draft_orders",
    "write_order_edits",
    "write_fulfillments",
    "write_merchant_managed_fulfillment_orders",
    "write_third_party_fulfillment_orders",
    "write_assigned_fulfillment_orders",
    "write_returns",
    "write_shipping",
    "write_payment_terms",
    "write_packing_slip_templates",
    "read_shopify_payments_disputes",
    // Products, inventory, catalog.
    "write_products",
    "write_inventory",
    "write_inventory_transfers",
    "write_inventory_shipments",
    "write_locations",
    "write_publications",
    "write_product_listings",
    "write_purchase_options",
    "write_resource_feedbacks",
    "write_files",
    // Customers and B2B.
    "write_customers", // PROTECTED CUSTOMER DATA: names, emails, phones and addresses need approval.
    "read_customer_merge",
    "write_customer_merge",
    "write_companies",
    "read_companies",
    "write_store_credit_account_transactions",
    "write_gift_cards",
    // Discounts and marketing.
    "write_discounts",
    "write_price_rules",
    "write_marketing_events",
    "write_pixels",
    "write_customer_events",
    // Content, online store, translations.
    "write_content",
    "write_themes",
    "write_online_store_navigation",
    "write_metaobjects",
    "write_metaobject_definitions",
    "write_translations",
    "write_locales",
    "write_legal_policies",
    "read_legal_policies",
    "write_script_tags",
    // Markets and checkout customizations (Shopify Functions).
    "write_markets",
    "write_checkouts",
    "write_checkout_branding_settings", // Shopify Plus only.
    "write_validations",
    "write_payment_customizations",
    "write_delivery_customizations",
    "write_cart_transforms",
    "write_privacy_settings",
    // Reporting and platform reads.
    "read_reports",
    "read_analytics",
    "read_apps",
    "read_users", // Shopify Plus and Advanced plans only.
    "read_taxes",
    "read_audit_events",
];
/** Scopes FULL_SCOPES leaves out on purpose, with the reason. Documented in docs/ACTIONS.md. */
export const EXCLUDED_SCOPES = {
    write_own_subscription_contracts: "APPROVAL: subscription APIs need Shopify's approval, and contracts can only be changed by the app that owns them.",
    read_customer_payment_methods: "APPROVAL: payment mandates need Shopify's approval; not available to a custom admin tool.",
    write_customer_payment_methods: "APPROVAL: payment mandates need Shopify's approval; not available to a custom admin tool.",
    read_marketplace_orders: "Sales-channel (marketplace) apps only.",
    read_marketplace_fulfillment_orders: "Sales-channel (marketplace) apps only.",
    read_marketplace_returns: "Sales-channel (marketplace) apps only.",
    read_financial_kyc_information: "Shopify Payments KYC data; restricted to approved apps.",
};
/** FULL_SCOPES plus every scope a dedicated tool needs, sorted and de-duplicated. */
export function fullScopes() {
    return [...new Set([...FULL_SCOPES, ...allRequiredScopes()])].sort();
}
//# sourceMappingURL=scope-requirements.js.map