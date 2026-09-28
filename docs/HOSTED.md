# Hosted connector

The default way to run this server is local: `shopify-multi-store start` on your own computer, over stdio, with your own store credentials. Nothing in this document changes that.

Hosting is optional. Whoever wants a shared server runs one themselves, and their team then uses it from whatever AI app they already have: Claude, ChatGPT, Codex, Claude Code, Cursor, VS Code, Gemini CLI, Windsurf, or any other MCP client that supports remote servers over Streamable HTTP. Nothing depends on a particular vendor or plan.

Two ways to host:

- Cloudflare Workers, with a Deploy to Cloudflare button. See [DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md).
- Any server that runs Node or Docker: `shopify-multi-store serve`, described below.

Sign-in is Shopify login only. People sign in with their own Shopify staff account, and every tool call runs with that person's own Shopify online token. Shopify permissions are the only rule: what someone can do in a store is exactly what their staff account there allows. There are no roles, no policy file, and no second permission system on the server. Shopify tokens never leave the server. See [ACTIONS.md](ACTIONS.md) for the generic action tools.

## How it works

```
AI app ──HTTPS──> /mcp (Streamable HTTP, bearer token)
   │                 │
   │ OAuth 2.1       ├─ the caller's own Shopify online token per store
   │                 ├─ audit log
   ▼
/authorize ──> Sign in with Shopify ──> Shopify staff login ──> /shopify/callback ──> consent screen ──> code back to the app
/token, /register, /.well-known/*
/stores ──> Reconnect all ──> Shopify (one store after another) ──> /shopify/callback
```

- `shopify-multi-store serve` (or the Worker) is one HTTP service. It is the MCP endpoint and its own OAuth 2.1 authorization server.
- Login is Shopify's own OAuth, in online (per-user) access mode, on one of the configured stores (the "identity store"). The person picks the store on a small chooser page; with one configured store the chooser is skipped.
- The server keeps the verified Shopify staff identity from the token's `associated_user`: the email must be present and `email_verified` must be true. The identity is that email, lower-cased. The online token from the login is also stored as that person's connection to the identity store, so it works right away.
- After sign-in, a consent screen shows which app is asking, where it will return to, and who is signed in. Nothing is issued until the person approves.
- The server issues its own opaque access and refresh tokens. Only their SHA-256 hashes are stored.
- Every Shopify call uses the caller's own online token for that store. A store the caller has not connected, or whose token expired, returns an error with one reconnect link. There is never a fallback to a shared app token or a static Admin API token.
- `shopify-multi-store start` (stdio) is unchanged for local use.

### Why stateless

The MCP endpoint is stateless: each request builds a new server instance for the caller. There are no MCP sessions to lose on restart, auth is checked on every request, and `GET`/`DELETE /mcp` answer `405` (allowed by the spec for servers without session streams). Tool calls are request/response, so nothing needs a long-lived stream.

## Signing in and reconnecting

