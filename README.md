# Shopify Multi-Store MCP Server and AI Skill

[![CI](https://github.com/alex-brecher/shopify-multi-store/actions/workflows/ci.yml/badge.svg)](https://github.com/alex-brecher/shopify-multi-store/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Connect Claude, Codex, Cursor, VS Code, and other MCP clients to multiple Shopify stores at once.

Use one secure MCP server to query, compare, report on, and manage Shopify Admin data across stores. Each store keeps a separate credential and a required alias. Read-only operations can run in parallel. Mutations remain isolated to one explicitly selected store.

## What it does

- Connects multiple Shopify Admin stores without switching or disconnecting stores.
- Creates portfolio, inventory, catalog, and unfulfilled-order reports.
- Runs one read-only GraphQL query across up to ten stores in parallel.
- Stores credentials in macOS Keychain, Windows Credential Manager, or Linux Secret Service.
- Supports access tokens, Shopify client credentials, and OAuth authorization codes.
- Requires an explicit store alias for every operation.
- Separates read-only queries from guarded mutations.
- Includes portable Agent Skills for Codex and Claude.

## Requirements

- Node.js 20 or newer
- Shopify Admin API credentials for each store
- An MCP-compatible client for tool access

Linux credential storage requires a working Secret Service provider, such as GNOME Keyring or KWallet.

## Install

Install the command globally from npm after the package is published:

```bash
npm install --global shopify-multi-store-mcp-server
```

Run it without a global install:

```bash
npx -y shopify-multi-store-mcp-server doctor
```

Install directly from GitHub:

```bash
npm install --global github:alex-brecher/shopify-multi-store
```

For local development:

```bash
git clone https://github.com/alex-brecher/shopify-multi-store.git
cd shopify-multi-store
npm ci
npm test
```

## Connect a store

### Existing Admin API token

Use this option for an existing Shopify admin-created app and access token:

```bash
shopify-multi-store setup
```

Enter a store alias, its permanent `*.myshopify.com` domain, and its Admin API access token.

### OAuth onboarding

Start the guided OAuth setup:

```bash
shopify-multi-store oauth
```

Choose one mode:

- `client-credentials` uses a Shopify app client ID and secret. Shopify limits this grant to stores in the same organization as the app. The server refreshes short-lived tokens automatically.
- `authorization-code` opens Shopify authorization in a browser. Register `http://127.0.0.1:3456/oauth/callback` as an allowed redirect URL first.

Use the minimum Admin API scopes needed for your work. The default authorization-code scopes are read-only.

## Manage stores

```bash
shopify-multi-store list
shopify-multi-store doctor
shopify-multi-store remove store-alias
```

Import a compatible multi-store `stores.json` file:

```bash
shopify-multi-store import /absolute/path/to/stores.json
```

The import copies credentials into the operating system credential store and preserves other configured stores. Delete the legacy credential file after confirming the import.

## Connect an AI client

The MCP server works in any client that supports local stdio MCP servers. Skills improve tool selection in clients that support the Agent Skills format.

### Claude Code

Add the MCP server:

```bash
claude mcp add shopify-multi-store -- npx -y shopify-multi-store-mcp-server start
```

Copy the skill for personal use:

```bash
mkdir -p ~/.claude/skills/shopify-multi-store
cp .claude/skills/shopify-multi-store/SKILL.md ~/.claude/skills/shopify-multi-store/SKILL.md
```

Claude Code also discovers the included `.claude/skills` folder when working inside this repository.

### Claude Desktop and Cursor

Add this server to the client's MCP configuration:

```json
{
  "mcpServers": {
    "shopify-multi-store": {
      "command": "npx",
      "args": ["-y", "shopify-multi-store-mcp-server", "start"]
    }
  }
}
```

### VS Code

Add this server to `.vscode/mcp.json`:

```json
{
  "servers": {
    "shopify-multi-store": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "shopify-multi-store-mcp-server", "start"]
    }
  }
}
```

### Other LLM clients

Use `npx` as the command and `-y shopify-multi-store-mcp-server start` as the arguments. Copy `skills/shopify-multi-store/SKILL.md` into the client's skills directory when supported.

Clients without skill support can still use every MCP tool.

## Official Shopify companion skills

Install Shopify's official Admin GraphQL and ShopifyQL skills as optional companions:

```bash
shopify-multi-store install-shopify-skills
```

The default command installs both skills for every supported agent. Pass `--agent <name>` to limit the installation to one agent.

The skills search Shopify documentation and validate custom GraphQL operations.

The ShopifyQL skill adds sales, revenue, order, conversion, and trend analysis. This plugin can run its read-only GraphQL wrapper across selected stores.

This MCP server still controls store selection, credentials, execution, and mutation authorization. This separation keeps the multi-store safety model intact.

Shopify's skill scripts send usage telemetry by default. Set `OPT_OUT_INSTRUMENTATION=true` to turn it off.

The plugin does not bundle large single-store skill collections. Their mutation flows can bypass this server's alias and confirmation controls.

This integration uses the official [Shopify AI Toolkit](https://github.com/Shopify/Shopify-AI-Toolkit). Its operating workflows also reflect useful patterns from [Shopify Admin Skills](https://github.com/40rty-ai/shopify-admin-skills).

## Ready-made reports

- `shopify_portfolio_snapshot` summarizes products, orders, customers, currency, plan, and store identity.
- `shopify_compare_inventory` compares inventory quantities for selected SKUs across stores.
- `shopify_list_unfulfilled_orders` lists open fulfillment work across selected stores.
- `shopify_compare_catalog` compares products by handle, status, vendor, type, and variants.

Example prompts:

- “Give me a portfolio snapshot for every connected store.”
- “Compare inventory for SKU A123 and B456 across retail and wholesale.”
- “List unfulfilled orders from the last seven days in three stores.”
- “Compare the active catalog across these stores and show missing handles.”

## MCP tools

- `shopify_list_stores` lists configured store aliases.
- `shopify_get_shop_info` verifies one store's identity.
- `shopify_portfolio_snapshot` creates a cross-store summary.
- `shopify_compare_inventory` compares SKU inventory.
- `shopify_list_unfulfilled_orders` reports fulfillment work.
- `shopify_compare_catalog` compares product catalogs.
- `shopify_graphql_query` runs a read-only Admin GraphQL query.
- `shopify_graphql_query_many` runs one query across up to ten stores.
- `shopify_graphql_mutation` changes one store after exact authorization.

Every store operation requires an alias. This reduces the risk of changing the wrong store.

## Credential storage

Secrets never enter the main configuration file.

| Platform | Credential backend |
| --- | --- |
| macOS | Keychain |
| Windows | Credential Manager |
| Linux | Secret Service |

The configuration file stores aliases, domains, API versions, and non-secret OAuth client IDs. It defaults to `~/.config/codex-shopify-multi-store/stores.json`.

Set `SHOPIFY_MULTI_STORE_CONFIG` to use another configuration path.

## Security

- Never commit access tokens, OAuth client secrets, `.env` files, or credential-bearing configuration files.
- Grant only the Shopify Admin API scopes required for the intended work.
- Confirm the target store before every mutation.
- Review [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Development

```bash
npm ci
npm test
npm run test:live
npm pack --dry-run
```

The live test uses configured stores. It performs read-only Shopify Admin API calls.

## License

MIT
