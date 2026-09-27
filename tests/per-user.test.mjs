import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decryptToken, encryptToken, parseEncryptionKey, parseEncryptionKeys, shopifyHmacMessage, verifyShopifyHmac } from "../dist/hosted/shopify-connect.js";
import { enableHostedMode } from "../dist/runtime.js";
import {
  KEY, KEYS, ORIGIN, SECRET, call, cookieNamed, login, mcpClient, pageSignIn, setup, shopifyBack, shopifyMock, signedCallback, storesSession, ts
} from "./hosted-fixture.mjs";

// Per-user Shopify access on the hosted connector. Runs in its own process.
enableHostedMode();

/** Sign in from an AI app through a store (main by default) and return the access token. */
async function signIn(app, { email = "pat@bariatricpal.com", alias = "main", token = "pat-online-main" } = {}) {
  return (await login(app, email, { alias, token })).accessToken;
}

/** The confirm page's CSRF token for a /stores session. */
async function connectCsrf(app, cookie, alias = "main", chain = false) {
  const page = await call(app, `/shopify/connect?store=${alias}${chain ? "&chain=1" : ""}`, { headers: { cookie } });
  assert.equal(page.status, 200, await page.clone().text());
  const html = await page.text();
  assert.match(page.headers.get("content-security-policy"), /form-action 'self' https:\/\/\*\.myshopify\.com/);
  return /name="csrf" value="([^"]+)"/.exec(html)[1];
}

function postConnect(app, cookie, fields, headers = {}) {
  return call(app, "/shopify/connect", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie, ...headers }, body: new URLSearchParams(fields) });
}

/** Start a Shopify connection (confirm page, then POST) and return the Shopify authorize URL. */
async function startConnect(app, cookie, alias = "main", chain = false) {
  const csrf = await connectCsrf(app, cookie, alias, chain);
  const response = await postConnect(app, cookie, { csrf, store: alias, ...(chain ? { chain: "1" } : {}) });
  assert.equal(response.status, 302, await response.clone().text());
  return new URL(response.headers.get("location"));
}

async function connectStore(app, cookie, { alias = "wholesale", shopifyEmail = "pat@bariatricpal.com", token = `online-${alias}-token` } = {}) {
  const authorize = await startConnect(app, cookie, alias);
  return shopifyBack(app, authorize, { email: shopifyEmail, token, cookie });
}

test("Shopify HMAC verification accepts a correct signature and rejects any change", async () => {
  const good = signedCallback({ code: "c", shop: "main.myshopify.com", state: "s", timestamp: ts() });
  assert.equal(await verifyShopifyHmac(good, SECRET), true);
  assert.equal(await verifyShopifyHmac(good, "other-secret"), false);
  const tampered = new URLSearchParams(good);
  tampered.set("shop", "evil.myshopify.com");
  assert.equal(await verifyShopifyHmac(tampered, SECRET), false);
  const missing = new URLSearchParams(good);
  missing.delete("hmac");
  assert.equal(await verifyShopifyHmac(missing, SECRET), false);
  const junk = new URLSearchParams(good);
  junk.set("hmac", "zz");
  assert.equal(await verifyShopifyHmac(junk, SECRET), false);
});

test("online tokens round-trip through AES-256-GCM and are bound to their user and store", async () => {
  const binding = { email: "pat@bariatricpal.com", alias: "main", shop: "main.myshopify.com" };
  const sealed = await encryptToken(KEYS[0], "shpua_secret", binding);
  assert.match(sealed, /^v2\.k1\./);
  assert.ok(!sealed.includes("shpua_secret"));
  assert.notEqual(sealed, await encryptToken(KEYS[0], "shpua_secret", binding), "random IV");
  assert.deepEqual(await decryptToken(KEYS, sealed, binding), { token: "shpua_secret", keyId: "k1" });
  await assert.rejects(decryptToken(KEYS, sealed, { ...binding, email: "other@bariatricpal.com" }));
  await assert.rejects(decryptToken(KEYS, sealed, { ...binding, alias: "wholesale" }));
  await assert.rejects(decryptToken([{ id: "k1", key: randomBytes(32) }], sealed, binding));
  await assert.rejects(decryptToken([{ id: "k2", key: KEY }], sealed, binding), /k1 is not configured/);
  // A different key id cannot be swapped in for the same key.
  await assert.rejects(decryptToken([{ id: "k2", key: KEY }], sealed.replace("v2.k1.", "v2.k2."), binding));
  assert.equal(parseEncryptionKey(KEY.toString("base64")).length, 32);
  assert.throws(() => parseEncryptionKey(undefined), /SHOPIFY_TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => parseEncryptionKey(randomBytes(16).toString("base64")), /32 random bytes/);
});

