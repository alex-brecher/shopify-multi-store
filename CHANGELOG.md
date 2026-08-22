# Changelog

This file records notable changes to Shopify Multi-Store MCP.

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
