---
name: shopify-multi-store
description: Connect, query, compare, report on, and manage multiple Shopify Admin stores from Claude, Codex, Cursor, or another MCP client. Use for multi-store ecommerce reporting, portfolio summaries, catalogs, orders, inventory, customers, parallel GraphQL reads, and guarded store updates.
---

# Shopify Multi Store

1. Call `shopify_list_stores` before a cross-store task.
2. Use the store alias in every store tool call.
3. Call `shopify_get_shop_info` before a sensitive change.
4. Use `shopify_portfolio_snapshot` for a fast overview of several stores.
5. Use `shopify_compare_inventory` for SKU inventory comparisons.
6. Use `shopify_list_unfulfilled_orders` for an operational order report.
7. Use `shopify_compare_catalog` for product handle, status, vendor, and variant comparisons.
8. Use `shopify_graphql_query` for other read-only Admin GraphQL operations.
9. Use `shopify_graphql_query_many` for the same read-only query across two or more stores. Pass only the stores needed.
10. Use `shopify_graphql_mutation` only after the user authorizes the exact store and change.
11. Set `confirm` to `true` only when that authorization exists.
12. Use cursor pagination and request only necessary fields.
13. Preserve Shopify GraphQL user errors and per-store partial failures in the response.

Do not call the official Shopify `switch_shop` tool for a multi-store task. That tool revokes the current store token.