test("the /stores sign-in connects the login store, and connect stores an encrypted online token for another", async (t) => {
  await shopifyMock(t);
  const { app, store, oauth, auditPath } = await setup(t);
  const cookie = await storesSession(app, "pat@bariatricpal.com", "main", "shpua_login");
  const before = await (await call(app, "/stores", { headers: { cookie } })).text();
  assert.match(before, /signed in with Shopify as pat@bariatricpal\.com/);
  assert.match(before, /Connected as pat@bariatricpal\.com/, "the login store is connected");
  assert.match(before, /Not connected/);
  assert.match(before, /Reconnect all \(1 store\)/);
  assert.ok(!before.includes('href="/shopify/connect'), "connect is a form post, not a link");

  const authorize = await startConnect(app, cookie, "wholesale");
  assert.equal(authorize.origin, "https://wholesale.myshopify.com");
  assert.equal(authorize.pathname, "/admin/oauth/authorize");
  assert.equal(authorize.searchParams.get("client_id"), "app-client-id");
  assert.equal(authorize.searchParams.get("scope"), "write_products,write_orders");
  assert.equal(authorize.searchParams.get("redirect_uri"), `${ORIGIN}/shopify/callback`);
  assert.equal(authorize.searchParams.get("grant_options[]"), "per-user");
  assert.match(authorize.searchParams.get("state"), /^[A-Za-z0-9_-]{43}$/);

  const done = await shopifyBack(app, authorize, { token: "shpua_live", cookie });
  assert.equal(done.status, 303, await done.clone().text());
  assert.equal(done.headers.get("location"), "/stores");
  assert.equal(oauth.exchanges.length, 2);
  assert.equal(oauth.exchanges[1].url, "https://wholesale.myshopify.com/admin/oauth/access_token");
  assert.deepEqual(oauth.exchanges[1].body, { client_id: "app-client-id", client_secret: SECRET, code: "pat@bariatricpal.com|shpua_live" });

  const records = await store.entries("shopify_token");
  assert.equal(records.length, 2);
  assert.ok(!JSON.stringify(records).includes("shpua_live") && !JSON.stringify(records).includes("shpua_login"), "tokens stored only encrypted");
  const wholesale = records.find(([, record]) => record.alias === "wholesale")[1];
  assert.equal(wholesale.associatedUser.email, "pat@bariatricpal.com");
  assert.equal(wholesale.associatedUser.accountOwner, false);
  assert.equal(wholesale.associatedUserScope, "write_products");

  const after = await (await call(app, "/stores", { headers: { cookie } })).text();
  assert.ok(!/Reconnect all \(/.test(after), "nothing left to reconnect");
  const audit = await readFile(auditPath, "utf8");
  assert.match(audit, /"event":"shopify_connected"/);
  assert.ok(!audit.includes("shpua_live"));
});

test("callback state is single use, short lived, and bound to the browser session that started it", async (t) => {
  await shopifyMock(t);
  const { app, store, advance } = await setup(t);
  const cookie = await storesSession(app, "pat@bariatricpal.com");
  const other = await storesSession(app, "sam@bariatricpal.com");
  const back = (authorize, extra = {}) => shopifyBack(app, authorize, { token: "t", cookie, ...extra });

  // Replayed state.
  let authorize = await startConnect(app, cookie, "wholesale");
  assert.equal((await back(authorize)).status, 303);
  assert.equal((await back(authorize)).status, 400);
  await store.deleteMatching("shopify_token", { alias: "wholesale" });

  // State finished in another user's browser.
  authorize = await startConnect(app, cookie, "wholesale");
  assert.equal((await back(authorize, { cookie: other })).status, 400);
  // ...and it is now used up for the right browser too.
  assert.equal((await back(authorize)).status, 400);

  // No session cookie at all.
  authorize = await startConnect(app, cookie, "wholesale");
  assert.equal((await back(authorize, { cookie: undefined })).status, 400);

  // Expired state.
  authorize = await startConnect(app, cookie, "wholesale");
  advance(11 * 60_000);
  assert.equal((await back(authorize)).status, 400);

  // Bad signature, and a shop that does not match the state.
  const fresh = await storesSession(app, "pat@bariatricpal.com");
  authorize = await startConnect(app, fresh, "wholesale");
  assert.equal((await back(authorize, { cookie: fresh, secret: "wrong-secret" })).status, 400);
  assert.equal((await back(authorize, { cookie: fresh, shop: "main.myshopify.com" })).status, 400);
  assert.equal((await back(authorize, { cookie: fresh, shop: "evil.myshopify.com" })).status, 400);

  const connected = (await store.entries("shopify_token")).map(([, record]) => `${record.email}:${record.alias}`).sort();
  assert.deepEqual(connected, ["pat@bariatricpal.com:main", "sam@bariatricpal.com:main"]);
});

test("offline tokens, unverified emails, and a Shopify email other than the signed-in one are refused", async (t) => {
  await shopifyMock(t);
  const { app, store } = await setup(t);
  const cookie = await storesSession(app, "pat@bariatricpal.com");
  const refused = await connectStore(app, cookie, { shopifyEmail: "someone@else.com" });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /someone@else\.com/);
  const unverified = await shopifyBack(app, await startConnect(app, cookie, "wholesale"), { cookie, flag: "unverified" });
  assert.equal(unverified.status, 502);
  assert.match(await unverified.text(), /verified email/);
  assert.equal((await store.entries("shopify_token")).length, 1, "only the login store");
  assert.equal((await connectStore(app, cookie, { shopifyEmail: "PAT@bariatricpal.com" })).status, 303, "email match ignores case");
  assert.equal((await store.entries("shopify_token")).length, 2);

  const offline = await setup(t, {}, { offline: true });
  const { back } = await pageSignIn(offline.app);
  assert.equal(back.status, 403);
  assert.match(await back.text(), /per-user token/);
  assert.equal((await offline.store.entries("shopify_token")).length, 0);
});

