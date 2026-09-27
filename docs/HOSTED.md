# Hosted connector

Run this server once, and your team uses it from whatever AI app they already have: Claude, ChatGPT, Codex, Claude Code, Cursor, VS Code, Gemini CLI, Windsurf, or any other MCP client that supports remote servers over Streamable HTTP. Nothing depends on a particular vendor or plan. Claude users on any plan can add it as a personal custom connector; a Team or Enterprise organization is optional, not required.

People sign in with their Google Workspace account and approve the app on a consent screen. By default (per-user mode) each person then connects each store with their own Shopify staff account at `/stores`, and every tool call runs with that person's own Shopify permissions: Shopify decides what they can do, not a separate permission system. Shopify tokens never leave the server. Clients that cannot run OAuth can use a personal access token instead. See [ACTIONS.md](ACTIONS.md) for per-user access and the generic action tools.

## How it works

```
AI app ──HTTPS──> /mcp (Streamable HTTP, bearer token)
   │                 │
   │ OAuth 2.1       ├─ per-user mode: the caller's own Shopify online token per store
   │                 ├─ policy (optional in per-user mode): role + store allowlist per user
   ▼                 ├─ audit log (JSON Lines)
/authorize ──> Google sign-in ──> consent screen ──> code back to the app
/token, /register, /.well-known/*, /tokens (personal access tokens)
/stores ──> /shopify/connect ──> Shopify staff login ──> /shopify/callback
```

- `shopify-multi-store serve` starts one HTTP server. It is the MCP endpoint and its own OAuth 2.1 authorization server.
- Login is delegated to Google. The server checks the id_token signature against Google's keys, plus `iss`, `aud`, `exp`, `nonce`, `email_verified`, and the Workspace `hd` claim.
- After sign-in, a consent screen shows which app is asking, where it will return to, and the user's role and stores. Nothing is issued until the user approves.
- The server issues its own opaque access and refresh tokens. Only their SHA-256 hashes are stored.
- Every MCP request is checked against the policy (the policy file, or in per-user mode without one, "anyone from `ALLOWED_EMAIL_DOMAINS`"). Removing a user from the policy blocks them on their next request.
- In per-user mode (`SHOPIFY_ACCESS_MODE=per_user`, the default) every Shopify call uses the caller's own online token for that store. A store the caller has not connected, or whose token expired, returns an error with the exact URL to connect it. There is no fallback to the app token.
- `shopify-multi-store start` (stdio) is unchanged for local use. No policy applies there.

### Why stateless

The MCP endpoint is stateless: each request builds a new server instance for the caller's role. There are no MCP sessions to lose on restart, auth is checked on every request, and `GET`/`DELETE /mcp` answer `405` (allowed by the spec for servers without session streams). Tool calls are request/response, so nothing needs a long-lived stream.

## Connect from your AI app

You need two things from whoever runs the server: the MCP URL, `https://<host>/mcp`, and access in the policy file. Most apps then sign you in with OAuth: a browser opens, you sign in with your company Google account, and you approve the app on the consent screen. The approval is remembered for 30 days per app.

Menu names and config formats below belong to each vendor and change often. Treat them as a guide and check the vendor's current docs if something has moved.

### Claude (web, Desktop, mobile)

1. Settings > Connectors > Add custom connector.
2. Name it (for example "Shopify") and paste `https://<host>/mcp`. Leave the OAuth client ID and secret empty.
3. Click Connect, sign in with Google, and approve.

This works as a personal custom connector on any Claude plan, within the connector limits Anthropic sets for each plan. On Team and Enterprise plans an organization Owner can optionally add it once for everyone under Organization settings > Connectors; members still sign in and approve for themselves.

### ChatGPT

1. Settings > Apps and Connectors > Advanced settings: turn on developer mode.
2. Create a connector (or app), paste `https://<host>/mcp` as the MCP server URL, and choose OAuth.
3. Sign in with Google and approve.

Which ChatGPT plans can add custom MCP servers, and whether they can write or only read, is set per OpenAI's current terms.

### Codex (CLI and IDE extension)

In `~/.codex/config.toml`:

```toml
[mcp_servers.shopify]
url = "https://<host>/mcp"
```

