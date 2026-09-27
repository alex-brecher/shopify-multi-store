---
name: shopify-multi-store
description: Connect, query, compare, report on, and manage multiple Shopify Admin stores from Claude, Codex, Cursor, or another MCP client. Use for multi-store ecommerce reporting, portfolio summaries, catalogs, orders, inventory, customers, parallel GraphQL reads, and guarded store updates.
---

# Shopify Multi Store

1. Call `shopify_list_stores` before a cross-store task.
2. Use the store alias in every store tool call.
3. Call `shopify_get_shop_info` before a sensitive change.
4. Use `shopify_report` for cross-store reports. Set `report` and pass `stores`:
   - `portfolio_snapshot` for a fast overview of several stores.
   - `order_summary` for bounded order-value, discount, tax, cancellation, and order-status totals. Keep currencies separate.
   - `list_unfulfilled_orders` for the operational fulfillment queue, and `fulfillment_sla_report` for order age buckets and SLA breaches.
   - `compare_inventory` for exact SKU inventory, and `low_stock_report` for low inventory and transfer opportunities. Treat each transfer opportunity as information; do not assume that inventory can move between stores.
   - `get_product_everywhere` to find one exact SKU or handle across stores.
   - `compare_prices` for price or compare-at-price differences, and `duplicate_sku_report` for repeated and shared SKUs.
   - `compare_catalog` for exact product handles, and `catalog_gap_report` for missing products and status differences. Treat a bounded gap report as a list of potential gaps.
   - `catalog_health` for missing merchandising, SEO, media, alt text, and inventory data, and `recent_product_changes` for recently updated products.
   - `compare_collections`, `customer_growth`, `store_locations`, and `analytics` (ShopifyQL) as named.
5. Use `shopify_search` to list or search one kind of record (`resource`) on one store, or on several with `stores`. Use `shopify_get` to read one record by GID.
6. Guided write tools default to `dryRun: true`. Show the preview, get the user's authorization for the exact store and change, then call again with `dryRun: false`.
7. For tags, use `addTags` and `removeTags`. Use `replaceTags` only when the user wants every other tag removed; the preview lists what would go.
8. For a write no guided tool covers, use `shopify_find_actions`, `shopify_describe_action`, then `shopify_run_action`.
9. Use `shopify_graphql_query` for other read-only Admin GraphQL operations.
10. Use `shopify_graphql_query_many` for one read-only query across two or more stores. Pass only the stores that you need.
11. For a new custom operation, read [references/shopify-admin-companion.md](references/shopify-admin-companion.md) before you write GraphQL.
12. Use `shopify_graphql_mutation` only after the user authorizes the exact store and change.
13. Set `confirm` to `true` only when that authorization exists; destructive mutations need `confirm` set to the mutation name.
14. Use cursor pagination and request only necessary fields.
15. Preserve Shopify GraphQL user errors and per-store partial failures in the response.

Do not call the official Shopify `switch_shop` tool for a multi-store task. That tool revokes the current store token.