Shopify online tokens are per user and per store. Shopify ends each one after 24 hours, or earlier when the person logs out of the Shopify admin (see Shopify's documentation on online access tokens). They cannot be refreshed. So:

- Reconnecting is needed at most once a day, and it is one click for all stores: **Reconnect all** on `https://<host>/stores`.
- Reconnect all goes through every expired or unconnected store in a row. While the person is logged in to the Shopify admin, each hop is an automatic redirect with no clicks.
- When a tool needs a store whose connection expired (or was never made), the error carries one link, `https://<host>/stores/reconnect`. Opened while signed out, it signs in with Shopify and then reconnects every store with no further clicks; opened while signed in, it shows the stores page with the Reconnect all button.
- Each store must be connected with the same verified Shopify email the person signed in with. If someone's staff email differs between stores, they cannot connect the store where it differs.
- If the person is not staff on a store, Shopify shows its own error for that store and the chain stops there. The other stores stay as they are; the stores page connects each one on its own too.

## Connect from your AI app

You need one thing from whoever runs the server: the MCP URL, `https://<host>/mcp`. Most apps then sign you in with OAuth: a browser opens, you click Sign in with Shopify and log in with your staff account (or type the name of a store you do have a login for), and you approve the app on the consent screen. You approve the app each time you connect it; once connected, the app stays signed in through refresh tokens.

Menu names and config formats below belong to each vendor and change often. Treat them as a guide and check the vendor's current docs if something has moved.

### Claude (web, Desktop, mobile)

1. Settings > Connectors > Add custom connector.
2. Name it (for example "Shopify") and paste `https://<host>/mcp`. Leave the OAuth client ID and secret empty.
3. Click Connect, sign in with Shopify, and approve.

This works as a personal custom connector on any Claude plan, within the connector limits Anthropic sets for each plan. On Team and Enterprise plans an organization Owner can optionally add it once for everyone under Organization settings > Connectors; members still sign in and approve for themselves.

### ChatGPT

1. Settings > Apps > Advanced settings: turn on developer mode. On a company workspace an admin may need to allow it first.
2. Apps > Create. Paste `https://<host>/mcp` as the MCP server URL and choose OAuth. Leave the other OAuth settings at their defaults; you do not need to pick DCR.
3. Click Scan Tools, sign in with Shopify, approve, then click Create.

ChatGPT registers itself with a Client ID Metadata Document. It works on the ChatGPT website, not the phone app.

Which ChatGPT plans can add custom MCP servers, and whether they can write or only read, is set per OpenAI's current terms.

### Codex (CLI and IDE extension)

In `~/.codex/config.toml`:

```toml
[mcp_servers.shopify]
url = "https://<host>/mcp"
```

Then run `codex mcp login shopify` and finish sign-in in the browser. This needs loopback redirects allowed on the server (`OAUTH_ALLOW_LOOPBACK_REDIRECTS=1`, the default). Not yet verified end to end against a live deployment.

### Claude Code

```bash
claude mcp add --transport http shopify https://<host>/mcp
```

Run `/mcp` in Claude Code and choose the server to sign in.

### Cursor

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "shopify": { "url": "https://<host>/mcp" }
  }
}
```

Cursor prompts you to sign in when the server first connects.

### VS Code

In `.vscode/mcp.json` (or your user MCP configuration):

```json
{
  "servers": {
    "shopify": { "type": "http", "url": "https://<host>/mcp" }
  }
}
```

Start the server from the MCP view and allow the sign-in.

### Gemini CLI

In `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "shopify": { "httpUrl": "https://<host>/mcp" }
  }
}
```

Run `/mcp auth shopify` to sign in.

### Windsurf and other clients

Any client that supports remote MCP servers over Streamable HTTP and OAuth can connect: give it `https://<host>/mcp`. It discovers the rest from `/.well-known/oauth-protected-resource`, registers itself (Dynamic Client Registration or a Client ID Metadata Document), and opens the sign-in page.

For Windsurf, add the URL to its MCP config (`serverUrl`). If your version cannot finish OAuth against this server, run it through a loopback OAuth bridge such as `mcp-remote`. If a client's OAuth callback is refused, ask the operator to add it with `OAUTH_REDIRECT_URIS`.