Then run `codex mcp login shopify` and finish sign-in in the browser. To use a personal access token instead, add `bearer_token_env_var = "SHOPIFY_MCP_TOKEN"` to that table and export the token in that variable.

### Claude Code

```bash
claude mcp add --transport http shopify https://<host>/mcp
```

Run `/mcp` in Claude Code and choose the server to sign in. With a personal access token: `claude mcp add --transport http shopify https://<host>/mcp --header "Authorization: Bearer smsp_..."`.

### Cursor

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "shopify": { "url": "https://<host>/mcp" }
  }
}
```

Cursor prompts you to sign in when the server first connects. With a personal access token, add `"headers": { "Authorization": "Bearer smsp_..." }`.

### VS Code

In `.vscode/mcp.json` (or your user MCP configuration):

```json
{
  "servers": {
    "shopify": { "type": "http", "url": "https://<host>/mcp" }
  }
}
```

Start the server from the MCP view and allow the sign-in. With a personal access token, add `"headers": { "Authorization": "Bearer ${input:shopify-token}" }` and an `inputs` entry so the token is not stored in the file.

### Gemini CLI

In `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "shopify": { "httpUrl": "https://<host>/mcp" }
  }
}
```

Run `/mcp auth shopify` to sign in. With a personal access token, add `"headers": { "Authorization": "Bearer smsp_..." }`.

### Windsurf and other clients

Any client that supports remote MCP servers over Streamable HTTP can connect in one of two ways:

- URL plus OAuth: give it `https://<host>/mcp`. It discovers the rest from `/.well-known/oauth-protected-resource`, registers itself (Dynamic Client Registration or a Client ID Metadata Document), and opens the sign-in page.
- URL plus a fixed header: give it `https://<host>/mcp` and the header `Authorization: Bearer smsp_...` from a personal access token.

For Windsurf, add the URL to its MCP config (`serverUrl`). If your version cannot finish OAuth against this server, use a personal access token header. If a client's OAuth callback is refused, ask the operator to add it with `OAUTH_REDIRECT_URIS`.

### Personal access tokens

For apps that can only send a fixed header:

1. Open `https://<host>/tokens` and sign in with your company Google account.
2. Name the token, pick an expiry (30, 90 or 180 days; 90 by default), and create it.
3. Copy it right away. It is shown once.

A token acts as you, with your role and stores, and stops working as soon as it expires, you revoke it on the same page, or you are removed from the policy. Admins see and can revoke everyone's tokens there. Prefer OAuth where the app supports it.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST /mcp` | MCP Streamable HTTP. Requires `Authorization: Bearer` (OAuth access token or personal access token). |
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728 resource metadata |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 server metadata |
| `GET /authorize` | Authorization code + PKCE S256 |
| `POST /token` | Code exchange and refresh (refresh tokens rotate) |
| `POST /register` | Dynamic Client Registration (RFC 7591) |
| `GET /oauth/google/callback` | Google sign-in return; shows the consent screen |
| `POST /consent` | Approve or deny on the consent screen |
| `GET`, `POST /tokens` | Personal access token page |
| `GET`, `POST /stores` | Per-user mode: connect, reconnect, or disconnect each store with your Shopify account |
| `GET`, `POST /shopify/connect` | Per-user mode: `GET ?store=<alias>` shows a confirm button; the CSRF-protected same-origin `POST` starts Shopify's online (per-user) authorization for that store |
| `GET /shopify/callback` | Per-user mode: Shopify's return; verifies the HMAC (Shopify's escaping rules, timestamp at most 300 seconds old) and state, stores the encrypted token |
| `GET /healthz` | Health check |

Client ID Metadata Documents are supported: a `client_id` that is an HTTPS URL is fetched and its `redirect_uris` are checked against the redirect policy. Public clients (`token_endpoint_auth_method: none`) and confidential DCR clients (`client_secret_post`, `client_secret_basic`) are both supported.

### Redirect URIs

The built-in list is in `src/hosted/known-clients.ts`, with a comment per entry:

- Claude: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`
- ChatGPT: `https://chatgpt.com/connector_platform_oauth_redirect`
- VS Code: `https://vscode.dev/redirect`, `https://insiders.vscode.dev/redirect`
- Cursor: `cursor://anysphere.cursor-mcp/oauth/callback`
- Loopback on any port and path: `http://localhost`, `http://127.0.0.1`, `http://[::1]` (Claude Code, Codex, Gemini CLI, desktop apps)

