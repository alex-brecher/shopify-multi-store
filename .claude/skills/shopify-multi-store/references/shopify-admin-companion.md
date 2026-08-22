# Shopify Companion Skills

Use this workflow only when the task needs a custom Admin GraphQL operation. The ready-made report tools do not need this workflow.

## Official Shopify skills

Use `shopify-admin` for a custom Admin GraphQL record operation. Use `shopify-shopifyql` for aggregate sales, revenue, orders, conversion, and trend reports.

1. Select the API version from the target store configuration.
2. Search Shopify documentation for the exact query, mutation, field, or input type.
3. Write the smallest operation that supplies the necessary result.
4. Validate the operation against the selected API version.
5. Use this plugin's query or mutation tool to run the operation.

The official skills help with operation design, documentation, schema validation, and ShopifyQL syntax. This plugin keeps store selection, credentials, execution, and mutation authorization.

Wrap a ShopifyQL query in the `shopifyqlQuery` Admin GraphQL field. Run the wrapper with `shopify_graphql_query_many` when the same report applies to multiple stores.

ShopifyQL needs the `read_reports` scope. Read `parseErrors` before you accept any returned report.

Shopify's skill scripts send usage telemetry by default. Set `OPT_OUT_INSTRUMENTATION=true` to turn it off.

## Multi-store operating workflows

Use these small workflows instead of importing a large single-store skill collection.

### Daily portfolio brief

1. Call `shopify_portfolio_snapshot` for the selected stores.
2. Call `shopify_order_summary` for bounded order-value and status totals.
3. Keep each currency separate.
4. Read each report's completeness flag before using a total.
5. Call `shopify_list_unfulfilled_orders` with the necessary lookback period.
6. Report each store separately before you calculate portfolio totals.
7. Flag partial failures and missing scopes.

### Inventory watch

1. Get the exact SKU list from the user or an approved business source.
2. Call `shopify_compare_inventory` for the selected stores.
3. Call `shopify_low_stock_report` when the task covers the full active catalog.
4. Examine the transfer opportunities when one store has no stock.
5. Do not assume that inventory can move between stores, locations, or companies.
6. Call `shopify_duplicate_sku_report` before catalog consolidation or migration work.
7. Report missing SKUs separately from zero inventory.
8. Do not recommend a reorder quantity without demand, lead-time, and safety-stock data.

### Pricing review

1. Get the exact SKU list and selected stores.
2. Call `shopify_compare_prices`.
3. Treat missing variants separately from price differences.
4. Keep currencies separate. Do not compare numeric prices across currencies without an exchange-rate rule.

### Merchandising health

1. Call `shopify_catalog_health` with a row limit suited to the task.
2. Read each store's completeness flag.
3. Call `shopify_recent_product_changes` when recent edits define the scope.
4. Call `shopify_compare_catalog` for exact product handles.
5. Call `shopify_get_product_everywhere` for one exact SKU or handle.
6. Call `shopify_search_products_many` when the user does not know the exact handle.
7. Call `shopify_catalog_gap_report` to find missing products and status differences.
8. Treat an incomplete scan as a list of potential gaps.
9. Call `shopify_compare_collections` for exact collection handles.
10. Treat detected gaps as review items, not authorization to change products.

### Customer and location review

1. Call `shopify_customer_growth` with equal current and previous periods.
2. Preserve Shopify count precision in the result.
3. Call `shopify_store_locations` for warehouse, fulfillment, inventory, and address coverage.
4. Do not infer shipping eligibility from location presence alone.

### Weekly portfolio review

1. Start with `shopify_portfolio_snapshot`.
2. Use `shopify_order_summary`, `shopify_customer_growth`, and the necessary catalog or inventory report.
3. Use `shopify_fulfillment_sla_report` to show late open orders.
4. Use a validated custom query only when the report needs returns, conversion, or other analytics.
5. Make sure that each store has the necessary scope before you compare results.
6. Show the period, currency, row limit, and incomplete pagination.
7. Do not combine estimates with exact Shopify values without a label.