test("hosted calls Shopify with the caller's own token, never a static or app token", async (t) => {
  const requests = await shopifyMock(t);
  const { app } = await setup(t);
  const client = await mcpClient(t, app, await signIn(app, { token: "pat-online-main" }));

  const info = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(info.isError, true, JSON.stringify(info));
  assert.equal(requests.at(-1).token, "pat-online-main");

  // Stores the user has not connected: an error with the one reconnect link, and no request at all.
  const count = requests.length;
  const other = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "wholesale" } });
  assert.equal(other.isError, true);
  assert.match(other.content[0].text, /not connected store "wholesale"/);
  assert.ok(other.content[0].text.includes(`${ORIGIN}/stores/reconnect`));
  assert.equal(requests.length, count);
  assert.ok(!requests.some((request) => /app-token/.test(request.token)));

  const listed = await client.callTool({ name: "shopify_list_stores", arguments: {} });
  assert.deepEqual(listed.structuredContent.stores.map((store) => store.alias), ["main"]);
  assert.deepEqual(listed.structuredContent.notConnected.map((store) => store.alias), ["wholesale"]);
  assert.ok(listed.structuredContent.hint.includes(`${ORIGIN}/stores`));
});

test("an expired token returns the one reconnect link instead of falling back to any other token", async (t) => {
  const requests = await shopifyMock(t);
  const { app, advance } = await setup(t);
  const cookie = await storesSession(app, "pat@bariatricpal.com");
  await connectStore(app, cookie);
  advance(86_400_000);
  const client = await mcpClient(t, app, await signIn(app, { alias: "wholesale", token: "fresh-wholesale" }));
  const result = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expired/);
  assert.ok(result.content[0].text.includes(`${ORIGIN}/stores/reconnect`));
  assert.equal(requests.length, 0);
  const listed = await client.callTool({ name: "shopify_list_stores", arguments: {} });
  assert.deepEqual(listed.structuredContent.stores.map((store) => store.alias), ["wholesale"]);
  assert.deepEqual(listed.structuredContent.notConnected.map((store) => [store.alias, store.status, store.connectUrl]), [["main", "expired", `${ORIGIN}/stores/reconnect`]]);
});