`OAUTH_REDIRECT_URIS` adds exact URIs to that list; `OAUTH_REDIRECT_URIS_REPLACE=1` makes it replace the list instead. `OAUTH_ALLOW_ANY_REDIRECT=1` also accepts any `https` redirect or private-use scheme (such as `com.example.app:/cb`) that a client registers. Redirects admitted only that way always show the consent screen, with a warning and the redirect host in large type, and are never remembered. Private-use schemes that are web schemes or look like them (`http`, `https`, `httpx`, `https.evil`, `ws`), or that run code or read local data (`javascript:`, `data:`, `file:`, `blob:` and similar), are always refused, as are redirects with credentials or fragments.

### Consent screen

After Google sign-in the server shows the client name, the client_id, the redirect host, the signed-in email, and the user's role and stores, with Approve and Deny. Deny sends `error=access_denied` back to the app. The form carries a single-use CSRF token and a `__Host-` cookie that bind it to the browser that signed in; both expire after five minutes. Approval is remembered per user, client_id and redirect URI for 30 days. The page has no scripts or external assets and cannot be framed.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MCP_PUBLIC_URL` | yes | | Public origin, for example `https://shopify-mcp.example.com`. No path. |
| `GOOGLE_CLIENT_ID` | yes | | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | yes | | Google OAuth client secret |
| `ALLOWED_EMAIL_DOMAINS` | yes | | Comma list, for example `bariatricpal.com,netrition.com`. Both the `hd` claim and the email domain must be in it. |
| `SHOPIFY_ACCESS_MODE` | no | `per_user` | `per_user`: each person connects stores with their own Shopify account and Shopify enforces their staff permissions. `app`: every call uses the store's app token (the previous behavior). |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | per-user mode | | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored Shopify tokens with AES-256-GCM. The server refuses to start per-user mode without it (or `SHOPIFY_TOKEN_ENCRYPTION_KEYS`). Same as `SHOPIFY_TOKEN_ENCRYPTION_KEYS=default:<key>`. |
| `SHOPIFY_TOKEN_ENCRYPTION_KEYS` | no | | Key rotation: comma list of `id:base64key`, newest first. The first key encrypts; every key decrypts; tokens under an older key are re-encrypted with the first key when used. To rotate, prepend a new key, wait a day (online tokens expire), then drop the old one. Takes precedence over `SHOPIFY_TOKEN_ENCRYPTION_KEY`. |
| `SHOPIFY_APP_CLIENT_ID` | per-user mode | | Client ID of the Shopify app people authorize. A `client_credentials` store's own `auth.clientId` takes precedence. |
| `SHOPIFY_APP_CLIENT_SECRET` | per-user mode | | That app's client secret. `SHOPIFY_CLIENT_SECRET_<ALIAS>` takes precedence for one store. Also verifies Shopify's callback HMAC. |
| `SHOPIFY_APP_SCOPES` | no | full set (`print-scopes --full`) | Comma list of scopes requested at `/shopify/connect` |
| `SHOPIFY_REQUIRE_EMAIL_MATCH` | no | `0` | `1` refuses a Shopify connection whose staff email differs from the Google email. Both are always recorded and shown on `/stores`. |
| `SHOPIFY_MULTI_STORE_POLICY` | app mode | | Path to the policy file (below). Required in app mode; optional in per-user mode, where it adds restrictions. |
| `STORES_JSON` | one of | | Stores config as JSON, same format as `stores.json` |
| `SHOPIFY_MULTI_STORE_CONFIG` | one of | | Path to `stores.json` instead of `STORES_JSON` |
| `SHOPIFY_TOKEN_<ALIAS>` | per store | | Admin API token for an `access_token` store |
| `SHOPIFY_CLIENT_SECRET_<ALIAS>` | per store | | Client secret for a `client_credentials` store |
| `SERVER_DISPLAY_NAME` | no | `Shopify Multi-Store` | Name shown in AI apps (`serverInfo.title`), on the consent and token pages, and in resource metadata |
| `SHOPIFY_MULTI_STORE_DATA_DIR` | no | `./data` (`/data` in Docker) | Holds the OAuth store and audit log |
| `SHOPIFY_MULTI_STORE_OAUTH_STORE` | no | `$DATA_DIR/oauth-store.json` | OAuth clients, codes, approvals, token hashes |
| `SHOPIFY_MULTI_STORE_AUDIT_LOG` | no | `$DATA_DIR/audit.jsonl` | Audit log |
| `PORT` / `HOST` | no | `8080` / `0.0.0.0` | Listen address |
| `OAUTH_REDIRECT_URIS` | no | | Extra exact redirect URIs, added to the built-in known clients |
| `OAUTH_REDIRECT_URIS_REPLACE` | no | `0` | `1` makes `OAUTH_REDIRECT_URIS` replace the built-in list |
| `OAUTH_ALLOW_ANY_REDIRECT` | no | `0` | `1` accepts any `https` or safe private-use-scheme redirect; consent is then always shown for unlisted redirects |
| `OAUTH_ALLOW_LOOPBACK_REDIRECTS` | no | `1` | Allow `http://localhost`, `127.0.0.1`, `[::1]` redirects on any port. Set `0` to turn off. |
| `OAUTH_CIMD_ALLOWED_HOSTS` | no | `*` | Hosts (and subdomains) allowed to serve client metadata documents. `*` allows any HTTPS host. Every fetch, for named hosts too, must resolve to public addresses (private, loopback, link-local, cloud metadata, and reserved ranges are refused at connect time), follows no redirects, stops at 16 KB, and times out after 5 seconds. |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | no | `3600` | Access token lifetime |
| `OAUTH_REFRESH_TOKEN_TTL_SECONDS` | no | `2592000` | Refresh token lifetime (30 days, renewed on each rotation, never past the session maximum age) |
| `OAUTH_SESSION_MAX_AGE_SECONDS` | no | `604800` | Maximum age of a sign-in session (7 days), counted from the Google sign-in. After it, refresh fails with `invalid_grant` and the user signs in with Google again, which re-checks the domain and the policy. |
| `PERSONAL_TOKENS_ENABLED` | no | `1` | `0` turns off `/tokens` and refuses `smsp_` bearer tokens |
| `PERSONAL_TOKEN_MAX_DAYS` | no | `180` | Longest personal access token lifetime a user may choose |
| `PERSONAL_TOKENS_SHOPIFY_ACCESS` | no | `0` | Per-user mode: `1` lets personal access tokens use their owner's Shopify connections, and caps new personal tokens at 30 days. With `0`, personal tokens can sign in but every Shopify call is refused. |

