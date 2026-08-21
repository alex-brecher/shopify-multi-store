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
2. Call `shopify_list_unfulfilled_orders` with the necessary lookback period.
3. Report each store separately before you calculate portfolio totals.
4. Keep currencies separate unless the user supplies an exchange-rate rule.
5. Flag partial failures and missing scopes.

### Inventory watch

1. Get the exact SKU list from the user or an approved business source.
2. Call `shopify_compare_inventory` for the selected stores.
3. Report missing SKUs separately from zero inventory.
4. Do not recommend a reorder quantity without demand, lead-time, and safety-stock data.

### Weekly portfolio review

1. Start with `shopify_portfolio_snapshot`.
2. Use a validated custom query only when the report needs sales, returns, or other analytics.
3. Make sure that each store has the necessary scope before you compare results.
4. Show the period, currency, row limit, and incomplete pagination.
5. Do not combine estimates with exact Shopify values without a label.
