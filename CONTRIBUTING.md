# Contributing

Thank you for improving Shopify Multi-Store MCP.

## Before you start

- Search existing issues before you create a new issue.
- Use GitHub Security Advisories for suspected vulnerabilities.
- Do not include store credentials, customer data, or production responses.

## Make a change

1. Fork the repository and create a focused branch.
2. Install dependencies with `npm ci`.
3. Change source files in `src/` or scripts in `scripts/`.
4. Add a regression test for each behavior change.
5. Run `npm test`.
6. Run `npm pack --dry-run` for package changes.
7. Open a pull request with the reason, scope, and test results.

## Code requirements

- Keep TypeScript strict.
- Validate external input with Zod.
- Keep credentials separate for each store.
- Preserve store aliases in all Shopify operations.
- Keep read-only tools free of mutations.
- Require `confirm: true` for each mutation.
- Report partial data with `complete: false`.
- Keep store errors visible in multi-store results.

## Pull request checklist

- [ ] The change has a focused purpose.
- [ ] The test suite passes.
- [ ] New behavior has regression coverage.
- [ ] Documentation matches the tool behavior.
- [ ] The change contains no credentials or customer data.