test("Reconnect all chains through every expired or unconnected store with no confirmation pages", async (t) => {
  await shopifyMock(t, undefined);
  const stores = [
    { alias: "main", shop: "main.myshopify.com" },
    { alias: "wholesale", shop: "wholesale.myshopify.com" },
    { alias: "outlet", shop: "outlet.myshopify.com" }
  ];
  process.env.STORES_JSON = JSON.stringify({ stores });
  const { app, store, advance } = await setup(t);
  await connectStore(app, await storesSession(app, "pat@bariatricpal.com"), { alias: "wholesale" });
  advance(86_400_000);
  // A day later every connection has expired. Signing in again reconnects the login store (main);
  // one click on the stores page then reconnects the rest.
  const cookie = await storesSession(app, "pat@bariatricpal.com");
  const page = await (await call(app, "/stores", { headers: { cookie } })).text();
  assert.match(page, /Reconnect all \(2 stores\)/);
  assert.match(page, /Expired/);
  let authorize = await startConnect(app, cookie, "wholesale", true);
  const hops = [];
  for (;;) {
    hops.push(authorize.host);
    const done = await shopifyBack(app, authorize, { cookie });
    assert.ok([302, 303].includes(done.status), await done.clone().text());
    if (done.status === 303) {
      assert.equal(done.headers.get("location"), "/stores");
      break;
    }
    // Each hop goes straight to the next store's Shopify authorization, not to a confirm page.
    authorize = new URL(done.headers.get("location"));
    assert.equal(authorize.pathname, "/admin/oauth/authorize");
  }
  assert.deepEqual(hops, ["wholesale.myshopify.com", "outlet.myshopify.com"]);
  const live = (await store.entries("shopify_token")).filter(([, record]) => record.email === "pat@bariatricpal.com" && record.expiresAt > Date.now() + 86_400_000);
  assert.equal(live.length, 3);
});

test("/stores/reconnect signs in with Shopify and then reconnects every other store, or shows the stores page when signed in", async (t) => {
  await shopifyMock(t);
  const { app, store } = await setup(t);
  // Signed out: the link starts a sign-in; after Shopify login on main, it goes straight on to wholesale.
  const { back, session } = await pageSignIn(app, { path: "/stores/reconnect", alias: "main" });
  assert.equal(back.status, 302, await back.clone().text());
  assert.ok(session, "the /stores session is set on the way");
  const next = new URL(back.headers.get("location"));
  assert.equal(next.host, "wholesale.myshopify.com");
  const done = await shopifyBack(app, next, { cookie: session });
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), "/stores");
  assert.equal((await store.entries("shopify_token")).length, 2);
  // Signed in: the same link lands on the stores page.
  const again = await call(app, "/stores/reconnect", { headers: { cookie: session } });
  assert.equal(again.status, 303);
  assert.equal(again.headers.get("location"), "/stores");
  assert.equal((await call(app, "/stores/reconnect", { method: "POST" })).status, 405);
});

