# Changelog

This file records notable changes to Shopify Multi-Store MCP.

## [Unreleased]

### Fixed

- Hosted: Claude connects again after its first approval. The server skipped
  the consent screen for an app approved in the last 30 days and sent the
  authorization code straight back with a 302 at the end of the Shopify
  sign-in. Claude dropped every one of those codes and never called /token
  (10 of 10 on 2026-09-28), while every sign-in that went through the
  consent screen completed. The consent screen now shows on every OAuth
  sign-in and approvals are no longer remembered.

## [2.0.1] - 2026-09-27

### Fixed

- Hosted: ChatGPT connects with its default OAuth settings. Its Client ID
  Metadata Document names `private_key_jwt` in `token_endpoint_auth_method`
  and lists `["none", "private_key_jwt"]` in
  `token_endpoint_auth_methods_supported`; the server now accepts a document
  that allows `none` in either field and still refuses one that does not.
- Hosted: Reconnect all also picks up stores whose connection is missing a
  scope added to the app later (for example `read_all_orders`), and the
  stores page marks them "Needs a reconnect to approve new access".
- Release workflow waits until npm serves the new version before publishing
  to the MCP Registry.

## [2.0.0] - 2026-09-27

Breaking: hosted mode is now per-user Shopify sign-in only. Google sign-in, the
policy file, roles and personal access tokens were removed.

### Live deployment fixes

- Form posts no longer fail with "This form was submitted from another site"
  when Chromium sends `Origin: null` under `Referrer-Policy: no-referrer`;
  `Sec-Fetch-Site` decides when present.
- The connect pages allow the redirect through `admin.shopify.com` and
  `accounts.shopify.com` in CSP `form-action`, so sign-in buttons work.
- `SHOPIFY_CLIENT_ID_<ALIAS>` pairs with `SHOPIFY_CLIENT_SECRET_<ALIAS>`, so a
  store in another Shopify organization can use its own app.
- The public sign-in page no longer lists store names: one "Sign in with
  Shopify" button plus a field for another store's name or .myshopify.com
  address.
- `/` redirects to `/stores`, so opening the app from the Shopify admin loads.

### Cloudflare Workers review fixes

- Guided tools (prices, metafields, redirects, tags, orders, customers,
  fulfillment, and the pinned `shopify_search`/`shopify_get` reads) now run on
  the default API version, 2026-07, the one schema a Worker bundles. Before,
  they pinned 2026-04, so on Cloudflare the first guided call downloaded a
  second 6 MB schema from shopify.dev and held two parsed schemas in a 128 MB
  isolate. Only the legacy smart-collection `ruleSet` write stays on 2026-04;
  a Worker refuses it and points to `shopify_run_action`.
- A Worker never downloads a schema at run time: an unbundled API version fails
  at once with an error naming the bundled one, instead of a 30 second fetch.
- Guided writes failed on Workers with "Expected String to be a GraphQL
  nullable type": `graphql/execution/values.js` pulled a second copy of
  `graphql` into the bundle. Every import now uses the package root.
- `ACTIONS_DENYLIST` and `ACTIONS_DENYLIST_REPLACE` are read from the Worker's
  env (`runtimeEnv()`), not `process.env`, so an operator's denylist applies on
  Cloudflare whatever the compatibility date.
- Dynamically registered OAuth clients expire after 30 days without use
  (`OAUTH_CLIENT_IDLE_TTL_SECONDS`; each use pushes it back, at most one write a
  day). Registration is limited per source address per hour
  (`OAUTH_MAX_REGISTRATIONS_PER_SOURCE_PER_HOUR`, default 30, `0` for no
  limit; the TCP peer on Node, `CF-Connecting-IP` on Workers). The Durable
  Object keeps the client count in a counter key instead of listing every
  client on each registration.
- Cloudflare CLI setup now creates the D1 audit database explicitly
  (`npx wrangler d1 create shopify-multi-store-audit`, then its `database_id` in
  `wrangler.jsonc`). Automatic creation during `wrangler deploy` depends on
  wrangler's hidden experimental provisioning. `package.json` gains
  `cloudflare.bindings` descriptions for the Deploy to Cloudflare flow.
