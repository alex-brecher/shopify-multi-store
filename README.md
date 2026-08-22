<div align="center">

# Shopify Multi-Store MCP

### One MCP server. Every Shopify store.

Query, compare, report, and make guarded updates across Shopify stores from Claude, Codex, Cursor, VS Code, and other MCP clients.

[![CI](https://github.com/alex-brecher/shopify-multi-store/actions/workflows/ci.yml/badge.svg)](https://github.com/alex-brecher/shopify-multi-store/actions/workflows/ci.yml)
[![npm v1.2.1](https://img.shields.io/badge/npm-v1.2.1-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/shopify-multi-store-mcp-server)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](package.json)
[![MCP ready](https://img.shields.io/badge/MCP-ready-7C3AED)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-F4C430)](LICENSE)

[Quick start](#-quick-start) · [Reports](#-ready-made-reports) · [AI clients](#-connect-an-ai-client) · [Security](#-security-model)

</div>

## 🚀 Quick start

Install the server, connect your stores, and run the health check:

```bash
npm install --global shopify-multi-store-mcp-server
shopify-multi-store setup
shopify-multi-store doctor
```

Claude Code users can add the server with one command:

```bash
claude mcp add shopify-multi-store -- npx -y shopify-multi-store-mcp-server start
```

Each store gets a permanent alias and a separate secure credential. Every store operation requires that alias.

## ✨ What you get

| Capability | Result |
| --- | --- |
| Multiple active stores | Keep every Shopify store available in one AI conversation. |
| Cross-store reports | Compare inventory and catalogs, find unfulfilled orders, and review a portfolio snapshot. |
| Parallel GraphQL | Run one read-only query across up to ten stores. |
| Guarded mutations | Target one store and pass an explicit confirmation for each update. |
| Secure credentials | Use macOS Keychain, Windows Credential Manager, or Linux Secret Service. |
| Portable skills | Guide Claude, Codex, Cursor, and other compatible agents. |

## 📊 Ready-made reports

| Tool | Purpose |
| --- | --- |
| `shopify_portfolio_snapshot` | Summarize products, orders, customers, currency, plan, and store identity. |
| `shopify_compare_inventory` | Compare inventory quantities for selected SKUs across stores. |
| `shopify_list_unfulfilled_orders` | List open fulfillment work across selected stores. |
| `shopify_compare_catalog` | Compare products by handle, status, vendor, type, and variants. |

Try prompts like these:

- “Give me a portfolio snapshot for every connected store.”
- “Compare inventory for SKU A123 and B456 across retail and wholesale.”
- “List unfulfilled orders from the last seven days in three stores.”
- “Compare the active catalog across these stores and show missing handles.”

## 🔌 Connect an AI client

The server works in clients that support local stdio MCP servers. Agent Skills improve tool selection when the client supports them.

<details>
<summary><strong>Claude Code</strong></summary>

Add the MCP server:

```bash
claude mcp add shopify-multi-store -- npx -y shopify-multi-store-mcp-server start
```

Copy the included skill for personal use:

```bash
mkdir -p ~/.claude/skills/shopify-multi-store
cp .claude/skills/shopify-multi-store/SKILL.md ~/.claude/skills/shopify-multi-store/SKILL.md
```

Claude Code also discovers `.claude/skills` inside this repository.

</details>

<details>
<summary><strong>Claude Desktop and Cursor</strong></summary>

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

</details>

<details>
<summary><strong>VS Code</strong></summary>

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

</details>

<details>
<summary><strong>Other LLM clients</strong></summary>

Use `npx` as the command and `-y shopify-multi-store-mcp-server start` as the arguments.

Copy `skills/shopify-multi-store/SKILL.md` into the client's skills directory when supported. Clients without skill support still get every MCP tool.

</details>

## 🔑 Store authentication

| Method | Command | Best fit |
| --- | --- | --- |
| Admin API access token | `shopify-multi-store setup` | An existing Shopify admin-created app and token. |
| Client credentials | `shopify-multi-store oauth` | Stores in the same organization as the app. |
| Authorization code | `shopify-multi-store oauth` | Standalone app installations. |

Authorization code setup uses `http://127.0.0.1:3456/oauth/callback`. Add it as an allowed redirect URL first.

The default authorization code scopes are read-only. Grant only the Admin API scopes required for the task.

### Manage stores

```bash
shopify-multi-store list
shopify-multi-store doctor
shopify-multi-store remove store-alias
```

<details>
<summary><strong>Import an existing stores.json file</strong></summary>

```bash
shopify-multi-store import /absolute/path/to/stores.json
```

The import copies credentials into the operating system credential store and preserves configured stores. Delete the old credential file after checking the import.

</details>

## 🧰 MCP tools

| Tool | Action |
| --- | --- |
| `shopify_list_stores` | List configured store aliases. |
| `shopify_get_shop_info` | Read one store's identity. |
| `shopify_portfolio_snapshot` | Create a cross-store summary. |
| `shopify_compare_inventory` | Compare SKU inventory. |
| `shopify_list_unfulfilled_orders` | Report fulfillment work. |
| `shopify_compare_catalog` | Compare product catalogs. |
| `shopify_graphql_query` | Run a read-only Admin GraphQL query. |
| `shopify_graphql_query_many` | Run one query across up to ten stores. |
| `shopify_graphql_mutation` | Change one store after exact authorization. |

Read-only operations can run in parallel. Mutations stay isolated to one selected store.

## 🧩 Shopify companion skills

Install Shopify's official Admin GraphQL and ShopifyQL skills:

```bash
shopify-multi-store install-shopify-skills
```

The command installs both skills for supported agents. Pass `--agent <name>` to select one agent.

The skills search Shopify documentation and check custom GraphQL operations. ShopifyQL adds sales, revenue, order, conversion, and trend analysis.

This server still controls store selection, credentials, execution, and mutation authorization. Shopify's skill scripts send usage telemetry by default.

Set `OPT_OUT_INSTRUMENTATION=true` to turn off that telemetry.

This integration uses the official [Shopify AI Toolkit](https://github.com/Shopify/Shopify-AI-Toolkit). It also reflects useful patterns from [Shopify Admin Skills](https://github.com/40rty-ai/shopify-admin-skills).

## 🔐 Security model

Secrets never enter the main configuration file.

| Platform | Credential backend |
| --- | --- |
| macOS | Keychain |
| Windows | Credential Manager |
| Linux | Secret Service |

The configuration stores aliases, domains, API versions, and non-secret OAuth client IDs. Its default path is `~/.config/codex-shopify-multi-store/stores.json`.

Set `SHOPIFY_MULTI_STORE_CONFIG` to use another configuration path.

- Never commit access tokens, OAuth client secrets, `.env` files, or credential-bearing configuration files.
- Grant only the Shopify Admin API scopes required for the task.
- Confirm the target store before every mutation.
- Read [SECURITY.md](SECURITY.md) for vulnerability reporting.

Linux credential storage requires a Secret Service provider, such as GNOME Keyring or KWallet.

## 📦 Other installation options

Run a health check without a global install:

```bash
npx -y shopify-multi-store-mcp-server doctor
```

Install directly from GitHub:

```bash
npm install --global github:alex-brecher/shopify-multi-store
```

## 🛠 Development

```bash
git clone https://github.com/alex-brecher/shopify-multi-store.git
cd shopify-multi-store
npm ci
npm test
npm run test:live
npm pack --dry-run
```

The live test uses configured stores and performs read-only Shopify Admin API calls.

## License

MIT
