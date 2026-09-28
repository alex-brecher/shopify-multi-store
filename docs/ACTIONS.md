# Per-user access and generic actions

Two features work together so that every person on the team can make any Shopify Admin API change from any AI app, across all stores, limited only by what that person may already do in Shopify:

1. Per-user access (hosted server). Each person signs in with their own Shopify staff account and connects each store with it. Every tool call then runs with that person's Shopify token, so Shopify enforces their staff permissions. There is no separate permission system to maintain.
2. Three generic action tools. `shopify_find_actions`, `shopify_describe_action`, and `shopify_run_action` reach every Admin API mutation (514 in API 2026-04, 523 in 2026-07), including the 483 that have no dedicated tool, without adding hundreds of tools.

## Per-user access

A hosted server (`shopify-multi-store serve`, or the Cloudflare Worker) always works this way; see [HOSTED.md](HOSTED.md).

1. A person connects the server in their AI app and signs in with Shopify: they click Sign in with Shopify (or type the name of a store they have a login for) and log in with their Shopify staff account. The server uses Shopify's authorization-code flow in online access mode (`grant_options[]=per-user`), and the verified staff email (`associated_user`, `email_verified: true`) becomes their identity.
2. The online token from that login is kept as their connection to that store. Other stores are connected the same way at `https://<host>/stores`; **Reconnect all** goes through every expired or unconnected store in a row.
3. The server stores each online token encrypted with AES-256-GCM, together with the Shopify staff account it belongs to (`associated_user`: id, email, store owner, collaborator) and the scopes that account holds (`associated_user_scope`).
4. From then on, every tool call for that store uses that person's token. Shopify limits the token to the app scopes that match the person's staff permissions (`associated_user_scope`), and a person whose staff account cannot manage, for example, orders cannot change orders through any tool. How finely Shopify maps individual staff permissions to API access is up to Shopify; test with a restricted staff account before relying on a specific permission.

What people see:

- `/stores` lists every configured store: "Connected as <Shopify email>" with the expiry, "Expired", or "Not connected", with Reconnect all, and Connect, Reconnect, and Disconnect per store.
- A tool call for a store they have not connected, or whose token expired, fails with one link, `https://<host>/stores/reconnect`, which reconnects every store. It never falls back to an app token or a static token.
- `shopify_list_stores` and every "all stores" report cover only connected stores and name the others with the reconnect link.

Notes:

- Shopify online tokens expire after 24 hours, or when the person logs out of the Shopify admin, and have no refresh token. Reconnecting is at most once a day and one click for all stores; while the person is logged in to the Shopify admin, each store reconnects without further clicks.
- Every store connection must carry the same verified Shopify email the person signed in with.
- There are no roles and no policy file: Shopify permissions are the only rule. Local stdio mode is unchanged and uses the owner's own credentials.

## The action tools

| Tool | What it does |
| --- | --- |
| `shopify_find_actions` | Keyword search over every mutation's name, input types, and description, with an optional category filter (`orders`, `fulfillment`, `inventory`, `products`, `customers`, `discounts`, `content`, `markets`, `marketing`, `checkout`, `subscriptions`, `pos`, `platform`). Returns the name, a one-line description, whether it is destructive, dedicated tools that already cover it, and a scope hint. Paged. |
| `shopify_describe_action` | One mutation in full: arguments and types, nested input fields (required markers, enum values, descriptions), payload fields, a ready-to-edit document with a default selection (ids, labels, and `userErrors { field message code }`), a template with the required variables, a scope hint, and whether `confirm` is needed. |
| `shopify_run_action` | Runs a mutation on 1 to 100 stores. Give `mutation` (the default document is built) or a full `document`, plus `variables` for every store and/or `variablesByStore` keyed by alias, because record IDs differ per store. |

`shopify_run_action` behavior:

- `dryRun` defaults to `true`. A dry run validates the document against each store's API version, checks the variables against the input types, and looks up every `gid://shopify/...` ID in the variables and in the document's inline arguments with `nodes(ids:)`, listing each record with its title, name, SKU, or email where the type has one. Nothing is changed.
- Each store's `preview` says whether it is `complete`. It is incomplete, with `reasons`, when the targets cannot all be listed in advance: a search, saved-search, filter, or `where` argument (such as `urlRedirectBulkDeleteBySearch` or `discountCodeBulkDelete` with `search`), a `*BySearch`, `*BySavedSearch`, or `*DeleteAll` mutation, an "all" flag set to `true` (such as `deleteAllAssociatedMetafields`), more than 250 IDs (only the first 250 are looked up), IDs that `nodes` does not return (listed in `unresolved`), or a failed lookup. An incomplete preview's `recommendation` is "Do not apply without narrowing". A preview only ever lists the records the document names by ID; it is not a guarantee of the full effect of a mutation.
- Applying a document whose preview is incomplete for a search, filter, "all" flag, or more than 250 IDs needs `acknowledgeIncompletePreview: true` in addition to `dryRun: false` and any `confirm`. These are checked again when applying. Applying also looks up every record ID again (in the variables and written inline, per store) with `nodes(ids:)` before sending anything; if any ID does not resolve, or the lookup fails, nothing is changed unless `acknowledgeIncompletePreview: true` is set.
- `dryRun: false` applies it. Every store is checked first; if any store fails validation, nothing runs anywhere.
- Destructive mutations (names containing delete, remove, cancel, refund, void, debit, deactivate, revoke, close, archive, disable, erasure, uninstall, destroy, merge, expire, dispose, or unpublish; the list is `DESTRUCTIVE_WORDS` in `src/actions/catalog.ts`) need `confirm` set to the mutation name. So do mutations that replace data wholesale or move money even though their names do not say so, such as `productSet`, `customerSet`, `themePublish`, `themeFilesUpsert`, `inventorySetQuantities`, `orderCapture`, and `draftOrderComplete`, and mutations that change what customers see at once, email customers, or issue value, such as `publishablePublish`, `discountCodeActivate`, `orderInvoiceSend`, `giftCardCreate`, and `storeCreditAccountCredit` (`DESTRUCTIVE_MUTATIONS` in the same file).
- Some mutations are destructive only with certain arguments, judged from the resolved values (inline literals and variables, per store): `productUpdate` or `productChangeStatus` with status `ARCHIVED` or `DRAFT`, `productVariantsBulkCreate` with strategy `REMOVE_STANDALONE_VARIANT`, and any mutation with `notifyCustomer: true`. The rules live in one table, `DESTRUCTIVE_ARGUMENT_RULES` in `src/actions/catalog.ts`; `shopify_describe_action` lists them as `destructiveWhen`.
- Queries, subscriptions, and documents with more than one operation are refused. Root fields hidden in fragments are checked too.
- A mutation is never retried or resent. If Shopify throttles it before running it, the result is `throttled`: not applied, safe to retry after the time given. If the request fails in a way where it might have applied, the result says so.
- Every top-level mutation field (each "root", named by its alias if it has one) is judged on its own. Before sending, the server adds each root payload's error lists (`userErrors` and any other `*Errors` list of objects with a `message`) under a reserved alias, `smsUserErrors_<field>`, such as `smsUserErrors_userErrors: userErrors { field message }`. Detection therefore does not depend on whether or how you selected or aliased the error list. The injected keys are removed from the returned data, and aliases starting with `smsUserErrors` are refused in your own documents.
- Each root is `applied` (a result and no user errors), `rejected` (user errors, or `ACCESS_DENIED`; Shopify normally changed nothing), or `unknown` (no result, for example a top-level error on its path). Each store's result is `applied` (every root applied), `rejected` (every root rejected), `partial` (some roots applied and others did not), `unknown` (no root is known to have applied), or `throttled` or `failed` when the request itself did not run. `roots` lists every root with its outcome, errors, and user errors.
- For `partial` and `unknown`, the result lists `applied`, `rejected`, and `unknown` roots and never suggests running the same document again, because that would repeat the roots that already applied. Retry only the rejected roots, in a new document, and read the records behind unknown roots first.
- `ACCESS_DENIED` becomes "Your Shopify account or the app lacks write_x on <store>".
- On the hosted server, every call writes an `action_run` audit line with the user, stores, mutations, a hash of the variables, and each store's outcome.