- Hosted: a store's Shopify token is decrypted only when a tool call uses that
  store. Before, every MCP request (including `initialize` and `tools/list`)
  read and decrypted the caller's token for every configured store.
- Hosted: the Shopify OAuth HMAC check uses the shared `src/shopify-hmac.ts`
  instead of a second copy.
- The `/stores` page names the server it belongs to (issuer and MCP URL), so a
  person with more than one deployment knows which connections they are
  looking at.
- README: the npm badge reads the live version; "up to ten stores" is now the
  real limit (one hundred); a "Connect your first store" section walks a new
  merchant through a Dev Dashboard app (client credentials or authorization
  code) or an admin-created custom app token; `prepare` builds the server so
  `npm install github:...` works; the `codex-shopify-multi-store` config and
  credential name is explained as a legacy name kept for existing installs.

Breaking changes for `shopify-multi-store serve` (local stdio mode is unchanged):
### Review 3: fixes and a smaller tool surface

Breaking: the server now exposes 29 tools instead of 85. Removed tools and their
replacements are listed below. Guided write tools take `dryRun` (default `true`)
instead of `confirm`.

Fixes:

- Write results are never dropped for size. Above 150,000 characters a write
  tool's result is trimmed (per-item `mutationResponse` and `verifiedState` to
  the changed fields, then one summary line per applied item), always keeping
  status, counts, and every item that did not apply, with `responseTrimmed`
  explaining what was cut. Before, `shopify_update_prices` with about 190 or more
  SKUs applied and verified every price and then reported failure. Variants are
  also read back 50 at a time, so long product titles cannot push the
  verification read over the 50,000 character response cap.
- `shopify_update_product`, `shopify_update_order` and `shopify_update_customer`
  no longer take `tags` (a silent full replace). `replaceTags` says it replaces
  all tags and the preview lists the tags it would remove; `addTags` and
  `removeTags` use `tagsAdd` and `tagsRemove` and leave other tags alone.
- Every guided write tool defaults to `dryRun: true` and returns a before/after
  (or would-create) preview; `dryRun: false` applies and reads back.
- Local `shopify_graphql_mutation` now applies the action denylist and the
  destructive confirm (confirm set to the mutation name), as hosted mode did.
- Destructive classification covers argument-driven destruction:
  `productUpdate` or `productChangeStatus` with status `ARCHIVED` or `DRAFT`,
  `productVariantsBulkCreate` with `REMOVE_STANDALONE_VARIANT`, and any mutation
  with `notifyCustomer: true` (one table, `DESTRUCTIVE_ARGUMENT_RULES`), plus
  always-destructive `publishablePublish`, `productPublish`, `collectionPublish`,
  discount activation, invoice and notification emails, `giftCardCreate`,
  `giftCardCredit` and `storeCreditAccountCredit`.
- `scripts/oauth-connect.mjs` verifies Shopify's OAuth HMAC with Shopify's
  escaping and array rules and a timestamp check, from the shared
  `src/shopify-hmac.ts`.
- Redirect writes report a per-item `outcome` of `applied`, `rejected` or
  `unknown` and a store `status` (`ok`, `partial`, `failed`, `unknown`), like
  `shopify_update_prices`; an unknown outcome is no longer flattened to
  `ok: false`.
- Pinned Admin API versions live in `src/api-versions.ts`, and a test fails 60
  days before any pinned version's end of support (12 months after release).
  Collection writes without a rule set now use the 2026-07
  `CollectionCreateInput`/`CollectionUpdateInput` (products are added with
  `collectionAddProducts`); writes with a legacy `ruleSet` stay on 2026-04,
  because 2026-07 replaced rule sets with typed collection sources.

Removed features: new-store previews, sample products, the MCP Apps UI
(`ui://` resource and `_meta.ui`), the Shopify CLI bridge and `shopify_cli`
store auth, and the unused GraphQL code generation (`src/generated`,
`scripts/codegen.mjs`). The build is plain `tsc`.

Removed or folded tools, with what to use instead:

| Removed tool | Use instead |
| --- | --- |
| `shopify_create_preview_store`, `shopify_get_preview_store`, `shopify_get_new_store_previews`, `shopify_get_new_store_preview_status`, `shopify_find_sample_product` | Removed with the feature. |
| `shopify_switch_shop` | Pass `store` on every call. |
| `shopify_get_store_capabilities` | `shopify_check_access` (shop identity and granted scopes). |
| 16 report tools (`shopify_portfolio_snapshot`, `shopify_order_summary`, `shopify_customer_growth`, `shopify_get_product_everywhere`, `shopify_compare_inventory`, `shopify_low_stock_report`, `shopify_compare_prices`, `shopify_duplicate_sku_report`, `shopify_list_unfulfilled_orders`, `shopify_fulfillment_sla_report`, `shopify_compare_catalog`, `shopify_catalog_gap_report`, `shopify_catalog_health`, `shopify_recent_product_changes`, `shopify_compare_collections`, `shopify_store_locations`) | `shopify_report` with `report` set to the old name without `shopify_`, same arguments. |
| `shopify_run_analytics_query` | `shopify_report` with `report: "analytics"`, `stores` and `query`. |
| `shopify_search_products`, `shopify_search_collections`, `shopify_list_orders`, `shopify_list_customers`, `shopify_list_publications`, `shopify_list_redirects`, `shopify_list_pages`, `shopify_list_files`, `shopify_list_metaobjects`, `shopify_list_markets`, `shopify_list_themes`, `shopify_list_delivery_profiles` | `shopify_search` with `resource` (`products`, `collections`, `orders`, `customers`, `publications`, `redirects`, `pages`, `files`, `metaobjects` with `type`, `markets`, `themes`, `delivery_profiles`). |
| `shopify_search_products_many` | `shopify_search` with `resource: "products"` and `stores`. |
| `shopify_get_product`, `shopify_get_collection`, `shopify_get_order`, `shopify_get_inventory_levels`, `shopify_get_metafields`, `shopify_get_theme_files`, `shopify_list_blog_articles`, `shopify_get_uploaded_image`, `shopify_bulk_export_status` | `shopify_get` with `resource` (`product`, `collection`, `order`, `inventory`, `metafields`, `theme_files`, `blog_articles`, `uploaded_image`, `bulk_operation`) and `id`. |
| `shopify_update_prices_many` | `shopify_update_prices` with `stores` instead of `store`. |
| `shopify_set_metafields`, `shopify_delete_metafields` | `shopify_metafields` with `set` and/or `delete`. |
| `shopify_create_redirects`, `shopify_delete_redirects` | `shopify_redirects` with `create` and/or `delete`. |
| `shopify_add_to_collection` | `shopify_update_collection` with `addProductIds`. |
| `shopify_publish_resource` | `shopify_run_action` with `mutation: "publishablePublish"`, `variables: { id, input: [{ publicationId }] }`, `confirm: "publishablePublish"`. |
| `shopify_bulk_update_product_status` | `shopify_run_action` with a document that aliases one `productUpdate(product: { id, status })` per product (or `mutation: "productChangeStatus"` per product); ARCHIVED and DRAFT need `confirm`. |
| `shopify_bulk_export_start` | `shopify_run_action` with `mutation: "bulkOperationRunQuery"` and `variables: { query }`; poll with `shopify_get` `resource: "bulk_operation"`. |
| `shopify_upsert_metaobject` | `shopify_run_action` with `mutation: "metaobjectUpsert"`, `variables: { handle: { type, handle }, metaobject: { handle, fields } }`. |
| `shopify_update_delivery_rate` | `shopify_run_action` with `mutation: "deliveryProfileUpdate"`. Shopify can accept a rate change and not persist it, so read the rate back with `shopify_search` `resource: "delivery_profiles"` afterwards; the old tool did this automatically. |
| `shopify_upsert_theme_files` | `shopify_run_action` with `mutation: "themeFilesUpsert"` (destructive: `confirm: "themeFilesUpsert"`). Check the theme's `role` with `shopify_search` `resource: "themes"` first; the old tool refused the live (MAIN) theme unless `allowLiveTheme: true`. |
| `shopify_delete_files` | `shopify_run_action` with `mutation: "fileDelete"`, `variables: { fileIds }`, `confirm: "fileDelete"`. |
| `shopify_create_draft_order` | `shopify_run_action` with `mutation: "draftOrderCreate"`, `variables: { input }`. |
| `shopify_upsert_page` | `shopify_run_action` with `mutation: "pageCreate"` (`variables: { page }`) or `"pageUpdate"` (`variables: { id, page }`). |

