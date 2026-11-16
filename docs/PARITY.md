# Shopify feature coverage

Date: 2026-09-07. Version: `1.6.0`.
Branch: `codex/review-parity-20260907`.

## Release state

Version 1.6.0 adds guided workflows for the standard Shopify Admin features in the observed ChatGPT connector.
It retains the existing multi-store reports and explicit store routing.
GitHub releases identify the published package version. Installed clients can use an older version until their next update.
Existing brand stores received read-only checks.
Version 1.7.0 removed the preview-store, sample-product, and MCP Apps UI features and the Shopify CLI bridge; see CHANGELOG.md.

Version 1.7.0 exposes 29 tools through MCP; reads are grouped under `shopify_report`, `shopify_search`, and `shopify_get` (see CHANGELOG.md).
The observed connector has 27 tools. Tool count does not prove behavior or visual parity.
The public Shopify repositories do not establish that the complete ChatGPT service is open source.

## Coverage

“Implemented” means source, schema validation, and local tests exist. It does not mean a live store accepted every workflow.

| Capability | Candidate state | Material difference or acceptance requirement |
|---|---|---|
| Shop information and store selection | Implemented | Every call uses an explicit alias. Other store connections remain active. |
| Raw GraphQL queries and mutations | Implemented | AST guards, payload errors, partial outcomes, and throttling controls. Dedicated validation is available before raw calls. |
| Product search and details | Implemented | Independent cursors for products, variants, and media. |
| Product creation | Implemented | Options, variants, prices, SKUs, images, and optional collection membership. New products default to draft. |
| Product updates | Implemented | Fields, variants, images, media removal, and before/after results. |
| Bulk product status | Through `shopify_run_action` | One aliased `productUpdate` per product; ARCHIVED and DRAFT need confirm. |
| Collection search and details | Implemented | Manual and smart collections, products, and pagination. |
| Collection creation and updates | Implemented | Rules, images, sorting, and explicit channel publication. Writes without a rule set use the 2026-07 input; writes with a legacy rule set use API 2026-04. |
| Collection membership | Implemented | Manual collections only. Smart collection membership follows its rules. |
| Inventory reads and changes | Implemented | Exact inventory item and location, compare-and-set control, and readback. |
| Order lists and details | Implemented | Filters, cursors, fulfillment, and tracking. Shopify order-history access limits apply. |
| Customer lists | Implemented | Filters and cursors. Protected customer data permissions apply. |
| Percentage discount codes | Implemented | Dates, limits, minimum purchase requirements, and customer segment eligibility. |
| Image upload | Implemented | Local staging, HTTPS sources, processing status, CDN results, and resume by file ID. |
| ShopifyQL analytics | Implemented | Tables, bar charts, time-series charts, metric selection, currency, and timezone. |
| Schema exploration and validation | Implemented | Bundled 2026-04 and 2026-07 schemas; public schema retrieval for other configured versions. |
| Documentation search | Implemented | Shopify AI Toolkit search protocol with source links. No separate usage telemetry. |
| Sample products | Removed in 1.7.0 | Not provided. |
| New-store previews and claims | Removed in 1.7.0 | Not provided. |

Product options use explicit option names and values. These inputs are not a drop-in copy of the official connector's input schema.
Channel publication requires explicit publication IDs. It does not silently select the Online Store.
Results are text and structured JSON. The MCP Apps UI was removed in 1.7.0.

## Official repository integrations

- `Shopify/shopify-app-js`: official Admin API client and API code-generation preset.
- `Shopify/Shopify-AI-Toolkit`: documentation search protocol, schema validation, and the existing companion skill installer.
- Shopify's public schema proxy: version-specific validation before each guided operation.

The React Router template remains an option for a separate hosted Admin app.
A separate Python ShopifyQL runtime was not added because the server already calls ShopifyQL through TypeScript.

## Reliability and performance changes

