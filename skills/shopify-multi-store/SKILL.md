---
name: shopify-multi-store
description: Work with multiple named Shopify Admin stores in one Codex task. Use when the user asks to list, compare, query, or change data in one or more configured Shopify stores.
---

# Shopify Multi Store

1. Call `shopify_list_stores` before a cross-store task.
2. Use the store alias in every store tool call.
3. Call `shopify_get_shop_info` before a sensitive change.
4. Use `shopify_graphql_query` for read-only Admin GraphQL operations.
5. Use `shopify_graphql_mutation` only after the user authorizes the exact store and change.
6. Set `confirm` to `true` only when that authorization exists.
7. Use cursor pagination and request only necessary fields.
8. Preserve Shopify GraphQL user errors in the response.

Do not call the official Shopify `switch_shop` tool for a multi-store task. That tool revokes the current store token.