The 29 tools (count checked by a test):

| Area | Tools |
| --- | --- |
| Stores and access (3) | `shopify_list_stores`, `shopify_get_shop_info`, `shopify_check_access` |
| Reads (3) | `shopify_report`, `shopify_search`, `shopify_get` |
| Guided writes (14) | `shopify_update_prices`, `shopify_set_inventory`, `shopify_create_product`, `shopify_update_product`, `shopify_create_collection`, `shopify_update_collection`, `shopify_create_discount`, `shopify_upload_image`, `shopify_metafields`, `shopify_redirects`, `shopify_tags`, `shopify_update_order`, `shopify_update_customer`, `shopify_create_fulfillment` |
| Any mutation (3) | `shopify_find_actions`, `shopify_describe_action`, `shopify_run_action` |
| Raw GraphQL (3) | `shopify_graphql_query`, `shopify_graphql_query_many`, `shopify_graphql_mutation` |
| Schema and docs (3) | `shopify_graphql_schema`, `shopify_validate_graphql_codeblocks`, `shopify_search_docs_chunks` |

### Earlier unreleased changes

Breaking change for `shopify-multi-store serve`: `SHOPIFY_ACCESS_MODE` now
defaults to `per_user`. An existing deployment that relies on shared app tokens
must set `SHOPIFY_ACCESS_MODE=app`, or it will refuse to start without
`SHOPIFY_TOKEN_ENCRYPTION_KEY` and, once started, will require every person to
connect their stores at `/stores`. In per-user mode without a policy file,
every Google Workspace user in `ALLOWED_EMAIL_DOMAINS` signs in as an editor on
every store (the server logs a warning at startup); Shopify then limits each
person to their own staff permissions.

- Sign-in is Shopify login only. Google sign-in (`GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAINS`) is removed. People pick a
  configured store on a small chooser page (`SHOPIFY_IDENTITY_STORE` is listed
  first) and log in to its Shopify admin; the verified `associated_user` email
  of the Shopify online token is their identity, and that token is also kept
  as their connection to the store.
- Shopify permissions are the only rule. The policy file
  (`SHOPIFY_MULTI_STORE_POLICY`), roles (admin, editor, viewer), per-user store
  allowlists, and admin-only tools are removed.
- Hosted is always per-user. `SHOPIFY_ACCESS_MODE` and the `app` mode are
  removed: a hosted server never uses a shared app token or a static Admin API
  token (`SHOPIFY_TOKEN_<ALIAS>`), even when one is set.
  `SHOPIFY_REQUIRE_EMAIL_MATCH` is removed because every store connection must
  now match the signed-in Shopify email.
- Personal access tokens are removed: the `/tokens` page, `smsp_` bearer
  tokens, `PERSONAL_TOKENS_ENABLED`, `PERSONAL_TOKEN_MAX_DAYS`, and
  `PERSONAL_TOKENS_SHOPIFY_ACCESS`. Every supported client signs in with OAuth.
- Reconnect all: one click on `/stores` reconnects every expired or unconnected
  store in a row, with no further clicks while the person is logged in to the
  Shopify admin. Tool errors for an expired or unconnected store return one
  link, `/stores/reconnect`, which also signs in first when needed.
- Existing Google sign-in sessions, refresh tokens and personal access tokens
  stop working. People sign in again with Shopify.

- Hosted on Cloudflare Workers (optional; local stdio stays the default):
  `wrangler.jsonc`, `src/workers/`, and a Deploy to Cloudflare button. OAuth
  state lives in one Durable Object (strongly consistent single-use codes,
  refresh rotation and reuse detection), the audit log in D1, and one gzipped
  Admin schema is bundled and inflated on first use. See
  docs/DEPLOY-CLOUDFLARE.md. `serve` and the Dockerfile remain the "any
  server" option; both share the settings code (`src/hosted/config.ts`).
