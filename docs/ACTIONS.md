# Per-user access and generic actions

Two features work together so that every person on the team can make any Shopify Admin API change from any AI app, across all stores, limited only by what that person may already do in Shopify:

1. Per-user access (hosted server). Each person connects each store with their own Shopify staff account. Every tool call then runs with that person's Shopify token, so Shopify enforces their staff permissions. There is no separate permission system to maintain.
2. Three generic action tools. `shopify_find_actions`, `shopify_describe_action`, and `shopify_run_action` reach every Admin API mutation (514 in API 2026-04, 523 in 2026-07), including the 483 that have no dedicated tool, without adding hundreds of tools.

## Per-user access

`SHOPIFY_ACCESS_MODE=per_user` is the default for `shopify-multi-store serve`.

1. A person signs in to the AI app with Google, as before.
2. They open `https://<host>/stores`, sign in with Google, and click Connect (or "Connect all") for each store.
3. Shopify asks them to log in with their Shopify staff account and approve the app. The server uses Shopify's authorization-code flow in online access mode (`grant_options[]=per-user`).
4. The server stores the resulting online token, encrypted with AES-256-GCM, together with the Shopify staff account it belongs to (`associated_user`: id, email, store owner, collaborator) and the scopes that account holds (`associated_user_scope`).
5. From then on, every tool call for that store uses that person's token. Shopify limits the token to the app scopes that match the person's staff permissions (`associated_user_scope`), and a person whose staff account cannot manage, for example, orders cannot change orders through any tool. How finely Shopify maps individual staff permissions to API access is up to Shopify; test with a restricted staff account before relying on a specific permission.

What people see:

- `/stores` lists every store they may use: "Connected as <Shopify email>" with the expiry, "Expired", or "Not connected", with Connect, Reconnect, and Disconnect.
- A tool call for a store they have not connected, or whose token expired, fails with the exact URL to fix it, for example `https://<host>/shopify/connect?store=netrition`. It never falls back to the app token.
- `shopify_list_stores` and every "all stores" report cover only connected stores and name the others with the `/stores` link.

Notes:

- Shopify online tokens expire after about 24 hours and have no refresh token. Reconnecting is one click per store while the person is logged in to Shopify admin, and "Connect all" walks through every unconnected store in a row.
- `SHOPIFY_REQUIRE_EMAIL_MATCH=1` refuses a connection when the Shopify staff email differs from the Google email. Both emails are always recorded in the audit log and shown on `/stores`.
- The policy file is optional in per-user mode. Without it, anyone from `ALLOWED_EMAIL_DOMAINS` may sign in and Shopify decides the rest. With it, it still limits stores and roles (a `viewer` stays read-only).
- Personal access tokens (`/tokens`) are long-lived, so in per-user mode they cannot use Shopify unless `PERSONAL_TOKENS_SHOPIFY_ACCESS=1`, which also caps new personal tokens at 30 days.
- `SHOPIFY_ACCESS_MODE=app` keeps the previous behavior: one app token per store, and the policy file is required. Local stdio mode is unchanged and always uses the owner's app token.

## The action tools

| Tool | What it does |
| --- | --- |
| `shopify_find_actions` | Keyword search over every mutation's name, input types, and description, with an optional category filter (`orders`, `fulfillment`, `inventory`, `products`, `customers`, `discounts`, `content`, `markets`, `marketing`, `checkout`, `subscriptions`, `pos`, `platform`). Returns the name, a one-line description, whether it is destructive, dedicated tools that already cover it, and a scope hint. Paged. |
| `shopify_describe_action` | One mutation in full: arguments and types, nested input fields (required markers, enum values, descriptions), payload fields, a ready-to-edit document with a default selection (ids, labels, and `userErrors { field message code }`), a template with the required variables, a scope hint, and whether `confirm` is needed. |
| `shopify_run_action` | Runs a mutation on 1 to 100 stores. Give `mutation` (the default document is built) or a full `document`, plus `variables` for every store and/or `variablesByStore` keyed by alias, because record IDs differ per store. |

`shopify_run_action` behavior:

- `dryRun` defaults to `true`. A dry run validates the document against each store's API version, checks the variables against the input types, and looks up every `gid://shopify/...` ID in the variables with `nodes(ids:)`, so the preview lists exactly which records (with title, name, SKU, or email where the type has one) would be touched. Nothing is changed.
- `dryRun: false` applies it. Every store is checked first; if any store fails validation, nothing runs anywhere.
- Destructive mutations (names containing delete, remove, cancel, refund, void, debit, deactivate, revoke, close, archive, disable, erasure, uninstall, destroy, merge, expire, dispose, or unpublish; the list is `DESTRUCTIVE_WORDS` in `src/actions/catalog.ts`) need `confirm` set to the mutation name. So do mutations that replace data wholesale or move money even though their names do not say so, such as `productSet`, `customerSet`, `themePublish`, `themeFilesUpsert`, `inventorySetQuantities`, `orderCapture`, and `draftOrderComplete` (`DESTRUCTIVE_MUTATIONS` in the same file).
- Queries, subscriptions, and documents with more than one operation are refused. Root fields hidden in fragments are checked too.
- A mutation is never retried. If the request fails in a way where it might have applied, the result says so. (Only a request Shopify throttled before running it is waited out and sent again.)
- Each store's result is `applied`, `rejected` (Shopify returned user errors), `partial`, `failed`, or `unknown`. `ACCESS_DENIED` becomes "Your Shopify account or the app lacks write_x on <store>".
- On the hosted server, every call writes an `action_run` audit line with the user, stores, mutations, a hash of the variables, and each store's outcome.

In app mode, `shopify_run_action` and `shopify_graphql_mutation` are admin-only. In per-user mode they are available to every signed-in user who is not a `viewer`, because Shopify enforces permissions. In per-user mode `shopify_graphql_mutation` applies the same denylist and destructive confirm check as `shopify_run_action`: a destructive mutation needs `confirm` set to its name instead of `true`.

### Denylist

`shopify_run_action` refuses, by default:

- mutations that mint credentials or change this app's own installation or billing: `delegateAccessTokenCreate`, `delegateAccessTokenDestroy`, `storefrontAccessTokenCreate`, `storefrontAccessTokenDelete`, `appUninstall`, `appRevokeAccessScopes`, `appSubscription*`, `appPurchaseOneTimeCreate`, `appUsageRecordCreate`, `mobilePlatformApplication*`;
- webhook and server-pixel subscriptions (`webhookSubscriptionCreate`, `webhookSubscriptionUpdate`, `webhookSubscriptionDelete`, `pubSubWebhookSubscription*`, `eventBridgeWebhookSubscription*`, `eventBridgeServerPixelUpdate`, `pubSubServerPixelUpdate`), because they keep delivering data with the app's scopes after the caller's own token has expired;
- `bulkOperationRunMutation`, which would hide the inner mutation from the denylist and the confirm check.

`ACTIONS_DENYLIST` (comma list, `*` suffix for a prefix) adds to this list. `ACTIONS_DENYLIST_REPLACE=1` makes `ACTIONS_DENYLIST` replace it instead. `shopify_find_actions` marks denied mutations `denied`. On a hosted server, `shopify_graphql_mutation` refuses the same mutations.

## Worked examples

### 1. Change a price in two stores

The same product has different IDs in each store, so use `variablesByStore`.

```json
{
  "stores": ["bariatricpal", "netrition"],
  "mutation": "productVariantsBulkUpdate",
  "variablesByStore": {
    "bariatricpal": { "productId": "gid://shopify/Product/7001", "variants": [{ "id": "gid://shopify/ProductVariant/4101", "price": "24.99" }] },
    "netrition": { "productId": "gid://shopify/Product/8802", "variants": [{ "id": "gid://shopify/ProductVariant/5202", "price": "24.99" }] }
  }
}
```

The dry run shows, per store, the document, the variables, and the product and variant records found for those IDs (a missing ID shows `found: false`). Send the same arguments with `"dryRun": false` to apply. For SKU-based price changes, the dedicated `shopify_update_prices_many` tool does the ID lookup for you.

### 2. Cancel an order