test("shopify_run_action runs with the user's own token and is audited", async (t) => {
  const requests = await shopifyMock(t);
  const { app, auditPath } = await setup(t);
  const client = await mcpClient(t, app, await signIn(app, { token: "pat-online-main" }));
  const { tools } = await client.listTools();
  for (const name of ["shopify_find_actions", "shopify_describe_action", "shopify_run_action"]) assert.ok(tools.some((tool) => tool.name === name), name);

  const variables = { id: "gid://shopify/Product/1", tags: ["sale"] };
  const applied = await client.callTool({ name: "shopify_run_action", arguments: { stores: ["main"], mutation: "tagsAdd", variables, dryRun: false } });
  assert.notEqual(applied.isError, true, JSON.stringify(applied));
  assert.ok(requests.length > 0 && requests.every((request) => request.token === "pat-online-main"));

  const unconnected = await client.callTool({ name: "shopify_run_action", arguments: { stores: ["main", "wholesale"], mutation: "tagsAdd", variables, dryRun: false } });
  assert.equal(unconnected.isError, true);
  assert.ok(unconnected.content[0].text.includes(`${ORIGIN}/stores/reconnect`));
  assert.ok(!requests.some((request) => /app-token/.test(request.token)));

  const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const runs = lines.filter((line) => line.event === "action_run");
  assert.equal(runs.length, 2);
  assert.equal(runs[0].user, "pat@bariatricpal.com");
  assert.deepEqual(runs[0].mutations, ["tagsAdd"]);
  assert.deepEqual(runs[0].stores, ["main"]);
  assert.equal(runs[0].dryRun, false);
  assert.match(runs[0].variablesSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(runs[0].outcome, [{ store: "main", ok: true, shopifyEmail: "pat@bariatricpal.com" }]);
  assert.equal(runs[1].outcome.find((entry) => entry.store === "wholesale").ok, false);
  assert.equal(runs[1].outcome.find((entry) => entry.store === "wholesale").shopifyEmail, undefined);
  const call = lines.find((line) => line.tool === "shopify_run_action");
  assert.deepEqual(call.shopifyAccounts, { main: "pat@bariatricpal.com" });
});

test("action_run audit lines hold no PII when customerCreate fails preflight with customer data in its input", async (t) => {
  const requests = await shopifyMock(t);
  const { app, auditPath } = await setup(t);
  const client = await mcpClient(t, app, await signIn(app, { token: "pat-online-main" }));
  const pii = ["jane.doe@example.com", "+15550100199", "Janet", "Samplesworth", "12 Elm Street", "Springfield", "90210"];
  // notAField makes variable coercion fail; GraphQL's error message quotes the whole input back.
  const variables = { input: { email: pii[0], phone: pii[1], firstName: pii[2], lastName: pii[3], addresses: [{ address1: pii[4], city: pii[5], zip: pii[6] }], notAField: pii[2] } };
  for (const dryRun of [false, true]) {
    const result = await client.callTool({ name: "shopify_run_action", arguments: { stores: ["main"], mutation: "customerCreate", variables, dryRun } });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.ok(result.content[0].text.includes(pii[0]), "the caller still sees the coercion error in full");
  }
  assert.equal(requests.length, 0, "nothing reached Shopify");

  const raw = await readFile(auditPath, "utf8");
  for (const value of pii) assert.ok(!raw.includes(value), `audit log contains ${value}`);
  assert.ok(!raw.includes("got invalid value"), "no error text in the audit log");
  const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
  const runs = lines.filter((line) => line.event === "action_run");
  assert.equal(runs.length, 2);
  const [applyRun, dryRunRun] = runs;
  assert.equal(applyRun.outcome[0].ok, false);
  assert.equal(applyRun.outcome[0].error.class, "preflight");
  assert.match(applyRun.outcome[0].error.messageSha256, /^[0-9a-f]{64}$/);
  assert.equal(dryRunRun.outcome[0].error.class, "dry_run_problems");
  const calls = lines.filter((line) => line.tool === "shopify_run_action");
  assert.equal(calls.length, 2);
  for (const entry of calls) assert.equal(typeof entry.error.class, "string");
});

test("the raw mutation tool honors the action denylist on a hosted server", async (t) => {
  const requests = await shopifyMock(t);
  const { app } = await setup(t);
  const client = await mcpClient(t, app, await signIn(app));
  const mutation = "mutation { ...F } fragment F on Mutation { delegateAccessTokenCreate(input: { delegateAccessScope: [\"write_products\"] }) { delegateAccessToken { accessToken } } }";
  const refused = await client.callTool({ name: "shopify_graphql_mutation", arguments: { store: "main", mutation, variables: {}, confirm: true } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /denylist/);
  assert.equal(requests.length, 0);
});

test("the raw mutation tool applies run_action's destructive confirm check on a hosted server", async (t) => {
  const requests = await shopifyMock(t);
  const { app } = await setup(t);
  const client = await mcpClient(t, app, await signIn(app));
  const mutation = "mutation Del($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { field message } } }";
  const args = { store: "main", mutation, variables: { input: { id: "gid://shopify/Product/1" } } };
  const plain = await client.callTool({ name: "shopify_graphql_mutation", arguments: { ...args, confirm: true } });
  assert.equal(plain.isError, true);
  assert.match(plain.content[0].text, /productDelete is destructive.*confirm: "productDelete"/);
  const wrong = await client.callTool({ name: "shopify_graphql_mutation", arguments: { ...args, confirm: "yes" } });
  assert.equal(wrong.isError, true);
  assert.equal(requests.length, 0);
  const named = await client.callTool({ name: "shopify_graphql_mutation", arguments: { ...args, confirm: "productDelete" } });
  assert.notEqual(named.isError, true, JSON.stringify(named));
  assert.equal(requests.length, 1);
  // Non-destructive mutations still take confirm: true.
  const update = await client.callTool({ name: "shopify_graphql_mutation", arguments: { store: "main", mutation: "mutation { productUpdate(product: {id: \"gid://shopify/Product/1\"}) { userErrors { message } } }", variables: {}, confirm: true } });
  assert.notEqual(update.isError, true, JSON.stringify(update));
});

test("Shopify HMAC escapes names and values, formats array parameters, and rejects stale timestamps", async () => {
  const params = new URLSearchParams();
  params.append("shop", "main.myshopify.com");
  params.append("note", "a&b%c=d");
  params.append("we=ird", "x");
  params.append("ids[]", "1");
  params.append("ids[]", "2");
  params.append("timestamp", ts());
  const message = shopifyHmacMessage(params);
  assert.equal(message, `ids=["1", "2"]&note=a%26b%25c=d&shop=main.myshopify.com&timestamp=${params.get("timestamp")}&we%3Dird=x`);
  params.set("hmac", createHmac("sha256", SECRET).update(message).digest("hex"));
  assert.equal(await verifyShopifyHmac(params, SECRET, Date.now()), true);
  const repeated = new URLSearchParams(params);
  repeated.append("shop", "evil.myshopify.com");
  assert.equal(await verifyShopifyHmac(repeated, SECRET), false);

  const stale = signedCallback({ code: "c", shop: "main.myshopify.com", state: "s", timestamp: ts(-301) });
  assert.equal(await verifyShopifyHmac(stale, SECRET), true, "signature itself is fine");
  assert.equal(await verifyShopifyHmac(stale, SECRET, Date.now()), false);
  assert.equal(await verifyShopifyHmac(signedCallback({ code: "c", shop: "main.myshopify.com", state: "s", timestamp: ts(-200) }), SECRET, Date.now()), true);
  assert.equal(await verifyShopifyHmac(signedCallback({ code: "c", shop: "main.myshopify.com", state: "s", timestamp: ts(400) }), SECRET, Date.now()), false);
});

test("a stale Shopify callback is refused even with a valid state", async (t) => {
  await shopifyMock(t);
  const { app, store } = await setup(t);
  const cookie = await storesSession(app, "pat@bariatricpal.com");
  const authorize = await startConnect(app, cookie, "wholesale");
  assert.equal((await shopifyBack(app, authorize, { cookie, timestamp: ts(-600) })).status, 400);
  assert.equal((await store.entries("shopify_token")).length, 1, "only the login store");
});

test("/shopify/connect starts Shopify only from a same-origin POST with the CSRF token", async (t) => {
  await shopifyMock(t);
  const { app, store } = await setup(t);
  const cookie = await storesSession(app, "pat@bariatricpal.com");
  const page = await call(app, "/shopify/connect?store=main", { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Continue to Shopify/);
  assert.equal((await store.entries("shopify_state")).length, 0, "GET creates no state");
  const csrf = await connectCsrf(app, cookie);
  assert.equal((await postConnect(app, cookie, { store: "main" })).status, 403);
  assert.equal((await postConnect(app, cookie, { csrf: "forged", store: "main" })).status, 403);
  assert.equal((await postConnect(app, cookie, { csrf, store: "main" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await postConnect(app, "__Host-sms_stores=forged", { csrf, store: "main" })).status, 401);
  assert.equal((await store.entries("shopify_state")).length, 0);
  assert.equal((await postConnect(app, cookie, { csrf, store: "main" })).status, 302);
  assert.equal((await store.entries("shopify_state")).length, 1);
});

test("SHOPIFY_TOKEN_ENCRYPTION_KEYS rotates keys: the first encrypts, all decrypt, and old tokens are re-encrypted on use", async (t) => {
  const oldKey = { id: "old", key: randomBytes(32) };
  const newKey = { id: "new", key: randomBytes(32) };
  assert.deepEqual(parseEncryptionKeys({ SHOPIFY_TOKEN_ENCRYPTION_KEYS: `new:${newKey.key.toString("base64")}, old:${oldKey.key.toString("base64url")}` }), [newKey, oldKey]);
  assert.deepEqual(parseEncryptionKeys({ SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY.toString("base64") }), [{ id: "default", key: KEY }]);
  assert.throws(() => parseEncryptionKeys({}), /SHOPIFY_TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => parseEncryptionKeys({ SHOPIFY_TOKEN_ENCRYPTION_KEYS: KEY.toString("base64") }), /id:base64key/);
  assert.throws(() => parseEncryptionKeys({ SHOPIFY_TOKEN_ENCRYPTION_KEYS: `a:${KEY.toString("base64")},a:${KEY.toString("base64")}` }), /repeats/);

  const requests = await shopifyMock(t);
  const first = await setup(t, { encryptionKeys: [oldKey] });
  await storesSession(first.app, "pat@bariatricpal.com", "main", "pat-online-main");
  const [[key, record]] = await first.store.entries("shopify_token");
  assert.match(record.encryptedToken, /^v2\.old\./);

  // Same data, new key first: still works, and the record is re-encrypted with the new key.
  // Sign in through wholesale so the main token stays the one written under the old key.
  const rotated = await setup(t, { store: first.store, encryptionKeys: [newKey, oldKey] });
  let result = await (await mcpClient(t, rotated.app, await signIn(rotated.app, { alias: "wholesale", token: "pat-online-wholesale" }))).callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(requests.at(-1).token, "pat-online-main");
  assert.match((await first.store.get("shopify_token", key)).encryptedToken, /^v2\.new\./);

  // The old key can now be dropped.
  const retired = await setup(t, { store: first.store, encryptionKeys: [newKey] });
  result = await (await mcpClient(t, retired.app, await signIn(retired.app, { alias: "wholesale", token: "pat-online-wholesale" }))).callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
});

test("a Shopify callback forwarded to another browser cannot give it the attacker's /stores session or store a token", async (t) => {
  await shopifyMock(t);
  const { app, store } = await setup(t);
  // Attacker starts a /stores sign-in and logs in to Shopify as themselves, but does not open the callback.
  const start = await call(app, "/stores");
  const html = await start.clone().text();
  const state = /name="state" value="([^"]+)"/.exec(html)[1];
  const cookie = cookieNamed(start, "__Host-sms_login_");
  const chosen = await call(app, "/login/shopify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie }, body: new URLSearchParams({ state, store: "main" }) });
  const authorize = new URL(chosen.headers.get("location"));
  // Victim opens the forwarded callback: no binding cookie, so no session and no token.
  const victim = await shopifyBack(app, authorize, { email: "mallory@bariatricpal.com" });
  assert.equal(victim.status, 403, await victim.clone().text());
  assert.equal(cookieNamed(victim, "__Host-sms_stores="), undefined);
  assert.equal((await store.entries("shopify_token")).length, 0);
  // Without a session the victim cannot start a Shopify connection at all: it starts a sign-in instead.
  const connect = await call(app, "/shopify/connect?store=main");
  assert.equal(connect.status, 200);
  assert.match(await connect.text(), /Sign in with your Shopify staff account/);
  // The attacker's own browser (with its binding cookie) still completes normally, proving the state was not consumed by the refusal.
  const own = await shopifyBack(app, authorize, { email: "mallory@bariatricpal.com", cookie });
  assert.equal(own.status, 303);
});

test("store tokens are decrypted lazily: none for tools/list, only the store a call uses", async (t) => {
  await shopifyMock(t);
  const { app, store } = await setup(t);
  const accessToken = await signIn(app);
  const cookie = await storesSession(app, "pat@bariatricpal.com");
  assert.equal((await connectStore(app, cookie)).status, 303);
  let reads = 0;
  const get = store.get.bind(store);
  store.get = async (kind, key) => { if (kind === "shopify_token") reads += 1; return get(kind, key); };
  const subtle = globalThis.crypto.subtle;
  const decrypt = subtle.decrypt;
  let decrypts = 0;
  subtle.decrypt = function (...args) { decrypts += 1; return decrypt.apply(this, args); };
  t.after(() => { subtle.decrypt = decrypt; });

  const client = await mcpClient(t, app, accessToken);
  assert.ok((await client.listTools()).tools.length > 0);
  assert.equal(reads, 0, "tools/list reads no Shopify token record");
  assert.equal(decrypts, 0, "tools/list decrypts nothing");
  const info = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(info.isError, true, JSON.stringify(info));
  assert.equal(decrypts, 1, "one store used, one token decrypted");
  assert.equal(reads, 2, "the call reads each store's record once (metadata)");

  // A token that cannot be decrypted affects only its own store, and reads as not connected.
  const [key, record] = (await store.entries("shopify_token")).find(([, value]) => value.alias === "wholesale");
  await store.put("shopify_token", key, { ...record, encryptedToken: record.encryptedToken.slice(0, -4) + "AAAA" }, record.expiresAt + 60_000);
  assert.notEqual((await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } })).isError, true);
  const broken = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "wholesale" } });
  assert.equal(broken.isError, true);
  assert.match(JSON.stringify(broken.content), /not connected store "wholesale"|Connect it at/);
});