- Hosted internals: token encryption and Shopify HMAC use Web Crypto (the
  stored token format is unchanged, no migration); client metadata documents
  are fetched with plain `fetch` on Workers and with DNS pinning on Node; the
  OS keychain is imported only on the local stdio path.
- Hosted: per-user Shopify access. Each person's tool calls use their own
  Shopify online token for each store (`grant_options[]=per-user`), so Shopify
  enforces their permissions. Tokens are encrypted with AES-256-GCM
  (`SHOPIFY_TOKEN_ENCRYPTION_KEY`). Settings: `SHOPIFY_APP_CLIENT_ID`,
  `SHOPIFY_APP_CLIENT_SECRET`, `SHOPIFY_APP_SCOPES`.
- `shopify_run_action` dry runs report whether the preview is complete. IDs
  written inline in the document are looked up too. Search, saved-search,
  filter, and "all" style mutations, more than 250 IDs, and IDs that do not
  resolve make the preview incomplete, with reasons and the recommendation
  "Do not apply without narrowing"; applying such a document needs
  `acknowledgeIncompletePreview: true` as well as `confirm`.
- `shopify_run_action` and `shopify_graphql_mutation` judge each top-level
  mutation field on its own. The server injects every payload error list under
  a reserved `smsUserErrors_<field>` alias before sending, so an aliased or
  unselected `userErrors` can no longer hide a rejection. A store's outcome is
  `applied`, `rejected`, `partial`, or `unknown`; for `partial` and `unknown`
  the result lists which roots applied and advises retrying only the rejected
  roots in a new document, never rerunning the whole document.
- Add `shopify_find_actions`, `shopify_describe_action`, and
  `shopify_run_action`: search, describe, and run any Admin API mutation on up
  to 100 stores, with dry runs that resolve every record ID, confirm for
  destructive mutations, per-store variables, a denylist (`ACTIONS_DENYLIST`),
  and an `action_run` audit line.
- Add a full scope set: `node scripts/print-scopes.mjs --full`.
- Hosted per-user hardening: `SHOPIFY_TOKEN_ENCRYPTION_KEYS` rotates token
  encryption keys; personal access tokens carry no Shopify access unless
  `PERSONAL_TOKENS_SHOPIFY_ACCESS=1` (then capped at 30 days); `/shopify/connect`
  starts only from a CSRF-protected POST; Shopify callbacks older than 300
  seconds are refused; audit lines record the Shopify staff email per store.
- Actions: webhook, server-pixel, and bulk-mutation subscriptions are denied by
  default; `ACTIONS_DENYLIST` adds to the defaults (`ACTIONS_DENYLIST_REPLACE=1`
  replaces them); `productSet`, `themePublish` and similar mutations need
  confirm; in per-user mode `shopify_graphql_mutation` applies the same checks.
- Mutations are never resent after Shopify throttles them; the result says the
  change was not applied and is safe to retry.
- Docs: add `docs/ACTIONS.md`.
- `shopify_run_action` refuses two requested aliases that resolve to the same
  shop, naming both, before any lookup or write, so a mutation never runs twice
  on one shop.
- `shopify_graphql_mutation` no longer falls back to the non-alias-aware
  userErrors check when the Admin schema cannot be loaded (or the document does
  not validate). It scans each top-level response key for lists of objects
  with a `message`, reports per root, and says `unknown` rather than `applied`
  when nothing shows the outcome.
- `shopify_run_action` resolves every record ID again (variables and inline)
  with `nodes(ids:)` per store right before applying. An ID that does not
  resolve, or a failed lookup, refuses the apply unless
  `acknowledgeIncompletePreview: true`, matching the dry-run message.
- Hosted audit: `action_run` outcomes and failed Shopify token exchanges no
  longer store error text (a preflight coercion error quotes the input back,
  customer data included). They use the structured `error` of tool calls.
- Fix: `shopify_update_prices` no longer reports a write as `applied` when the
  read-back that verifies it fails. Such items are `applied_unverified` and the
  store status is `unverified` (not `ok`); `shopify_update_prices_many` counts
  those stores as not ok and reports an `unverified` total.
- Hosted audit log: failed tool calls no longer store the error message, which
  could quote customer data back from Shopify. `error` is now structured:
  class, exception name, HTTP status, Shopify error codes (ACCESS_DENIED,
  THROTTLED, userErrors codes), userErrors field paths, and a sha256 of the
  full message.
