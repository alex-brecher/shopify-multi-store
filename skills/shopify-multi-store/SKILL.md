---
name: shopify-multi-store
description: Connect, query, compare, report on, and manage multiple Shopify Admin stores from Claude, Codex, Cursor, or another MCP client. Use for multi-store ecommerce reporting, portfolio summaries, catalogs, orders, inventory, customers, parallel GraphQL reads, and guarded store updates.
---

# Shopify Multi Store

1. Call `shopify_list_stores` before a cross-store task.
2. Use the store alias in every store tool call.
3. Call `shopify_get_shop_info` before a sensitive change.
4. Use `shopify_portfolio_snapshot` for a fast overview of several stores.
5. Use `shopify_order_summary` for bounded order-value, discount, tax, cancellation, and order-status totals. Keep currencies separate.
6. Use `shopify_list_unfulfilled_orders` for the operational fulfillment queue.
7. Use `shopify_compare_inventory` for exact SKU inventory comparisons.
8. Use `shopify_get_product_everywhere` to find one exact SKU or handle across stores.
9. Use `shopify_search_products_many` to search products across selected stores.
10. Use `shopify_low_stock_report` for low inventory and cross-store transfer opportunities.
11. Treat each transfer opportunity as information. Do not assume that inventory can move between stores.
12. Use `shopify_compare_prices` to highlight price or compare-at-price differences for exact SKUs.
13. Use `shopify_duplicate_sku_report` to find repeated SKUs inside stores and shared SKUs across stores.
14. Use `shopify_compare_catalog` for exact product handle comparisons.
15. Use `shopify_catalog_gap_report` to find missing products and status differences across stores.
16. Treat a bounded gap report as a list of potential gaps.
17. Use `shopify_catalog_health` for missing merchandising, SEO, media, alt text, and inventory data.
18. Use `shopify_recent_product_changes` to review recently updated products.
19. Use `shopify_compare_collections` for collection content and configuration consistency.
20. Use `shopify_fulfillment_sla_report` for order age buckets and SLA breaches.
21. Use `shopify_customer_growth` to compare new-customer counts across equal periods.
22. Use `shopify_store_locations` to review location, fulfillment, inventory, and address coverage.
23. Use `shopify_graphql_query` for other read-only Admin GraphQL operations.
24. Use `shopify_graphql_query_many` for one read-only query across two or more stores. Pass only the stores that you need.
25. For a new custom operation, read [references/shopify-admin-companion.md](references/shopify-admin-companion.md) before you write GraphQL.
26. Use `shopify_graphql_mutation` only after the user authorizes the exact store and change.
27. Set `confirm` to `true` only when that authorization exists.
28. Use cursor pagination and request only necessary fields.
29. Preserve Shopify GraphQL user errors and per-store partial failures in the response.

Do not call the official Shopify `switch_shop` tool for a multi-store task. That tool revokes the current store token.