- GraphQL payload errors follow aliases and fragments.
- A partial mutation does not replay automatically, including a partial response with a throttle error.
- Errors preserve completed writes and uncertain outcomes.
- Retry delays use Shopify's cost and restore-rate data when available.
- Requests serialize by canonical store and token identity within one server process.
- Independent stores use bounded concurrency. The explicit store list accepts up to 100 aliases.
- Text results use compact JSON.
- Bulk exports expose job IDs, status, failure details, and partial output separately from complete output.
- Existing timeout and cursor-cycle fixes remain in the candidate.

The queue does not coordinate separate server processes. Very large interactive results still require smaller pages or a bulk export.
Bulk export status does not itself download, persist, or prove complete processing of a JSONL export.

## Permissions and live acceptance

Read-only checks confirmed the configured sample store's canonical domain as `drink-believe.myshopify.com`.
Product and collection list queries returned data with pagination metadata.
The connection lacks the scopes for uploads, publication, and analytics.

Relevant scopes include `write_products`, `write_inventory`, `write_discounts`, `write_files`, `write_publications`, and `read_reports`.
Customer and order access also depend on the app's granted permissions.
ShopifyQL can require Level 2 protected customer data access in addition to `read_reports`.
No scope grant changed during this work.

Live writes passed on temporary store `17git0-fe.myshopify.com`: products, variants, collections, discounts, publication, image upload, and inventory.
The complete preview tool created `fvczby-h7.myshopify.com`, published a design, and returned preview and claim links.
Sample product creation and publication passed on that second temporary store.
A final complete call created `t1kks2-nb.myshopify.com`, seeded its demo product, published its design, and returned both links.
Replaying the same request returned the existing store.
No store was claimed, subscribed, or connected to a payment method.
ShopifyQL live acceptance remains dependent on reports access. MCP Apps bridge acceptance remains host-specific.
Collection writes with a legacy rule set still use 2026-04; tests/api-versions.test.mjs fails 60 days before that version's end of support.

## Validation

- Forty-seven automated tests pass on Node 20 and Node 25.9.0. They cover the original workflows, preview receipts, generated concepts, theme configuration, and source selection.
- Package validation includes the UI asset and both bundled schemas.
- The dependency audit reports zero known vulnerabilities.
- All fixed GraphQL operations validate against their selected Shopify schemas.
- Full TypeScript checking includes generated declarations with `skipLibCheck` disabled.
- MCP transport tests verify original tools, new tool registration, and the HTML resource.
- Image tests cover staged local bytes, an unexpected upload host, processed URLs, and processing failure.
- Browser checks cover chart rendering, metric selection, and the sample-to-draft form with a mocked callback.
- An earlier mobile check covered the responsive chart/table layout at 390 by 844 pixels.
- All 11 existing store connections passed the read-only smoke test. Existing multi-store reports also passed.
- Live inventory acceptance found a missing required `@idempotent` directive. The candidate now supplies a key and verifies the resulting quantity.
- Inventory changed from 0 to 7 and the readback matched.
- Shopify Theme Check reported zero errors for the generated Dawn design. The official skill validator also accepted both generated JSON files.
- Browser acceptance confirmed the generated headline, product catalog, and Shopify Save store link.
- A fresh preview link is required after theme publication; the tool refreshes links before returning them.

## Sources

