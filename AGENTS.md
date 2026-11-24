# AGENTS.md

Notes for coding agents working in this repository.

## Layout

- `src/` is the TypeScript source. `dist/` is the compiled output and is committed; rebuild it with `npm run build` whenever `src/` changes.
- `src/hosted/` is the hosted (multi-user) mode: OAuth server (`oauth.ts`), Shopify sign-in and store connections (`shopify-connect.ts`), HTML pages and security headers (`html.ts`), known client redirect URIs (`known-clients.ts`).
- `src/workers/` is the Cloudflare Workers entry point and Durable Object store.
- `tests/` holds `node:test` suites that import from `dist/`.

## Checks

- `npm ci` then `npm test` (builds, then runs every suite). All tests must pass before a pull request.
- Add a regression test for each behavior change (see CONTRIBUTING.md).
- Record user-visible changes under `## [Unreleased]` in CHANGELOG.md.

## Rules

- Work on a branch and open a pull request; do not commit to `main` directly.
- Never commit credentials, store tokens, customer data or production responses.
- Keep `package.json`'s version and any deployment config's `__SMS_PACKAGE_VERSION__` in step when releasing.
- Hosted pages send a strict CSP. Chromium applies `form-action` to every redirect hop after a form post, so any form that ends in a redirect must allow every origin in that chain.
- Publishing to npm happens only from a GitHub release (`.github/workflows/publish.yml`); merging does not publish.
