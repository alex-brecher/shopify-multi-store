# Hosted connector

Run this server once for the whole company. Employees use it from Claude (web, Desktop, Cowork, mobile) as an organization custom connector. They sign in with their Google Workspace account. Shopify tokens stay on the server.

## How it works

```
Claude ──HTTPS──> /mcp (Streamable HTTP, bearer token)
   │                 │
   │ OAuth 2.1       ├─ policy: role + store allowlist per user
   ▼                 ├─ audit log (JSON Lines)
/authorize ──> Google sign-in ──> /oauth/google/callback
/token, /register, /.well-known/*
```

- `shopify-multi-store serve` starts one HTTP server. It is the MCP endpoint and its own OAuth 2.1 authorization server.
- Login is delegated to Google. The server checks the id_token signature against Google's keys, plus `iss`, `aud`, `exp`, `nonce`, `email_verified`, and the Workspace `hd` claim.
- The server issues its own opaque access and refresh tokens. Only their SHA-256 hashes are stored.
- Every MCP request is checked against the policy file. Removing a user from the policy blocks them on their next request.
- `shopify-multi-store start` (stdio) is unchanged for local use. No policy applies there.

### Why stateless

The MCP endpoint is stateless: each request builds a new server instance for the caller's role. There are no MCP sessions to lose on restart, auth is checked on every request, and `GET`/`DELETE /mcp` answer `405` (allowed by the spec for servers without session streams). Tool calls are request/response, so nothing needs a long-lived stream.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST /mcp` | MCP Streamable HTTP. Requires `Authorization: Bearer`. |
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728 resource metadata |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 server metadata |
| `GET /authorize` | Authorization code + PKCE S256 |
| `POST /token` | Code exchange and refresh (refresh tokens rotate) |
| `POST /register` | Dynamic Client Registration (RFC 7591) |
| `GET /oauth/google/callback` | Google sign-in return |
| `GET /healthz` | Health check |

Client ID Metadata Documents are supported: a `client_id` that is an HTTPS URL is fetched and its `redirect_uris` are checked against the allowlist.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MCP_PUBLIC_URL` | yes | | Public origin, for example `https://shopify-mcp.example.com`. No path. |
| `GOOGLE_CLIENT_ID` | yes | | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | yes | | Google OAuth client secret |
| `ALLOWED_EMAIL_DOMAINS` | yes | | Comma list, for example `bariatricpal.com,netrition.com`. Both the `hd` claim and the email domain must be in it. |
| `SHOPIFY_MULTI_STORE_POLICY` | yes | | Path to the policy file (below) |
| `STORES_JSON` | one of | | Stores config as JSON, same format as `stores.json` |
| `SHOPIFY_MULTI_STORE_CONFIG` | one of | | Path to `stores.json` instead of `STORES_JSON` |
| `SHOPIFY_TOKEN_<ALIAS>` | per store | | Admin API token for an `access_token` store |
| `SHOPIFY_CLIENT_SECRET_<ALIAS>` | per store | | Client secret for a `client_credentials` store |
| `SHOPIFY_MULTI_STORE_DATA_DIR` | no | `./data` (`/data` in Docker) | Holds the OAuth store and audit log |
| `SHOPIFY_MULTI_STORE_OAUTH_STORE` | no | `$DATA_DIR/oauth-store.json` | OAuth clients, codes, token hashes |
| `SHOPIFY_MULTI_STORE_AUDIT_LOG` | no | `$DATA_DIR/audit.jsonl` | Audit log |
| `PORT` / `HOST` | no | `8080` / `0.0.0.0` | Listen address |
| `OAUTH_REDIRECT_URIS` | no | `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback` | Allowed client redirect URIs |
| `OAUTH_ALLOW_LOOPBACK_REDIRECTS` | no | `1` | Also allow `http://localhost`, `127.0.0.1`, `[::1]` redirects (Claude Code and Desktop testing). Set `0` to turn off. |
| `OAUTH_CIMD_ALLOWED_HOSTS` | no | `claude.ai,claude.com` | Hosts (and subdomains) allowed to serve client metadata documents. `*` allows any HTTPS host; a host admitted only by `*` must resolve to public addresses (private, loopback, link-local, cloud metadata, and reserved ranges are refused, checked at connect time). Redirects are never followed. |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | no | `3600` | Access token lifetime |
| `OAUTH_REFRESH_TOKEN_TTL_SECONDS` | no | `2592000` | Refresh token lifetime (30 days, renewed on each rotation, never past the session maximum age) |
| `OAUTH_SESSION_MAX_AGE_SECONDS` | no | `604800` | Maximum age of a sign-in session (7 days), counted from the Google sign-in. After it, refresh fails with `invalid_grant` and the user signs in with Google again, which re-checks the domain and the policy. |