On a hosted server, and locally, `shopify_run_action` and `shopify_graphql_mutation` are available to every signed-in user, because Shopify enforces permissions, and `shopify_graphql_mutation` applies the same denylist and destructive confirm check as `shopify_run_action`: a destructive mutation needs `confirm` set to its name instead of `true`. `shopify_graphql_mutation` also injects the same error lists and reports the same per-root `outcome`, `roots`, and advice. If the schema for the store's API version cannot be loaded, or the document or variables do not validate against it, the document is sent unchanged and judged structurally, with an `outcomeNotice`: under each top-level response key, any list of objects with a `message` key counts as that root's user errors, whatever its alias. A root is `applied` only when its payload came back with an empty list under a key ending in `errors` and no errors on its path; a root with nothing to go on is `unknown`, never `applied`.

### Denylist

`shopify_run_action` refuses, by default:

- mutations that mint credentials or change this app's own installation or billing: `delegateAccessTokenCreate`, `delegateAccessTokenDestroy`, `storefrontAccessTokenCreate`, `storefrontAccessTokenDelete`, `appUninstall`, `appRevokeAccessScopes`, `appSubscription*`, `appPurchaseOneTimeCreate`, `appUsageRecordCreate`, `mobilePlatformApplication*`;
- webhook and server-pixel subscriptions (`webhookSubscriptionCreate`, `webhookSubscriptionUpdate`, `webhookSubscriptionDelete`, `pubSubWebhookSubscription*`, `eventBridgeWebhookSubscription*`, `eventBridgeServerPixelUpdate`, `pubSubServerPixelUpdate`), because they keep delivering data with the app's scopes after the caller's own token has expired;
- `bulkOperationRunMutation`, which would hide the inner mutation from the denylist and the confirm check.

`ACTIONS_DENYLIST` (comma list, `*` suffix for a prefix) adds to this list. `ACTIONS_DENYLIST_REPLACE=1` makes `ACTIONS_DENYLIST` replace it instead. `shopify_find_actions` marks denied mutations `denied`. `shopify_graphql_mutation` refuses the same mutations in every mode.

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

The dry run shows, per store, the document, the variables, and the product and variant records found for those IDs (a missing ID shows `found: false`). Send the same arguments with `"dryRun": false` to apply. For SKU-based price changes, the dedicated `shopify_update_prices` tool (with `store` or `stores`) does the ID lookup for you.

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
  "dryRun": false,
  "confirm": "giftCardCreate"
}
```

It issues money-equivalent value, so it counts as destructive and needs `confirm`. It needs `write_gift_cards`; if the app or the person lacks it, the result says so. The default selection returns `giftCardCode`, which Shopify shows only once.

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

For a hosted server, use one Shopify app (Dev Dashboard) that is installed on every store:

1. In the app's configuration (or `shopify.app.toml`), add the allowed redirect URL `https://<host>/shopify/callback`.
2. Request the full scope set. Print it with `node scripts/print-scopes.mjs --full` and paste it into the version's access scopes. Remove any scope your app is not approved for (see the comments in `src/scope-requirements.ts`: `read_all_orders`, protected customer data, and payment mandates need approval). `SHOPIFY_APP_SCOPES` changes what sign-in and `/shopify/connect` request.
3. Release the version and install or update the app on each store, approving the new scopes as the store owner.
4. Set `SHOPIFY_APP_CLIENT_ID` and `SHOPIFY_APP_CLIENT_SECRET` on the server (a `client_credentials` store's own `auth.clientId` and `SHOPIFY_CLIENT_SECRET_<ALIAS>` take precedence for that store), and `SHOPIFY_TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`).
5. Give each staff member the Shopify permissions they should have. That is the only permission setting.

## Limits

- Online tokens last at most a day. People reconnect every store with one click; tool errors link to it.
- The action catalog comes from the bundled schemas (2026-04 and 2026-07). On Node, other versions are fetched from Shopify's public schema proxy on first use. A Cloudflare Worker bundles only 2026-07 and never downloads a schema: other versions return an error.
- Scope hints come from the mutation's description or its name prefix. They are hints, not a guarantee; Shopify's `ACCESS_DENIED` message is authoritative.
- Responses are capped at 100,000 characters across stores; oversized per-store data is omitted with a notice. Select fewer fields in `document` if that happens.
