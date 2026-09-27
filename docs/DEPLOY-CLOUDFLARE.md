# Deploy to Cloudflare Workers

This runs the hosted connector ([HOSTED.md](HOSTED.md)) as a Cloudflare Worker that you own. It is optional: the default is still local use on your own computer, and `shopify-multi-store serve` runs the same connector on any server that has Node or Docker.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alex-brecher/shopify-multi-store)

What you get: one Worker with the MCP endpoint at `https://<worker-host>/mcp`, sign-in with Shopify, a Durable Object that holds the OAuth state (strongly consistent, so authorization codes stay single use and refresh token reuse is caught), and a D1 database for the audit log. Every person uses their own Shopify staff account, and Shopify decides what they can do.

`<worker-host>` below is the Worker's host name: `shopify-multi-store-mcp.<your-subdomain>.workers.dev` by default, or a custom domain you add later.

## 1. Create the Shopify app

One app serves every store.

1. Open the Shopify Dev Dashboard (dev.shopify.com) and create an app, for example "Shopify Multi-Store MCP".
2. In the app's version settings:
   - App URL: `https://<worker-host>/`
   - Allowed redirection URL: `https://<worker-host>/shopify/callback`. This one URL serves both sign-in and store connections.
   - Access scopes: the full list from `node scripts/print-scopes.mjs --full` (in a clone of this repository, after `npm ci && npm run build`). Remove any scope your app is not approved for; see [ACTIONS.md](ACTIONS.md#shopify-admin-setup).
3. Release the version.
4. Install the app on each store the Worker should serve, approving the scopes as the store owner.
5. Copy the app's client ID and client secret from its settings.

If you do not know the Worker's host yet, deploy first (step 2), then come back and set the two URLs, and release the version again.

## 2. Deploy the Worker

### With the button

1. Click **Deploy to Cloudflare** above and sign in to Cloudflare.
2. Let it create the repository copy in your GitHub or GitLab account. It also creates the Durable Object and the D1 database (`AUDIT_DB`, named `shopify-multi-store-audit`) from `wrangler.jsonc`; the binding descriptions it shows come from the `cloudflare.bindings` field in `package.json`.
3. When it asks for secrets, enter the four in [Secrets](#secrets).
4. Deploy. Cloudflare shows the Worker's URL.

### With the CLI

```bash
git clone https://github.com/alex-brecher/shopify-multi-store.git
cd shopify-multi-store
npm ci
npx wrangler login
npx wrangler d1 create shopify-multi-store-audit
# Copy the database_id it prints into wrangler.jsonc, in d1_databases next to
# "database_name": "shopify-multi-store-audit".
npx wrangler secret put SHOPIFY_APP_CLIENT_ID
npx wrangler secret put SHOPIFY_APP_CLIENT_SECRET
npx wrangler secret put SHOPIFY_TOKEN_ENCRYPTION_KEYS
npx wrangler secret put STORES_JSON
npx wrangler deploy
```

Create the D1 database yourself as above. The wrangler this repository installs (4.142) would also create it during `wrangler deploy` when `wrangler.jsonc` names a database without a `database_id`, but only through its resource provisioning, which sits behind a hidden `--experimental-provision` flag (on by default in that version), is skipped when the API token cannot list D1 databases, and is missing from older wrangler versions. An explicit `d1 create` and `database_id` works with every version. `npm run worker:check` builds the Worker without deploying it (a dry run) so you can check the bundle first.

### Secrets

Set these as secrets (never as plain vars):

| Secret | Value |
| --- | --- |
| `SHOPIFY_APP_CLIENT_ID` | The Shopify app's client ID |
| `SHOPIFY_APP_CLIENT_SECRET` | The Shopify app's client secret. It also verifies Shopify's callback signature. |
| `SHOPIFY_TOKEN_ENCRYPTION_KEYS` | `k1:` followed by 32 random bytes in base64, for example `k1:$(openssl rand -base64 32)`. Encrypts stored Shopify tokens. Keep it; rotate by prepending a new key (`k2:...,k1:...`), waiting a day, then dropping the old one. |
| `STORES_JSON` | The stores this Worker serves, for example `{"stores":[{"alias":"main","shop":"main-store.myshopify.com"},{"alias":"wholesale","shop":"wholesale-store.myshopify.com"}]}` |

Optional settings go in `wrangler.jsonc` under `vars` (or as secrets): `MCP_PUBLIC_URL` (leave empty to use the host the Worker is reached on; set it when you add a custom domain and want one fixed address), `SERVER_DISPLAY_NAME`, `SHOPIFY_IDENTITY_STORE`, `SHOPIFY_APP_SCOPES`, `ACTIONS_DENYLIST` and `ACTIONS_DENYLIST_REPLACE` (see [ACTIONS.md](ACTIONS.md)), and the `OAUTH_*` settings. They mean the same as in [HOSTED.md](HOSTED.md#configuration). `SHOPIFY_MULTI_STORE_DATA_DIR`, `PORT` and `HOST` do not apply to a Worker.

## 3. Check it

- `https://<worker-host>/healthz` answers `{"ok":true,...}`.
- `https://<worker-host>/stores` shows the sign-in page listing your stores. Pick one and log in with your Shopify staff account; the store shows as connected.

A missing secret or binding answers every request with `500` and `server_misconfigured`, naming what is missing.

## 4. Add it to your AI app

Give each person `https://<worker-host>/mcp`. In Claude: Settings > Connectors > Add custom connector, paste the URL, leave the OAuth fields empty, click Connect, sign in with Shopify, and approve. Other apps are in [Connect from your AI app](HOSTED.md#connect-from-your-ai-app).

Shopify ends each person's store connections after 24 hours, or when they log out of the Shopify admin. Reconnecting is one click for all stores at `https://<worker-host>/stores` (**Reconnect all**); tool errors link to it.

## Moving from local installs

Existing local installs keep working with their static tokens or client credentials until you revoke those. The steps are in [Cutting off earlier credentials](HOSTED.md#cutting-off-earlier-credentials).

## How it is built

- `src/workers/index.ts` is the Worker entry. It builds the same hosted app as `serve`, from the Worker's env.
- `OAuthStoreObject` (a SQLite-backed Durable Object, binding `OAUTH_STORE`) holds OAuth clients, codes, approvals, token hashes and encrypted Shopify tokens. One instance, so every operation is strongly consistent. Workers KV is not used: it is eventually consistent, which would let a code or refresh token be used twice.
- The audit log goes to D1 (binding `AUDIT_DB`, table `audit`, created on first write): one row per event with the same PII-free JSON line `serve` writes to `audit.jsonl`. D1 rather than Workers Logs, because an audit log must be durable and queryable for as long as you choose; Workers Logs keeps only days and may be sampled. If a D1 write fails, the line goes to Workers Logs instead. Query it with `npx wrangler d1 execute shopify-multi-store-audit --remote --command "SELECT ts, event, user, tool, ok FROM audit ORDER BY id DESC LIMIT 50"`.
- One Admin GraphQL schema (the default API version, 2026-07) is bundled, still gzipped, and inflated with `DecompressionStream` the first time a tool needs it. Every guided tool runs on that version. Measured in workerd (Miniflare, `SMS_MEASURE_HEAP=1 node --test tests/workers-miniflare.test.mjs`): the isolate heap is about 17 MB before the first tool call and about 60 MB used (87 MB reserved) right after the first guided write and pinned read, before garbage collection. The parsed schema itself retains about 13 MB (measured in Node after a forced collection; workerd's inspector cannot force one). That leaves room inside the 128 MB isolate limit, which two parsed schemas plus their parse garbage would not.
- The Worker never downloads a schema at run time. A store or call set to another API version fails at once with an error naming the bundled version, instead of a 6 MB fetch from shopify.dev. The one guided write still on 2026-04, a smart-collection `ruleSet` in `shopify_create_collection` or `shopify_update_collection`, is refused on the Worker with a pointer to `shopify_run_action` (use `collectionCreate` or `collectionUpdate` with the 2026-07 `sources` input). Local and `serve` installs keep it.
- `nodejs_compat` is on. Token encryption and Shopify signatures use Web Crypto. The OS keychain is never loaded (the bundle has a stub in its place), and local-machine tools are not registered.
- Client ID Metadata Documents are fetched with plain `fetch`: HTTPS only, no redirects, 16 KB, 5 seconds, and private IP literals refused; Cloudflare's network cannot reach private addresses. The Node server additionally pins DNS.

The upload is about 2.8 MB (about 1.1 MB compressed, of which 0.7 MB is the schema), inside the Workers Free plan's 3 MB compressed size limit.

## Limits on Workers

- The MCP Apps result view (the `ui://shopify-multi-store/results` resource that renders tool results as a page in apps that support it) is read from a file on disk, so reading it fails on the Worker. Tools and their results work normally; apps that do not render MCP Apps are unaffected.
- The Workers Free plan has daily request and Durable Object limits; a team using the connector all day may need the Workers Paid plan. Check Cloudflare's current limits.
