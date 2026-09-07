# Shopify feature coverage

Date: 2026-09-07. Version: `1.6.0`.
Branch: `codex/review-parity-20260907`.

## Release state

Version 1.6.0 adds guided workflows for the standard Shopify Admin features in the observed ChatGPT connector.
It retains the existing multi-store reports and explicit store routing.
GitHub releases identify the published package version. Installed clients can use an older version until their next update.
Live acceptance now includes writes to three isolated temporary preview stores. Existing brand stores received read-only checks.

The candidate exposes 55 tools through MCP.
The observed connector has 27 tools. Tool count does not prove behavior or visual parity.
The public Shopify repositories do not establish that the complete ChatGPT service is open source.
Shopify CLI provides a public preview-store creation and claim route. The candidate now uses it.

## Coverage

“Implemented” means source, schema validation, and local tests exist. It does not mean a live store accepted every workflow.

| Capability | Candidate state | Material difference or acceptance requirement |
|---|---|---|
| Shop information and store selection | Implemented | Every call uses an explicit alias. Other store connections remain active. |
| Raw GraphQL queries and mutations | Implemented | AST guards, payload errors, partial outcomes, and throttling controls. Dedicated validation is available before raw calls. |
| Product search and details | Implemented | Independent cursors for products, variants, and media. |
| Product creation | Implemented | Options, variants, prices, SKUs, images, and optional collection membership. New products default to draft. |
| Product updates | Implemented | Fields, variants, images, media removal, and before/after results. |
| Bulk product status | Implemented | Bounded selections, per-product outcomes, and readback. Maximum 250 products per call. |
| Collection search and details | Implemented | Manual and smart collections, products, and pagination. |
| Collection creation and updates | Implemented | Rules, images, sorting, and explicit channel publication. Legacy collection mutations use API 2026-04. |
| Collection membership | Implemented | Manual collections only. Smart collection membership follows its rules. |
| Inventory reads and changes | Implemented | Exact inventory item and location, compare-and-set control, and readback. |
| Order lists and details | Implemented | Filters, cursors, fulfillment, and tracking. Shopify order-history access limits apply. |
| Customer lists | Implemented | Filters and cursors. Protected customer data permissions apply. |
| Percentage discount codes | Implemented | Dates, limits, minimum purchase requirements, and customer segment eligibility. |
| Image upload | Implemented | Local staging, HTTPS sources, processing status, CDN results, and resume by file ID. |
| ShopifyQL analytics | Implemented | Tables, bar charts, time-series charts, metric selection, currency, and timezone. |
| Schema exploration and validation | Implemented | Bundled 2026-04 and 2026-07 schemas; public schema retrieval for other configured versions. |
| Documentation search | Implemented | Shopify AI Toolkit search protocol with source links. No separate usage telemetry. |
| Sample products | Implemented | Category-specific catalogs and agent-generated concepts, with draft-creation cards. Generated concepts are labeled as examples. |
| New-store previews and claims | Implemented | One to three separate temporary stores with agent-designed Dawn layouts, demo products, and real claim links. |

Product options use explicit option names and values. These inputs are not a drop-in copy of the official connector's input schema.
Channel publication requires explicit publication IDs. It does not silently select the Online Store.
The UI uses MCP Apps resources. Hosts without MCP Apps support retain text and structured tool results.
The local browser tests cover the renderer. They do not establish acceptance of the complete iframe bridge in every host.

## Official repository integrations

- `Shopify/shopify-app-js`: official Admin API client and API code-generation preset.
- `Shopify/Shopify-AI-Toolkit`: documentation search protocol, schema validation, and the existing companion skill installer.
- Shopify's public schema proxy: version-specific validation before each guided operation.
- `mock.shop`: category-specific catalogs from the published store index.
- `Shopify/cli`: preview-store creation, temporary credentials, theme upload, and claim links.
- `Shopify/dawn`: pinned theme source at `258f00f64365e2018ca4c62778a6bf55a5d3cd18` for editable storefront designs.

Code generation keeps the legacy collection types separate from the current client type augmentation.
The TypeScript code-generation plugin uses major version 5 because Shopify's preset requires its `Exact` helper.

The React Router template remains an option for a separate hosted Admin app. The preview feature now integrates Shopify CLI directly.
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
The 2026-04 collection adapter needs migration before Shopify retires that API version.

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

## Preview requirements and behavior

Install Shopify CLI and Git before using preview tools. The first design request downloads a pinned Dawn checkout from GitHub.
The package does not redistribute the Dawn source. Its upstream license remains in the cached checkout.
The request includes concrete design palettes, layouts, headlines, and demo products generated by the calling agent from the user's brief.
Creation returns a pending job immediately. The status tool returns completed previews or an explicit failure.
The UI includes a status button. This avoids a single long request during store and theme creation.
The workflow creates a separate temporary store for each design. It does not restyle an existing merchant store.
A request ID and durable receipts prevent blind duplicate creation. File locks coordinate separate local server processes.
An interrupted write can require inspection before recovery. The app preserves the known store and theme state.
CLI credentials remain in Shopify CLI storage. Preview and claim links are refreshed when requested.

The result provides functional storefront previews and claims. It does not reproduce Shopify's proprietary visual carousel or image-generation service.
Generated product concepts can omit images when no suitable image exists. The app does not substitute unrelated product images.

The test runner enumerates unit-test files explicitly on every platform. Live smoke tests remain a separate command.
Windows launches the Shopify CLI JavaScript entry through Node rather than a shell-based npm shim.