Secret mounts: for `GOOGLE_CLIENT_SECRET`, `STORES_JSON`, `SHOPIFY_TOKEN_*`, and `SHOPIFY_CLIENT_SECRET_*`, you can set `<NAME>_FILE=/run/secrets/...` instead. In serve mode the OS keychain is never used.

### Policy file

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
- `viewer`: only tools marked read-only. `editor`: everything except admin-only tools (`shopify_graphql_mutation`). `admin`: everything.
- `stores` limits which aliases the user can reach. It is checked on every `store`, `stores`, and `alias` argument, and the store list the tools see is filtered, so "all stores" means "all allowed stores".
- Users only see the tools their role can call.
- The file is re-read when it changes. If it becomes invalid, all access is denied until it is fixed.

### Audit log

One JSON line per tool call (`event: "tool_call"`): `timestamp`, `user`, `role`, `tool`, `stores`, `readOnly`, `ok`, `error`, `durationMs`, and `argsSha256` (a sha256 of the canonical arguments).

- Read-only calls also record the first 2,000 characters of a `query` argument, and nothing else from the arguments.
- Other calls record the arguments. Values under secret-looking keys become `[REDACTED]`. Customer email, phone, and address fields become `[PII sha256:<hex>]`, so the same value can still be matched across lines. Every string is capped at 2,000 characters.
- A line is capped at 64 KB. If it would be longer, the arguments are dropped and `truncated: true` is set; `argsSha256` stays.

Auth events are logged to the same file with an `event` field: `sign_in`, `sign_in_denied` (with `reason`), `token_issued`, `token_refreshed`, `refresh_denied` (reuse, maximum session age, or policy), `request_unauthorized` (401), and `request_forbidden` (403). They carry `user` and `clientId` where known.

Tokens and authorization codes are never logged.

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
  -v /srv/shopify-mcp/policy.json:/config/policy.json:ro \
  -e MCP_PUBLIC_URL=https://shopify-mcp.example.com \
  -e GOOGLE_CLIENT_ID=... -e GOOGLE_CLIENT_SECRET=... \
  -e ALLOWED_EMAIL_DOMAINS=bariatricpal.com,netrition.com \
  -e SHOPIFY_MULTI_STORE_POLICY=/config/policy.json \
  -e STORES_JSON='{"stores":[{"alias":"bariatricpal","shop":"bariatricpal.myshopify.com"}]}' \
  -e SHOPIFY_TOKEN_BARIATRICPAL=shpat_... \
  shopify-multi-store
```

Put it behind a TLS-terminating proxy or platform load balancer so `https://<host>` reaches port 8080. Without Docker: `npm ci && npm run build && shopify-multi-store serve`.

Run one instance. The default file store is for a single process.

### 3. Add the connector in Claude (organization Owner)

1. Organization settings > Connectors > **Add custom connector**.
2. Name it (for example "Shopify") and paste `https://<host>/mcp`.
3. Leave the OAuth client fields empty. Claude registers itself.

### 4. Employees connect

1. In Claude, open Settings > Connectors (or the connectors menu in a chat) and click **Connect** on the Shopify connector.
2. Sign in with the company Google account.
3. Done. The connector works in web, Desktop, Cowork, and mobile.

For Claude Code testing: `claude mcp add --transport http shopify https://<host>/mcp`.

## Security model

- Only Google Workspace accounts in `ALLOWED_EMAIL_DOMAINS` can sign in. Consumer Google accounts that use a company email address are rejected because they have no `hd` claim.
- Signing in is not enough: the user must also be in the policy file.
- Authorization codes are single use, expire after 2 minutes, and require PKCE S256.
- Access tokens are bound to `https://<host>/mcp`. Refresh tokens rotate; reuse of an old refresh token revokes the whole token family.
- A token family lives at most `OAUTH_SESSION_MAX_AGE_SECONDS` (7 days by default) from the Google sign-in, however often it is refreshed. Every refresh also re-checks the policy file, so a removed user cannot refresh.
- Redirect URIs must be in the allowlist (Claude callbacks plus loopback by default), for both registered and metadata-document clients.
- Shopify credentials come only from the environment or mounted files. The keychain, Shopify CLI preview stores, and local-file image upload are disabled in serve mode.
- Keep the data directory private. It holds client registrations and token hashes.

## Limitations

- Single instance only with the file store. Several replicas need a shared `OAuthStore` implementation (not included).
- No consent screen: after Google sign-in the code goes straight back to the registered redirect URI.
- No rate limiting on the OAuth endpoints. Put the server behind a proxy that limits requests.
- No token revocation endpoint. Remove the user from the policy to cut access immediately.
- Local-machine tools are not available: preview store creation and status, and `imageFile` uploads (use `sourceUrl`).
- The audit log is a local file. Ship it to your log system if you need retention.
