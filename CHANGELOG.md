# Changelog

This file records notable changes to Shopify Multi-Store MCP.

## [Unreleased]

- Hosted: a personal access token revoked while a request was being verified
  could be written back by the last-used update. The update is now conditional
  on the stored record, and the request is refused.
- Hosted: fix the OAuth store failing on Windows with EPERM. The temporary file is
  synced through the handle it was written with, then renamed; the directory is
  synced after the rename except on Windows. Write errors are no longer hidden.
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
