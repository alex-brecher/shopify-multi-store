# Shopify Multi Store

This Codex plugin keeps multiple Shopify Admin stores available in one task. Each store has a separate alias and access token, so changing stores does not disconnect another store.

## Requirements

- macOS with Keychain access
- Node.js 20 or newer
- A Shopify Admin API access token for each store

## Install

Clone the repository and install its dependencies:

```bash
git clone https://github.com/alex-brecher/shopify-multi-store.git
cd shopify-multi-store
npm ci
npm run build
```

Install the local plugin in Codex using the cloned directory. The repository includes the Codex plugin manifest and MCP server configuration.

## Add a store

1. Open a terminal in this plugin directory.
2. Run this command:

```bash
npm run configure -- add
```

3. Enter a short store alias.
4. Enter the permanent `*.myshopify.com` domain.
5. Enter the Admin API access token.
6. Repeat the command for each store.

The script saves each token in macOS Keychain under the service name `codex-shopify-multi-store`. The configuration file contains no access tokens.

## Import an existing toolkit

Import a compatible multi-store `stores.json` file:

```bash
npm run import-legacy -- /absolute/path/to/stores.json
```

The import saves each token in macOS Keychain. It changes both configuration files to owner-only access. Delete the legacy credential file when you no longer need it.

Use only the Admin API scopes that each task needs. Shopify controls the available data through these scopes.

## Manage stores

List the configured stores:

```bash
npm run configure -- list
```

Remove one store and its Keychain token:

```bash
npm run configure -- remove store-alias
```

## Available tools

- `shopify_list_stores` lists the connected store aliases.
- `shopify_get_shop_info` gets the identity of one store.
- `shopify_graphql_query` runs a read-only Admin GraphQL query.
- `shopify_graphql_mutation` changes one store after exact authorization.

Every store action needs a store alias. This requirement reduces the risk of a change to the wrong store.

## Security

- Never commit access tokens, OAuth client secrets, `.env` files, or credential-bearing `stores.json` files.
- Grant only the Shopify Admin API scopes required for the intended tasks.
- Confirm the target store before running a mutation.
- See [SECURITY.md](SECURITY.md) for reporting instructions.

## Development

```bash
npm ci
npm test
```

## License

MIT
