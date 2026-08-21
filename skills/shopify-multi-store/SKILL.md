---
name: shopify-multi-store
description: Connect, query, compare, and manage multiple Shopify Admin stores in one Codex task using named store aliases, separate credentials, parallel cross-store GraphQL reads, and guarded mutations. Use for multi-store ecommerce reporting, catalogs, orders, inventory, customers, and operations.
---

# Shopify Multi Store

1. Call `shopify_list_stores` before a cross-store task.
2. Use the store alias in every store tool call.
3. Call `shopify_get_shop_info` before a sensitive change.
4. Use `shopify_graphql_query` for read-only Admin GraphQL operations.
5. Use `shopify_graphql_query_many` when the same read-only query should run across two or more stores. Pass only the stores needed for the task.
6. Use `shopify_graphql_mutation` only after the user authorizes the exact store and change.
7. Set `confirm` to `true` only when that authorization exists.
8. Use cursor pagination and request only necessary fields.
9. Preserve Shopify GraphQL user errors in the response, including partial failures from cross-store queries.

Do not call the official Shopify `switch_shop` tool for a multi-store task. That tool revokes the current store token.