Personal access tokens were removed: every supported client signs in with OAuth, and a long-lived bearer secret cannot carry a person's Shopify permissions safely.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST /mcp` | MCP Streamable HTTP. Requires `Authorization: Bearer` with an OAuth access token. |
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728 resource metadata |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 server metadata |
| `GET /authorize` | Authorization code + PKCE S256. Shows the Sign in with Shopify page (or goes straight to Shopify with one store). |
| `POST /login/shopify` | Sign in with Shopify, or the store name typed on the sign-in page; needs the sign-in's browser binding cookie |
| `POST /token` | Code exchange and refresh (refresh tokens rotate) |
| `POST /register` | Dynamic Client Registration (RFC 7591) |
| `POST /consent` | Approve or deny on the consent screen |
| `GET`, `POST /stores` | Your stores: Reconnect all, connect, reconnect or disconnect one store, sign out |
| `GET /stores/reconnect` | The one link tool errors return: signs in if needed, then reconnects every expired or unconnected store |
| `GET`, `POST /shopify/connect` | `GET ?store=<alias>` shows a confirm button; the CSRF-protected same-origin `POST` starts Shopify's online (per-user) authorization for that store |
| `GET /shopify/callback` | Shopify's return for sign-in and store connections; verifies the HMAC (Shopify's escaping rules, timestamp at most 300 seconds old) and the state, stores the encrypted token |
| `GET /healthz` | Health check |

Client ID Metadata Documents are supported: a `client_id` that is an HTTPS URL is fetched and its `redirect_uris` are checked against the redirect policy. A metadata document is accepted as a public client when it allows `none` in `token_endpoint_auth_method` or in `token_endpoint_auth_methods_supported` (ChatGPT names `private_key_jwt` in the first and lists `none` in the second); a document that allows only other methods is refused. Public clients and confidential DCR clients (`client_secret_post`, `client_secret_basic`) are both supported.

### Redirect URIs

The built-in list is in `src/hosted/known-clients.ts`, with a comment per entry:

- Claude: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`
- ChatGPT: `https://chatgpt.com/connector_platform_oauth_redirect`
- VS Code: `https://vscode.dev/redirect`, `https://insiders.vscode.dev/redirect`
- Cursor: `cursor://anysphere.cursor-mcp/oauth/callback`
- Loopback on any port and path: `http://localhost`, `http://127.0.0.1`, `http://[::1]` (Claude Code, Codex, Gemini CLI, desktop apps)

`OAUTH_REDIRECT_URIS` adds exact URIs to that list; `OAUTH_REDIRECT_URIS_REPLACE=1` makes it replace the list instead. `OAUTH_ALLOW_ANY_REDIRECT=1` also accepts any `https` redirect or private-use scheme (such as `com.example.app:/cb`) that a client registers. Redirects admitted only that way always show the consent screen, with a warning and the redirect host in large type. Private-use schemes that are web schemes or look like them (`http`, `https`, `httpx`, `https.evil`, `ws`), or that run code or read local data (`javascript:`, `data:`, `file:`, `blob:` and similar), are always refused, as are redirects with credentials or fragments.

### Consent screen

After the Shopify login the server shows the client name, the client_id, the redirect host, and the signed-in Shopify email with the store used to sign in, with Approve and Deny. Deny sends `error=access_denied` back to the app. The form carries a single-use CSRF token and a `__Host-` cookie that bind it to the browser that signed in; both expire after five minutes. The screen appears on every sign-in, even for an app approved before: Claude did not complete sign-ins whose code arrived by a direct redirect at the end of the Shopify login (2.0.2). The page has no scripts or external assets and cannot be framed.

## Configuration