- Multi-store tools refuse two requested aliases that point to the same shop,
  naming both, so an action never runs twice on one shop; with no stores named,
  each shop is used once. Hosted mode refuses a store configuration that lists
  one shop under two aliases.
- Hosted: fix login CSRF in Google sign-in. Each sign-in sets a binding cookie
  (HttpOnly, Secure, SameSite=Lax, callback path only, 10 minutes) and stores
  only its hash. The callback checks it before using the login state or the
  Google code, so a callback URL forwarded to another browser creates no
  session. Applies to app sign-ins and the `/tokens` page. The node adapter now
  keeps every Set-Cookie header.
- Hosted audit log: stop storing raw GraphQL documents, search expressions, and
  free-text arguments. Documents are summarized (operation types, root fields,
  argument names, sha256), variables are hashed, and only ids, store aliases,
  enums, numbers and booleans are kept; other strings become a sha256. Customer
  data inside inline GraphQL literals or search strings no longer reaches the log.
- Hosted: a personal access token revoked while a request was being verified
  could be written back by the last-used update. The update is now conditional
  on the stored record, and the request is refused.
- Hosted: fix the OAuth store failing on Windows with EPERM. The temporary file is
  synced through the handle it was written with, then renamed; the directory is
  synced after the rename except on Windows. Write errors are no longer hidden.
- Fix: `shopify_update_prices` / `shopify_update_prices_many` now reject a call
  outright, before any write, when duplicate SKU rows in the input disagree on
  what to write (identical duplicate rows are still collapsed with a note).
- Fix: per-item write outcomes are now one of applied, rejected, not_found,
  ambiguous, unknown, skipped, or mismatch, and the store-level status (ok,
  partial, failed, unknown) is derived from every item's outcome instead of
  from whether the mutation call itself returned. `shopify_update_prices_many`
  derives its own `ok`/status from each store's status rather than from
  whether the per-store call threw.
- Fix: a network error, timeout, or throttled response with no data after a
  price write was sent is now reported as `unknown` (with a
  `doNotBlindlyRetry` hint), never mislabeled `rejected`.
- Fix: applying a price/cost change now performs a separate verification
  query for the affected variants afterward instead of only inspecting the
  mutation response; a mutation that looks successful but disagrees with that
  readback is reported as `mismatch` and the store status is not `ok`.
- Fix: `shopify_update_prices` only requires `write_inventory` when the
  request includes a `unitCost`; price/compareAtPrice-only requests need only
  `read_products` and `write_products`.

- Hosted: work with any MCP client on any plan, not only Claude. Built-in
  redirect URIs for Claude, ChatGPT, VS Code, VS Code Insiders, and Cursor
  live in `src/hosted/known-clients.ts`, plus loopback on any port for Claude
  Code, Codex, Gemini CLI, and desktop apps. `OAUTH_REDIRECT_URIS` now adds to
  the built-ins (`OAUTH_REDIRECT_URIS_REPLACE=1` replaces them), and
  `OAUTH_ALLOW_ANY_REDIRECT=1` accepts any https or safe private-use-scheme
  redirect behind a mandatory consent screen.
- Hosted: add a consent screen after Google sign-in showing the app, its
  redirect host, and the user's email, role, and stores. CSRF protected, single
  use, and remembered for 30 days per user, app, and redirect.
- Hosted: `OAUTH_CIMD_ALLOWED_HOSTS` defaults to `*`. Every client metadata
  fetch, including for named hosts, is limited to public addresses.
- Hosted: add personal access tokens (`smsp_`) managed at `/tokens`, for clients
  that only send a fixed Authorization header. Stored hashed, policy checked on
  every request, audited by token id. `PERSONAL_TOKENS_ENABLED` (default 1) and
  `PERSONAL_TOKEN_MAX_DAYS` (default 180).
- Hosted: `SERVER_DISPLAY_NAME` sets the name shown in AI apps and on the
  consent and token pages.
- Docs: rewrite `docs/HOSTED.md` for any client, with per-client connection
  steps.