- [Shopify ChatGPT plugin](https://help.shopify.com/en/manual/ai-powered-tools/connecting-ai-tools/shopify-plugin-for-chatgpt)
- [Shopify app libraries](https://github.com/Shopify/shopify-app-js)
- [Shopify AI Toolkit](https://github.com/Shopify/Shopify-AI-Toolkit)
- [ShopifyQL access](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api)
- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
- Observed official connector tool inventory: `docs/shopify-tool-reference.json`.

## Test runner

The test runner enumerates unit-test files explicitly on every platform. Live smoke tests remain a separate command.

## GeLi2001/shopify-mcp comparison (2.1.0, 2026-11-16)

Compared against GeLi2001/shopify-mcp 1.0.8 (MIT, 45 single-store tools). Nothing was copied; each gap was reimplemented with a store alias, dryRun preview and read-back.

| Theirs | Ours before 2.1.0 | Action taken |
|---|---|---|
| get-products, get-product-by-id | `shopify_search products`, `shopify_get product` | Already covered |
| get-product-variants-detailed, get-inventory-items | Partial (`shopify_get product`, `inventory`) | Added `shopify_get variants` (barcode, tax, policy, weight, cost, origin, HS code) |
| get-inventory-levels | `shopify_get inventory` | Already covered |
| create-product, update-product | `shopify_create_product`, `shopify_update_product` | Added handle, SEO, redirectNewHandle, collectionsToJoin/Leave to update |
| delete-product | `shopify_run_action productDelete` | Added `shopify_manage delete` (preview + confirm) |
| manage-product-variants, delete-product-variants | Update only | Added `shopify_manage variants` (create, update, delete, ownership check) |
| manage-product-options | `shopify_run_action` only | Added `shopify_manage options` |
| get-orders, get-order-by-id | `shopify_search orders`, `shopify_get order` | Already covered |
| update-order | note, email, address, tags | Added phone, poNumber, customAttributes; metafields via `shopify_metafields` |
| order-cancel, order-close-open, order-mark-as-paid | `shopify_run_action` only | Added `shopify_manage order_status` (state check, notify off, confirm for cancel) |
| refund-create | `shopify_run_action` only | Added `shopify_manage refund` (suggestedRefund preview, expectedAmount guard) |
| get-order-transactions, get-order-refund-details, get-fulfillment-orders | Missing | Added `shopify_get order_transactions`, `order_refunds`, `fulfillment_orders` |
| create-fulfillment | `shopify_create_fulfillment` | Already covered |
| create-draft-order, complete-draft-order | `shopify_run_action` only | Added `shopify_manage create_draft_order` (draftOrderCalculate preview) and `complete_draft_order`; `shopify_search draft_orders`, `shopify_get draft_order` |
| get-customers | `shopify_search customers` | Already covered |
| get-customer-by-id, get-customer-orders | Missing | Added `shopify_get customer` (with orders page) |
| create-customer, delete-customer | `shopify_run_action` only | Added `shopify_manage create_customer` (duplicate email check) and `delete` |
| update-customer | note, email, tags | Added firstName, lastName, phone, taxExempt. Marketing consent stays out of scope |
| manage-customer-address | Missing | Added `shopify_manage customer_address` |
| customer-merge | `shopify_run_action` only | Added `shopify_manage merge_customers` (customerMergePreview, confirm) |
| get-metafields, set-metafields, delete-metafields | `shopify_get metafields`, `shopify_metafields` | Already covered |
| get-metafield-definitions | Missing | Added `shopify_search metafield_definitions` |
| manage-tags | `shopify_tags` | Already covered |
| inventory-set-quantities | `shopify_set_inventory` (compare-and-set) | Kept ours; multi-item absolute sets through `shopify_run_action inventorySetQuantities` |
| get-shop-info | `shopify_get_shop_info` | Already covered |
| get-locations | `shopify_report store_locations` | Added `shopify_search locations` |
| get-markets | `shopify_search markets` | Already covered |
| get-price-lists | Missing | Added `shopify_search price_lists` |
| get-collections, get-collection-by-id | `shopify_search collections`, `shopify_get collection` | Already covered |
| Client credentials token exchange with refresh | `client_credentials` store auth | Already covered |
| Static token, `--domain`, `SHOPIFY_API_VERSION` | Per-store config, keychain, apiVersion | Already covered |
| userErrors wrapping (`checkUserErrors`) | Structured errors, but only `userErrors`/`mediaUserErrors` | Fixed: any `*UserErrors` field is detected |
| Pagination (first + cursor on lists) | Cursor pagination everywhere | Already covered |
| Rate limits | None in theirs | Ours retries reads with Retry-After and cost data; mutations never auto-retried |
| Tests (jest, mocked client) | node:test, schema-validated documents | 22 new tests |