These settings apply to `shopify-multi-store serve`. The Worker uses the same names; see [DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md).

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MCP_PUBLIC_URL` | yes | | Public origin, for example `https://shopify-mcp.example.com`. No path. |
| `SHOPIFY_APP_CLIENT_ID` | yes | | Client ID of the Shopify app people sign in with and authorize. A `client_credentials` store's own `auth.clientId` takes precedence for that store. |
| `SHOPIFY_APP_CLIENT_SECRET` | yes | | That app's client secret. `SHOPIFY_CLIENT_SECRET_<ALIAS>` takes precedence for one store. Also verifies Shopify's callback HMAC. |
| `SHOPIFY_CLIENT_ID_<ALIAS>` | no | | Client ID of a separate app for one store. Needed for a store in another Shopify organization, because a custom app installs only in its own organization. Pair it with `SHOPIFY_CLIENT_SECRET_<ALIAS>`. The app needs the same redirect URL and scopes. |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | yes (or the next) | | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored Shopify tokens with AES-256-GCM. The server refuses to start without it (or `SHOPIFY_TOKEN_ENCRYPTION_KEYS`). Same as `SHOPIFY_TOKEN_ENCRYPTION_KEYS=default:<key>`. |
| `SHOPIFY_TOKEN_ENCRYPTION_KEYS` | no | | Key rotation: comma list of `id:base64key`, newest first. The first key encrypts; every key decrypts; tokens under an older key are re-encrypted with the first key when used. To rotate, prepend a new key, wait a day (online tokens expire), then drop the old one. Takes precedence over `SHOPIFY_TOKEN_ENCRYPTION_KEY`. |
| `STORES_JSON` | one of | | The stores this server serves, as JSON in the `stores.json` format. Store entries need only `alias` and `shop`. |
| `SHOPIFY_MULTI_STORE_CONFIG` | one of | | Path to `stores.json` instead of `STORES_JSON` |
| `SHOPIFY_IDENTITY_STORE` | no | first store | Alias of the store listed first (preselected) on the sign-in chooser |
| `SHOPIFY_APP_SCOPES` | no | full set (`print-scopes --full`) | Comma list of scopes requested at sign-in and when connecting a store |
| `SERVER_DISPLAY_NAME` | no | `Shopify Multi-Store` | Name shown in AI apps (`serverInfo.title`), on the sign-in, consent and stores pages, and in resource metadata |
| `SHOPIFY_MULTI_STORE_DATA_DIR` | no | `./data` (`/data` in Docker) | Holds the OAuth store and audit log |
| `SHOPIFY_MULTI_STORE_OAUTH_STORE` | no | `$DATA_DIR/oauth-store.json` | OAuth clients, codes, approvals, token hashes, encrypted Shopify tokens |
| `SHOPIFY_MULTI_STORE_AUDIT_LOG` | no | `$DATA_DIR/audit.jsonl` | Audit log |
| `PORT` / `HOST` | no | `8080` / `0.0.0.0` | Listen address |
| `OAUTH_REDIRECT_URIS` | no | | Extra exact redirect URIs, added to the built-in known clients |
| `OAUTH_REDIRECT_URIS_REPLACE` | no | `0` | `1` makes `OAUTH_REDIRECT_URIS` replace the built-in list |
| `OAUTH_ALLOW_ANY_REDIRECT` | no | `0` | `1` accepts any `https` or safe private-use-scheme redirect; consent is then always shown for unlisted redirects |
| `OAUTH_ALLOW_LOOPBACK_REDIRECTS` | no | `1` | Allow `http://localhost`, `127.0.0.1`, `[::1]` redirects on any port. Keep `1` if anyone signs in from Codex, Claude Code, Gemini CLI or a desktop app: they all receive the OAuth code on a loopback redirect (Codex uses `http://127.0.0.1:<port>/callback/<id>`). Loopback redirects are the standard native-app pattern (RFC 8252) and are safe here because PKCE S256, Shopify sign-in and the consent screen still apply. Setting `0` breaks `codex mcp login` and `claude mcp` sign-in. |
| `OAUTH_CIMD_ALLOWED_HOSTS` | no | `*` | Hosts (and subdomains) allowed to serve client metadata documents. `*` allows any HTTPS host. Every fetch, for named hosts too, must reach only public addresses (private, loopback, link-local, cloud metadata, and reserved ranges are refused), follows no redirects, stops at 16 KB, and times out after 5 seconds. |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | no | `3600` | Access token lifetime |
| `OAUTH_REFRESH_TOKEN_TTL_SECONDS` | no | `2592000` | Refresh token lifetime (30 days, renewed on each rotation, never past the session maximum age) |
| `OAUTH_SESSION_MAX_AGE_SECONDS` | no | `604800` | Maximum age of a sign-in session (7 days), counted from the Shopify sign-in. After it, refresh fails with `invalid_grant` and the person signs in with Shopify again, which proves again that they are staff on a configured store. |
| `OAUTH_CLIENT_IDLE_TTL_SECONDS` | no | `2592000` | A dynamically registered client that is not used for this long (30 days) is deleted; each use pushes the expiry back (at most one write a day). Its app registers again on the next sign-in. Clients registered before this setting existed get the expiry on their next use. Client ID Metadata Document clients are never stored. |
| `OAUTH_MAX_REGISTRATIONS_PER_SOURCE_PER_HOUR` | no | `30` | Dynamic client registrations allowed from one address per clock hour (`429` with `Retry-After` after that); `0` turns the limit off. The address is the TCP peer on Node (a reverse proxy's address when behind one, so the limit then applies to the proxy as a whole) and `CF-Connecting-IP` on Cloudflare Workers. The server also stops registering at 10,000 stored clients, counted from a maintained counter rather than by listing clients. |

`ACTIONS_DENYLIST` (stdio too) adds mutations to the list `shopify_run_action` refuses; `ACTIONS_DENYLIST_REPLACE=1` makes it replace the default list. See [ACTIONS.md](ACTIONS.md#denylist).

Secret mounts: for `STORES_JSON`, `SHOPIFY_CLIENT_SECRET_*`, `SHOPIFY_APP_CLIENT_SECRET`, `SHOPIFY_TOKEN_ENCRYPTION_KEY`, and `SHOPIFY_TOKEN_ENCRYPTION_KEYS`, you can set `<NAME>_FILE=/run/secrets/...` instead. A hosted server never reads the OS keychain and never uses a static Admin API token (`SHOPIFY_TOKEN_<ALIAS>`) or client-credentials token, even if one is set.

The list of stores is the only store configuration a hosted server needs. There is no allowlist of users: anyone who is staff on a configured store can sign in, and Shopify decides what they can do in each store.

### Audit log

One JSON line per tool call (`event: "tool_call"`): `timestamp`, `user`, `tool`, `stores`, `readOnly`, `ok`, `error`, `durationMs`, `shopifyAccounts` (each store the call used, with the Shopify staff email it ran as), `argsSha256` (a sha256 of the canonical arguments), and `args`.

`args` never holds free text, so customer data typed into a query or search cannot reach the log:

- A GraphQL document (`query` on the query tools and bulk export, `mutation` on the mutation tool) becomes `{ "graphql": { operations, argumentNames, documentSha256 } }`: each operation's type and root field names, the argument names used, and a sha256 of the text. Literal values such as `query: "email:..."`, aliases, and operation names are dropped.
- `variables` become `[sha256:<hex>]`.
- Numbers and booleans are kept. Strings are kept only when they are Shopify GIDs, store aliases under `store`/`stores`/`alias`, numeric ids under id keys, or enum values under status and sort keys.
- Every other string, including search expressions, becomes `[sha256:<hex>]` of its value, so the same value can still be matched across lines. Customer contact keys (email, phone, address, zip, names) are hashed whatever their type. Values under secret-looking keys become `[REDACTED]`.
- `error` (failed calls only) never holds the error message, since Shopify messages and HTTP bodies can quote customer data back. It is `{ class, exception?, httpStatus?, codes?, fields?, messageSha256 }`: a class (`access_denied`, `http_error`, `throttled`, `timeout`, `graphql_errors`, `user_errors`, `exception`, or `tool_error`), the thrown error's name, the HTTP status, Shopify error codes such as `ACCESS_DENIED` or `THROTTLED`, `userErrors` field paths such as `input.email`, and a sha256 of the full message.
- A line is capped at 64 KB. If it would be longer, the arguments are dropped and `truncated: true` is set; `argsSha256` stays.

Auth events are logged the same way with an `event` field: `sign_in`, `sign_in_denied` (with `reason`), `consent_approved`, `consent_denied`, `token_issued`, `token_refreshed`, `refresh_denied` (reuse or maximum session age), `request_unauthorized` (401), and `shopify_connected`, `shopify_connect_denied`, and `shopify_disconnected` (with `store`, and the Shopify `shopifyUserId` and `shopifyEmail` where known). They carry `user` and `clientId` where known.

Every `shopify_run_action` call adds an `action_run` line: `user`, `mutations`, `stores`, `dryRun`, `variablesSha256`, and a per-store `outcome` with the Shopify staff email the store ran as (`shopifyEmail`). A failed store's `error` has the same structured shape as a tool call's (never the message text), with classes such as `preflight`, `refused`, `dry_run_problems`, `not_run`, or the store's outcome (`rejected`, `partial`, `unknown`, `failed`, `throttled`).

Tokens, Shopify tokens, and authorization codes are never logged.

## Setup on any server

### 1. Shopify app

Create one app in the Shopify Dev Dashboard (or use an existing custom app) and install it on every store the server should serve:

1. Allowed redirection URL: `https://<host>/shopify/callback`. This one URL serves both sign-in and store connections.
2. Scopes: the output of `node scripts/print-scopes.mjs --full` (or a smaller set in `SHOPIFY_APP_SCOPES`). See [ACTIONS.md](ACTIONS.md#shopify-admin-setup).
3. Install the app on each store. Copy the client ID and secret into `SHOPIFY_APP_CLIENT_ID` and `SHOPIFY_APP_CLIENT_SECRET`.

### 2. Run the server

```bash
docker build -t shopify-multi-store .
docker run -d --name shopify-mcp -p 8080:8080 \
  -v shopify-mcp-data:/data \
  -e MCP_PUBLIC_URL=https://shopify-mcp.example.com \
  -e SHOPIFY_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e SHOPIFY_APP_CLIENT_ID=... -e SHOPIFY_APP_CLIENT_SECRET=... \
  -e STORES_JSON='{"stores":[{"alias":"bariatricpal","shop":"bariatricpal.myshopify.com"}]}' \
  shopify-multi-store
```

Generate the encryption key once and keep it. Replacing it outright disconnects everyone; rotate with `SHOPIFY_TOKEN_ENCRYPTION_KEYS` instead.

Put it behind a TLS-terminating proxy or platform load balancer so `https://<host>` reaches port 8080. Without Docker: `npm ci && npm run build && shopify-multi-store serve`.

Run one instance. The default file store is for a single process. (The Cloudflare Worker keeps the same state in a Durable Object instead.)

### 3. Share the URL

Give people `https://<host>/mcp`. Each person connects from their own AI app as described in [Connect from your AI app](#connect-from-your-ai-app), and reconnects their stores once a day with one click (see [Signing in and reconnecting](#signing-in-and-reconnecting)). No organization-level setup in any AI app is needed. On Claude Team or Enterprise, an Owner can optionally add the connector for everyone under Organization settings > Connectors, leaving the OAuth client fields empty.

## Cutting off earlier credentials

Moving a team to the hosted server does not by itself revoke anything issued before. Earlier local installs (`shopify-multi-store start`) authenticate with either:

- a static Admin API access token (`shpat_...`) for each store, from a custom app created in the store admin or an app installed from the Dev Dashboard; or
- client credentials (the client ID and secret) of a shared app, which mint a store token on demand.

Those installs keep working, with the app's full scopes and no per-person permissions, until their tokens are revoked. To make per-user Shopify login the only way in, an operator does the following. Nothing here is automated, and the server never does it for you.

1. List what exists. For each store, open Settings > Apps and sales channels and note every app used for this connector: the shared Dev Dashboard app, and any custom app created in the store admin (Develop apps) that issued an `shpat_` token.
2. Rotate the shared app's client secret in the Dev Dashboard (the app's settings, client credentials). If the dashboard keeps the old secret active for a grace period, revoke the old secret as soon as the new one is in place. From then on, nobody can mint new client-credentials tokens with the old secret.
3. Put the new secret on the hosted server right away: `SHOPIFY_APP_CLIENT_SECRET` (on Cloudflare: `npx wrangler secret put SHOPIFY_APP_CLIENT_SECRET`). Until then, sign-in and store connections fail, because the secret also verifies Shopify's callbacks.
4. Revoke the static tokens. Uninstall the shared app from each store, then install it again and approve its scopes. Uninstalling revokes every token the app holds for that store: static offline tokens, client-credentials tokens that were minted before the rotation (they would otherwise live up to 24 hours), and the hosted server's own online tokens. For a custom app created in a store's admin, uninstall or delete that app; that revokes its `shpat_` token.
5. Tell people to reconnect: one click on `https://<host>/stores` (**Reconnect all**), or they will get the reconnect link from their next tool call.
6. Check it: an old local install now gets `401` or `403` from Shopify for those stores (`shopify-multi-store doctor` shows the failure).

After this, the only credentials that work are Shopify online tokens that each person obtains by signing in with their own staff account, and Shopify permissions are the only rule. Do not issue new static tokens or share the client secret if you want to keep it that way. Removing someone's staff account in Shopify then cuts them off everywhere.

## Security model

- Only Shopify staff of a configured store can sign in. The identity is the `associated_user` email of a Shopify online token, which must be verified (`email_verified: true`). Offline (app-level) tokens are discarded.
- Shopify permissions are the only access rule. Every call uses the caller's own online token; Shopify applies that person's staff permissions. There is no fallback to an app token or a static token.
- Each store connection must carry the same verified email as the sign-in, so nobody can act through someone else's staff account.
- The Shopify callback verifies Shopify's HMAC with the app secret and a timestamp at most 300 seconds old, and that the shop is a configured store.
- Every sign-in, whether an app connecting or a page sign-in at `/stores`, is bound to the browser that started it by a short-lived `__Host-` cookie. The sign-in page and the Shopify callback both check it before the state is used, so a forwarded sign-in link cannot log someone in as another person, and a refused callback does not burn the real sign-in. Store connections use a single-use 10-minute state bound to the `/stores` browser session.
- Nothing is issued until the person approves the app on the consent screen, which names the app and where it will return to.
- Authorization codes are single use, expire after 2 minutes, and require PKCE S256.
- Access tokens are bound to `https://<host>/mcp`. Refresh tokens rotate; reuse of an old refresh token revokes the whole token family.
- A token family lives at most `OAUTH_SESSION_MAX_AGE_SECONDS` (7 days by default) from the Shopify sign-in, however often it is refreshed.
- Redirect URIs must pass the redirect policy (known client callbacks plus loopback by default), for both registered and metadata-document clients.
- Shopify tokens are encrypted with AES-256-GCM, bound to the user, store, and shop, and never leave the server.
- The keychain, Shopify CLI preview stores, and local-file image upload are disabled on a hosted server.
- Keep the data directory private. It holds client registrations, token hashes, and encrypted Shopify tokens.

## Limitations

- Single instance only with the file store. The Cloudflare Worker uses one Durable Object instead, which is strongly consistent.
- Remembered consent approvals cannot be cleared from a page; they expire after 30 days.
- No rate limiting on the OAuth endpoints. Put the server behind a proxy that limits requests.
- No OAuth token revocation endpoint. To cut someone off at once, remove their staff account in Shopify (their online tokens stop working) and wait for their access token (1 hour by default); refresh stops at the session maximum age.
- A client whose OAuth callback is not built in, not configured, and not allowed by `OAUTH_ALLOW_ANY_REDIRECT` is refused at registration. Add the callback.
- Local-machine tools are not available: preview store creation and status, and `imageFile` uploads (use `sourceUrl`).
- The audit log is a local file on `serve`. Ship it to your log system if you need retention.
- Shopify online tokens expire after 24 hours (or when the person logs out of the Shopify admin) and cannot be refreshed; people reconnect with one click (see above).