```json
{
  "stores": ["bariatricpal"],
  "mutation": "orderCancel",
  "variables": {
    "orderId": "gid://shopify/Order/5550001",
    "reason": "CUSTOMER",
    "restock": true,
    "notifyCustomer": true,
    "refundMethod": { "originalPaymentMethodsRefund": true }
  }
}
```

The dry run reports `confirmRequired: "orderCancel"`. Apply with `"dryRun": false, "confirm": "orderCancel"`. Without the exact confirm the call is refused before anything reaches Shopify. Shopify returns this mutation's errors in `orderCancelUserErrors`, which the default document selects.

### 3. Create a gift card

```json
{
  "stores": ["netrition"],
  "mutation": "giftCardCreate",
  "variables": { "input": { "initialValue": "25.00", "note": "Service recovery", "customerId": "gid://shopify/Customer/901" } },
  "dryRun": false
}
```

Not destructive, so no confirm. It needs `write_gift_cards`; if the app or the person lacks it, the result says so. The default selection returns `giftCardCode`, which Shopify shows only once.

## What no third-party app can do

These fail for any app, whatever the scopes or the person's permissions. Expect `ACCESS_DENIED` or user errors:

- Subscription contracts owned by another app. `write_own_subscription_contracts` covers only contracts this app created, and needs Shopify's approval.
- Creating or changing customer payment methods (`customerPaymentMethod*`). Payment mandates need Shopify's approval for a specific use case.
- POS device and cash sessions (`pointOfSaleDevicePaymentSession*`, cash drawers). These belong to Shopify POS hardware.
- App billing and app installation changes for any app (and this app's own ones are on the denylist).
- Shopify Functions settings (`paymentCustomizationCreate`, `deliveryCustomizationCreate`, `cartTransformCreate`, `validationCreate`, `discountCodeAppCreate`, `discountAutomaticAppCreate`, `fulfillmentConstraintRuleCreate`) that point at a function from another app. The function must belong to the calling app.
- Fulfillment services, carrier services, marketing activities, Flow triggers, and webhook subscriptions that belong to another app. This app can only manage its own.
- Sales-channel operations (`channel*`, `productFeed*`, `productFullSync`) and tax-partner operations (`taxAppConfigure`), which need a sales-channel or tax-partner app.
- Plan-gated features: checkout branding needs Shopify Plus; `read_users` needs Plus or Advanced.
- Orders older than 60 days need `read_all_orders`, and customer names, emails, phones, and addresses need protected customer data access. Both are Shopify approvals in the Partner or Dev Dashboard.

## Shopify Admin setup

For per-user mode, use one Shopify app (Dev Dashboard) that is installed on every store:

1. In the app's configuration (or `shopify.app.toml`), add the allowed redirect URL `https://<host>/shopify/callback`.
2. Request the full scope set. Print it with `node scripts/print-scopes.mjs --full` and paste it into the version's access scopes. Remove any scope your app is not approved for (see the comments in `src/scope-requirements.ts`: `read_all_orders`, protected customer data, and payment mandates need approval). `SHOPIFY_APP_SCOPES` changes what `/shopify/connect` requests.
3. Release the version and install or update the app on each store, approving the new scopes as the store owner.
4. Set `SHOPIFY_APP_CLIENT_ID` and `SHOPIFY_APP_CLIENT_SECRET` on the server (a `client_credentials` store's own `auth.clientId` and `SHOPIFY_CLIENT_SECRET_<ALIAS>` take precedence for that store), and `SHOPIFY_TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`).
5. Give each staff member the Shopify permissions they should have. That is the only permission setting.

## Limits

- Online tokens last about a day. People reconnect on `/stores`; tool errors link there.
- The action catalog comes from the bundled schemas (2026-04 and 2026-07). Other versions are fetched from Shopify's public schema proxy on first use.
- Scope hints come from the mutation's description or its name prefix. They are hints, not a guarantee; Shopify's `ACCESS_DENIED` message is authoritative.
- Responses are capped at 100,000 characters across stores; oversized per-store data is omitted with a notice. Select fewer fields in `document` if that happens.