- Add `shopify-multi-store serve`: a hosted Streamable HTTP connector at `/mcp` with a built-in OAuth 2.1 authorization server (PKCE S256, Dynamic Client Registration, Client ID Metadata Documents, rotating refresh tokens) and Google Workspace sign-in.
- Add a policy file for per-user roles (admin, editor, viewer) and store allowlists, enforced for every tool.
- Add a JSON Lines audit log of every hosted tool call.
- Add `STORES_JSON` as an alternative to the stores file, a Dockerfile, and `/healthz`.
- Move server construction into `createServer()`; stdio behavior is unchanged.
- Add admin-parity tools: `shopify_update_prices` / `shopify_update_prices_many`,
  metafield tools (`shopify_get_metafields`, `shopify_set_metafields`,
  `shopify_delete_metafields`), metaobject tools (`shopify_list_metaobjects`,
  `shopify_upsert_metaobject`), redirect tools (`shopify_list_redirects`,
  `shopify_create_redirects`, `shopify_delete_redirects`), delivery profile tools
  (`shopify_list_delivery_profiles`, `shopify_update_delivery_rate`), theme tools
  (`shopify_list_themes`, `shopify_get_theme_files`, `shopify_upsert_theme_files`),
  file tools (`shopify_list_files`, `shopify_delete_files`),
  `shopify_create_draft_order`, `shopify_update_order`, a generic `shopify_tags`,
  `shopify_update_customer`, `shopify_create_fulfillment`, page and blog article
  tools (`shopify_list_pages`, `shopify_upsert_page`, `shopify_list_blog_articles`),
  `shopify_list_markets`, and `shopify_check_access`.
- Every new write tool defaults to `dryRun: true` and returns a before/after
  preview; `dryRun: false` applies the change and reads the result back.
  `shopify_update_delivery_rate` treats a readback that disagrees with the
  requested amount as a failure, since Shopify can accept that mutation with no
  userErrors and silently discard it. `shopify_upsert_theme_files` refuses to
  write to the live (MAIN) theme unless `allowLiveTheme: true`.
- Add `src/scope-requirements.ts`, mapping every tool (existing and new) to the
  Admin API scopes it needs, and `scripts/print-scopes.mjs` to print their union
  for a `shopify.app.toml`.
- Fix `shopify_create_draft_order`, `shopify_update_order`, `shopify_update_customer`
  and `shopify_upsert_page` sending `dryRun` inside the Shopify input, which made
  every `dryRun: false` call fail. Inputs are now built from field allowlists.
- Hosted: cap the lifetime of a refresh token family with
  `OAUTH_SESSION_MAX_AGE_SECONDS` (default 7 days). After it, the user signs in
  with Google again. Every refresh re-checks the access policy.
- Hosted: fix a race where concurrent requests with the same refresh token
  could all succeed. Uses of one refresh token are now serialized, so exactly
  one succeeds and the rest trigger family revocation.
- Fix `shopify_update_prices` SKU resolution: Shopify's `sku:` search is a
  prefix match and only 5 results were read. The tool now reads up to 250
  candidates per page, follows full pages, keeps only exact (case-sensitive,
  trimmed) SKU matches, and skips SKUs shared by several variants unless
  `allowDuplicates: true` is passed.
- Fix readback checks in `shopify_update_prices` and
  `shopify_update_delivery_rate` comparing money as strings, so "12" against
  "12.00" was reported as a mismatch and "5" against "5.0" as not persisted.
  Amounts are now compared as decimals.
- Fix `shopify_create_fulfillment` refusing to run without `write_fulfillments`.
  It no longer checks scopes itself; Shopify reports the missing scope, and
  `shopify_check_access` lists the merchant-managed fulfillment order scopes.
- `shopify_update_delivery_rate` reads the rate back from the given profile and
  method definition by id instead of scanning the first 50 profiles.
- `shopify_create_fulfillment` also fulfills IN_PROGRESS (partially fulfilled)
  fulfillment orders, sending the remaining quantity of each line item.
- Hosted audit log: read-only calls record an argument hash and the first
  2,000 characters of a `query` argument; mutation arguments hash customer
  email, phone, and address fields; logged strings are capped at 2,000
  characters and lines at 64 KB. Sign-in, token issue and refresh, refresh
  denials, and 401/403 responses are logged as auth events.