`ACTIONS_DENYLIST` (all modes, stdio too) adds mutations to the list `shopify_run_action` refuses; `ACTIONS_DENYLIST_REPLACE=1` makes it replace the default list. See [ACTIONS.md](ACTIONS.md#denylist).

Secret mounts: for `GOOGLE_CLIENT_SECRET`, `STORES_JSON`, `SHOPIFY_TOKEN_*`, `SHOPIFY_CLIENT_SECRET_*`, `SHOPIFY_APP_CLIENT_SECRET`, `SHOPIFY_TOKEN_ENCRYPTION_KEY`, and `SHOPIFY_TOKEN_ENCRYPTION_KEYS`, you can set `<NAME>_FILE=/run/secrets/...` instead. In serve mode the OS keychain is never used.

### Policy file

In per-user mode the policy file is optional. Without it, anyone from `ALLOWED_EMAIL_DOMAINS` can sign in as an `editor` on every store, and Shopify limits what each person can do; the server logs a warning at startup so this is a deliberate choice. With it, it works as an extra restriction layer exactly as below.

Upgrading: `serve` now defaults to per-user mode. A deployment that should keep shared app tokens must set `SHOPIFY_ACCESS_MODE=app`.

```json
{
  "users": {
    "alex@bariatricpal.com": { "role": "admin", "stores": "*" },
    "ops@netrition.com": { "role": "editor", "stores": ["netrition", "bariatricpal"] }
  },
  "domains": {
    "bariatricpal.com": { "role": "viewer", "stores": ["bariatricpal"] }
  }
}
```

- A `users` entry wins over a `domains` entry. Anyone not matched has no access.
- `viewer`: only tools marked read-only. `editor`: everything except admin-only tools. `admin`: everything. Admin-only tools are `shopify_graphql_mutation` and `shopify_run_action` in app mode; in per-user mode they are open to editors, because Shopify enforces the caller's own permissions.
- `stores` limits which aliases the user can reach. It is checked on every `store`, `stores`, and `alias` argument, and the store list the tools see is filtered, so "all stores" means "all allowed stores".
- Users only see the tools their role can call.
- The file is re-read when it changes. If it becomes invalid, all access is denied until it is fixed.

### Audit log

One JSON line per tool call (`event: "tool_call"`): `timestamp`, `user`, `role`, `tool`, `stores`, `readOnly`, `ok`, `error`, `durationMs`, `argsSha256` (a sha256 of the canonical arguments), and `args`.

`args` never holds free text, so customer data typed into a query or search cannot reach the log:

- A GraphQL document (`query` on the query tools and bulk export, `mutation` on the mutation tool) becomes `{ "graphql": { operations, argumentNames, documentSha256 } }`: each operation's type and root field names, the argument names used, and a sha256 of the text. Literal values such as `query: "email:..."`, aliases, and operation names are dropped.
- `variables` become `[sha256:<hex>]`.
- Numbers and booleans are kept. Strings are kept only when they are Shopify GIDs, store aliases under `store`/`stores`/`alias`, numeric ids under id keys, or enum values under status and sort keys.
- Every other string, including search expressions, becomes `[sha256:<hex>]` of its value, so the same value can still be matched across lines. Customer contact keys (email, phone, address, zip, names) are hashed whatever their type. Values under secret-looking keys become `[REDACTED]`.
- A line is capped at 64 KB. If it would be longer, the arguments are dropped and `truncated: true` is set; `argsSha256` stays.

Auth events are logged to the same file with an `event` field: `sign_in`, `sign_in_denied` (with `reason`), `consent_approved`, `consent_denied`, `token_issued`, `token_refreshed`, `refresh_denied` (reuse, maximum session age, or policy), `personal_token_created`, `personal_token_revoked`, `request_unauthorized` (401), `request_forbidden` (403), and in per-user mode `shopify_connected`, `shopify_connect_denied`, and `shopify_disconnected` (with `store`, and the Shopify `shopifyUserId` and `shopifyEmail` where known).

Every `shopify_run_action` call adds an `action_run` line: `user`, `mutations`, `stores`, `dryRun`, `variablesSha256`, and a per-store `outcome` with the Shopify staff email the store ran as (`shopifyEmail`). In per-user mode every `tool_call` line also carries `shopifyAccounts`, mapping each store the call used to that Shopify staff email. They carry `user` and `clientId` where known. Requests and tool calls made with a personal access token carry its `tokenId`.

Tokens, personal access token values, Shopify tokens, and authorization codes are never logged.

## Setup

### 1. Google OAuth client

In Google Cloud Console for the Workspace:

1. APIs & Services > OAuth consent screen: User type **Internal**.
2. Credentials > Create credentials > OAuth client ID > **Web application**.
3. Authorized redirect URI: `https://<host>/oauth/google/callback`.
4. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### 2. Run the server

```bash
docker build -t shopify-multi-store .
docker run -d --name shopify-mcp -p 8080:8080 \
  -v shopify-mcp-data:/data \
  -e MCP_PUBLIC_URL=https://shopify-mcp.example.com \
  -e GOOGLE_CLIENT_ID=... -e GOOGLE_CLIENT_SECRET=... \
  -e ALLOWED_EMAIL_DOMAINS=bariatricpal.com,netrition.com \
  -e SHOPIFY_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e SHOPIFY_APP_CLIENT_ID=... -e SHOPIFY_APP_CLIENT_SECRET=... \
  -e STORES_JSON='{"stores":[{"alias":"bariatricpal","shop":"bariatricpal.myshopify.com"}]}' \
  shopify-multi-store
```

Generate the encryption key once and keep it. Replacing it outright disconnects everyone; rotate with `SHOPIFY_TOKEN_ENCRYPTION_KEYS` instead. In the Shopify app, add `https://<host>/shopify/callback` as an allowed redirect URL and request the scopes from `node scripts/print-scopes.mjs --full`; see [ACTIONS.md](ACTIONS.md#shopify-admin-setup).

App mode instead (one shared app token per store, policy file required):

```bash
  -e SHOPIFY_ACCESS_MODE=app \
  -v /srv/shopify-mcp/policy.json:/config/policy.json:ro \
  -e SHOPIFY_MULTI_STORE_POLICY=/config/policy.json \
  -e SHOPIFY_TOKEN_BARIATRICPAL=shpat_... \
```

Put it behind a TLS-terminating proxy or platform load balancer so `https://<host>` reaches port 8080. Without Docker: `npm ci && npm run build && shopify-multi-store serve`.

Run one instance. The default file store is for a single process.

### 3. Share the URL

Give people `https://<host>/mcp` (and, in app mode, add them to the policy file). In per-user mode, each person also opens `https://<host>/stores` once a day and connects their stores; tools that need an unconnected store return that link. Each person connects from their own AI app as described in [Connect from your AI app](#connect-from-your-ai-app). No organization-level setup in any AI app is needed. On Claude Team or Enterprise, an Owner can optionally add the connector for everyone under Organization settings > Connectors, leaving the OAuth client fields empty.

## Security model

- Only Google Workspace accounts in `ALLOWED_EMAIL_DOMAINS` can sign in. Consumer Google accounts that use a company email address are rejected because they have no `hd` claim.
- Signing in is not enough: the user must also be in the policy (the policy file, or in per-user mode without one, an allowed domain).
- Per-user mode: Shopify tokens are online (per-user) tokens, so Shopify applies each person's staff permissions. The callback verifies Shopify's HMAC with the app secret, a single-use 10-minute state bound to the `/stores` browser session, and that the shop is a configured store. Offline (app-level) tokens returned by the callback are discarded. Tokens are encrypted with AES-256-GCM, bound to the user, store, and shop, and never leave the server.
- Nothing is issued until the user approves the app on the consent screen, which names the app and where it will return to.
- Every Google sign-in (for an app or for `/tokens`) is bound to the browser that started it by a short-lived `__Secure-` cookie scoped to `/oauth/google/callback`. A callback URL opened in another browser is refused before the Google code is used, so a forwarded sign-in link cannot log someone in as another person.
- Authorization codes are single use, expire after 2 minutes, and require PKCE S256.
- Access tokens are bound to `https://<host>/mcp`. Refresh tokens rotate; reuse of an old refresh token revokes the whole token family.
- A token family lives at most `OAUTH_SESSION_MAX_AGE_SECONDS` (7 days by default) from the Google sign-in, however often it is refreshed. Every refresh also re-checks the policy file, so a removed user cannot refresh.
- Redirect URIs must pass the redirect policy (known client callbacks plus loopback by default), for both registered and metadata-document clients.
- Personal access tokens are stored only as hashes, expire after at most `PERSONAL_TOKEN_MAX_DAYS`, and re-check the policy on every request. They do not expire with the sign-in session, so revoke unused ones.
- Shopify credentials come only from the environment or mounted files. The keychain, Shopify CLI preview stores, and local-file image upload are disabled in serve mode.
- Keep the data directory private. It holds client registrations, token hashes, and encrypted Shopify tokens.

## Limitations

- Single instance only with the file store. Several replicas need a shared `OAuthStore` implementation (not included).
- Remembered consent approvals cannot be cleared from a page; they expire after 30 days. Removing a user from the policy still blocks them at once.
- No rate limiting on the OAuth endpoints. Put the server behind a proxy that limits requests.
- No OAuth token revocation endpoint. Remove the user from the policy to cut access immediately. Personal access tokens are revoked on `/tokens`.
- A client whose OAuth callback is not built in, not configured, and not allowed by `OAUTH_ALLOW_ANY_REDIRECT` is refused at registration. Use a personal access token, or add the callback.
- Local-machine tools are not available: preview store creation and status, and `imageFile` uploads (use `sourceUrl`).
- The audit log is a local file. Ship it to your log system if you need retention.
- Shopify online tokens expire after about 24 hours and cannot be refreshed; people reconnect on `/stores` (one click per store while signed in to Shopify admin, or "Connect all").