- Hosted: with `OAUTH_CIMD_ALLOWED_HOSTS=*`, client metadata URLs must resolve
  to public addresses. Private, loopback, link-local, cloud metadata, and
  reserved IPv4 and IPv6 ranges are refused at connect time, so a DNS change
  between check and connection does not help. Redirects are not followed.

## [1.6.0] - 2026-09-07

- Add guided Admin workflows for products, variants, collections, inventory, discounts, media, publication, analytics, and bulk exports.
- Add interactive product cards, tables, charts, and preview status.
- Add temporary Shopify storefronts with custom Dawn designs, sample products, and claim links.
- Add category-specific sample catalogs and agent-generated product concepts.
- Fix GraphQL error reporting, mutation guards, response timeouts, cursor cycles, and inventory idempotency.
- Prevent duplicate preview requests and partial reads of preview status files.
- Support Shopify CLI execution on Windows without a shell.
- Use Shopify's Admin client, schema code generation, and a pinned Dawn source.

## [1.5.1] - 2026-09-01

### Fixed

- Use a Keychain-safe account name for OAuth client secrets. The previous
  `<alias>:client-secret` account was rejected by the macOS backend, which allows
  only alphanumerics, dots, underscores, `@` and hyphens, so every store using
  `client_credentials` auth failed on macOS with "account contains invalid
  characters" when reading or writing its secret. The account is now
  `<alias>-client-secret`. No migration is needed: the old name could never be
  written successfully on macOS, so re-run `shopify-multi-store oauth` to store
  the secret for any affected store.
- Reject Shopify retry delays longer than 60 seconds instead of leaving an MCP request stalled.
- Keep successful-store counts accurate when a large result must be omitted.
- Fail explicitly when error payloads alone exceed the combined response limit.
- Include both the OAuth error code and description when authorization-code exchange fails.

### Changed

- Multi-store response fitting now serializes each store result once.
- Store health checks now run in parallel and use the shared default Shopify API version.
- Refreshed the README badge URLs to clear GitHub's cached broken downloads badge.

## [1.5.0] - 2026-08-22

### Fixed

- Failed stores now report `complete: false` in every bounded report.
- Hidden secret input now rejects an interrupted terminal entry.
- Persistent GraphQL throttling now returns an explicit tool error.
- Concurrent OAuth requests now share one token exchange.
- Authorization-code exchange now has a timeout and safe non-JSON errors.
- Legacy imports now restore credentials after a partial failure.
- Missing products, SKUs, and collections no longer appear consistent.
- Multi-store size limits now omit oversized store results without discarding other results.
- Pagination now tracks response size in linear time.
- The live test now supports repository paths that contain spaces.

### Changed

- Price comparison now uses a smaller GraphQL query.
- GraphQL results now include request IDs, elapsed time, and retry counts.
- Order summaries now label partial currency totals.
- `doctor` now tests each credential and store connection.
- Shopify `Retry-After` values no longer have a 10-second cap.

### Documentation

- Added npm provenance publishing through GitHub Actions.
- Added an official MCP Registry manifest.
- Added a security support policy, contribution guide, comparison table, and terminal demo.

## [1.4.0] - 2026-08-22

- Added exact product lookup and product search across stores.
- Added fulfillment SLA and catalog gap reports.
- Added cross-store transfer opportunities to the low-stock report.

## [1.3.0] - 2026-08-22

- Added nine portfolio reports.
- Added Shopify throttle retries and credential-aware OAuth caching.
- Added token checks, legacy Hermes import support, and fail-loud pagination.

## [1.2.1] - 2026-08-22

- Completed product and variant pagination before store comparisons.
- Improved credential deletion errors and public project documentation.

## [1.2.0] - 2026-08-21

- Published the first npm release with multi-store queries, reports, OAuth, and portable skills.

[1.5.0]: https://github.com/alex-brecher/shopify-multi-store/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/alex-brecher/shopify-multi-store/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/alex-brecher/shopify-multi-store/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/alex-brecher/shopify-multi-store/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/alex-brecher/shopify-multi-store/releases/tag/v1.2.0
